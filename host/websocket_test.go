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
	"unicode/utf8"
)

// frame builds a client frame (masked, as RFC 6455 requires of clients).
func frame(fin bool, opcode byte, payload []byte, masked bool) []byte {
	if masked {
		return maskedFrame(fin, opcode, payload, 0x01020304)
	}
	return append(frameHead(fin, opcode, payload, 0), payload...)
}

// frameHead is a frame's first bytes, up to its mask.
func frameHead(fin bool, opcode byte, payload []byte, maskBit byte) []byte {
	first := opcode
	if fin {
		first |= 0x80
	}
	switch n := len(payload); {
	case n < 126:
		return []byte{first, maskBit | byte(n)}
	case n <= 0xFFFF:
		return binary.BigEndian.AppendUint16([]byte{first, maskBit | 126}, uint16(n))
	default:
		return binary.BigEndian.AppendUint64([]byte{first, maskBit | 127}, uint64(n))
	}
}

// maskedFrame is a client frame masked with key.
func maskedFrame(fin bool, opcode byte, payload []byte, key uint32) []byte {
	out := binary.BigEndian.AppendUint32(frameHead(fin, opcode, payload, 0x80), key)
	mask := out[len(out)-4:]
	for i, b := range payload {
		out = append(out, b^mask[i%4])
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
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
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
	for i := range 2 {
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
		ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
		defer cancel()
		for range 8 {
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

// A message a client sends, in one frame or two with a ping between them,
// reads back as it was sent, within the read limit and, as text, UTF-8; the
// ping is answered with a pong of its bytes.
func FuzzWebSocketMessage(f *testing.F) {
	f.Add([]byte(`{"type":"resync"}`), false, 0, uint32(0x01020304), []byte("p"))
	f.Add([]byte{0, 1, 2, 0xff}, true, 2, uint32(0), []byte{})
	f.Add([]byte("h\xc3\xa9llo"), false, 2, uint32(0xdeadbeef), []byte("ping")) // é cut between its bytes
	f.Add([]byte("\xff"), false, 0, uint32(7), []byte(nil))
	f.Add(bytes.Repeat([]byte("x"), 65), true, 30, uint32(1), []byte("p"))
	f.Fuzz(func(t *testing.T, message []byte, binary bool, cut int, key uint32, ping []byte) {
		if len(ping) > 125 {
			ping = ping[:125]
		}
		kind := byte(opText)
		if binary {
			kind = opBinary
		}
		var input []byte
		if cut > 0 && cut < len(message) {
			input = maskedFrame(false, kind, message[:cut], key)
			input = append(input, maskedFrame(true, opPing, ping, ^key)...)
			input = append(input, maskedFrame(true, opContinuation, message[cut:], key>>3)...)
		} else {
			input = maskedFrame(true, kind, message, key)
		}
		c, output := pipeConn(t, input)
		got, data, err := read(t, c)
		if len(message) > 64 || (!binary && !utf8.Valid(message)) {
			if err == nil {
				t.Fatalf("%d bytes (binary %v) were read past the limits", len(message), binary)
			}
			return
		}
		if err != nil || got != kind || !bytes.Equal(data, message) {
			t.Fatalf("%q (binary %v) read back as %q of kind %d: %v", message, binary, data, got, err)
		}
		if cut > 0 && cut < len(message) {
			if pong := frame(true, opPong, ping, false); !bytes.HasPrefix(output(), pong) {
				t.Fatalf("the ping %q wasn't answered", ping)
			}
		}
	})
}
