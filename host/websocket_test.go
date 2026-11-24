package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

// frame builds a client frame (masked, as RFC 6455 requires of clients).
func frame(fin bool, opcode byte, payload []byte, masked bool) []byte {
	first := opcode
	if fin {
		first |= 0x80
	}
	out := []byte{first}
	maskBit := byte(0)
	if masked {
		maskBit = 0x80
	}
	switch n := len(payload); {
	case n < 126:
		out = append(out, maskBit|byte(n))
	case n <= 0xFFFF:
		out = append(out, maskBit|126)
		out = binary.BigEndian.AppendUint16(out, uint16(n))
	default:
		out = append(out, maskBit|127)
		out = binary.BigEndian.AppendUint64(out, uint64(n))
	}
	if !masked {
		return append(out, payload...)
	}
	key := []byte{1, 2, 3, 4}
	out = append(out, key...)
	for i, b := range payload {
		out = append(out, b^key[i%4])
	}
	return out
}

// pipeConn returns a server-side wsConn fed with input, and a function that
// waits for the connection to end and returns what the server wrote.
func pipeConn(t *testing.T, input []byte) (*wsConn, func() []byte) {
	t.Helper()
	server, client := net.Pipe()
	written := &bytes.Buffer{}
	done := make(chan struct{})
	go func() { _, _ = io.Copy(written, client); close(done) }()
	go func() { _, _ = client.Write(input) }()
	t.Cleanup(func() { _ = server.Close(); _ = client.Close(); <-done })
	output := func() []byte { _ = server.Close(); <-done; return written.Bytes() }
	return newWSConn(server, bufio.NewReader(server), 64), output
}

func read(t *testing.T, c *wsConn) (byte, []byte, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return c.Read(ctx)
}

func TestWebSocketReadsMessagesAndControlFrames(t *testing.T) {
	input := append(frame(false, opText, []byte("hel"), true), frame(true, opPing, []byte("p"), true)...)
	input = append(input, frame(true, opContinuation, []byte("lo"), true)...)
	c, _ := pipeConn(t, input)
	kind, data, err := read(t, c)
	if err != nil || kind != opText || string(data) != "hello" {
		t.Fatalf("got %d %q %v", kind, data, err)
	}
}

func TestWebSocketRejectsProtocolViolations(t *testing.T) {
	cases := map[string][]byte{
		"unmasked":             frame(true, opText, []byte("x"), false),
		"too big":              frame(true, opText, bytes.Repeat([]byte("x"), 65), true),
		"fragmented control":   frame(false, opPing, nil, true),
		"stray continuation":   frame(true, opContinuation, []byte("x"), true),
		"invalid UTF-8":        frame(true, opText, []byte{0xff, 0xfe}, true),
		"reserved bits":        {0xC1, 0x80, 1, 2, 3, 4},
		"unknown opcode":       frame(true, 0x3, nil, true),
		"64-bit length lie":    append([]byte{0x81, 0x80 | 127}, binary.BigEndian.AppendUint64(nil, 1<<40)...),
		"new message mid-text": append(frame(false, opText, []byte("a"), true), frame(true, opText, []byte("b"), true)...),
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			c, _ := pipeConn(t, input)
			if _, _, err := read(t, c); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestWebSocketAnswersCloseAndPings(t *testing.T) {
	c, output := pipeConn(t, append(frame(true, opPing, []byte("hi"), true), frame(true, opClose, []byte{0x03, 0xE8}, true)...))
	if _, _, err := read(t, c); !errors.Is(err, errClosed) {
		t.Fatalf("close: %v", err)
	}
	got := output()
	if !bytes.HasPrefix(got, []byte{0x8A, 2, 'h', 'i'}) || !bytes.Contains(got, []byte{0x88, 2, 0x03, 0xE8}) {
		t.Fatalf("expected a pong then a close reply, wrote % x", got)
	}
}

// After a room closes a seat it reads again to receive the peer's close reply;
// a second buffered close frame must end that read, not crash the host.
func TestWebSocketReadsRepeatedCloseFrames(t *testing.T) {
	closing := frame(true, opClose, []byte{0x03, 0xE8}, true)
	c, _ := pipeConn(t, append(append([]byte{}, closing...), closing...))
	for i := 0; i < 2; i++ {
		if _, _, err := read(t, c); err == nil {
			t.Fatalf("read %d accepted a close frame", i)
		}
	}
}

func FuzzWebSocketRead(f *testing.F) {
	f.Add(frame(true, opText, []byte(`{"type":"resync"}`), true))
	f.Add(frame(false, opBinary, []byte{1}, true))
	f.Fuzz(func(t *testing.T, input []byte) {
		server, client := net.Pipe()
		go func() { _, _ = io.Copy(io.Discard, client) }()
		go func() { _, _ = client.Write(input); _ = client.Close() }()
		c := newWSConn(server, bufio.NewReader(server), 64)
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		for i := 0; i < 8; i++ {
			kind, data, err := c.Read(ctx)
			if err != nil {
				break
			}
			if len(data) > 64 || (kind != opText && kind != opBinary) {
				t.Fatalf("read %d bytes of kind %d past the limits", len(data), kind)
			}
		}
		_ = server.Close()
	})
}
