package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"sync"
	"time"
	"unicode/utf8"

	"zirbel/contracts"
)

// The local socket the box's controller service brings the box's own
// gamepads over (--pads-socket), mirroring padsService in
// packages/server/pads-socket.ts. Frames both ways are a u16 length (LE),
// then a payload: 0 and a JSON control message (at most 4 KB), or 1, a
// gamepad's number and its pad state. One connection at a time.

const padsServiceMessageLimit = 4096

// serviceConn is the service's connection as the pads see it.
type serviceConn struct {
	conn net.Conn
	out  chan []byte
	once sync.Once
	done chan struct{}
}

func (c *serviceConn) text(message any) {
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	frame := binary.LittleEndian.AppendUint16(nil, uint16(len(data)+1)) // #nosec G115 -- the host's own messages are small
	select {
	case c.out <- append(append(frame, 0), data...):
	default:
		c.close(padsDone) // a service this far behind is dropped
	}
}
func (c *serviceConn) binary([]byte) {}
func (c *serviceConn) close(int) {
	c.once.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

// ListenForPads listens at path for the box's controller service. A socket
// left behind by an earlier run is taken over; anything else at the path is
// not. The socket's mode is 0660: its directory's group is the service's.
func ListenForPads(ctx context.Context, pads *Pads, path string) (net.Listener, error) {
	if info, err := os.Lstat(path); err == nil && info.Mode()&fs.ModeSocket != 0 {
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o660); err != nil { // #nosec G302 -- the service's group reads and writes it
		_ = listener.Close()
		return nil, err
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go servePadsService(pads, conn)
		}
	}()
	return listener, nil
}

// listenForPads starts the local socket for a launcher: a box comes up
// without its gamepads rather than not at all, so one it can't open is said
// and passed over.
func listenForPads(ctx context.Context, pads *Pads, path string) net.Listener {
	if path == "" {
		return nil
	}
	listener, err := ListenForPads(ctx, pads, path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Zirbel can't listen for the box's controllers at "+path+": "+err.Error())
		return nil
	}
	return listener
}

func servePadsService(pads *Pads, conn net.Conn) {
	c := &serviceConn{conn: conn, out: make(chan []byte, 256), done: make(chan struct{})}
	defer c.close(padsDone)
	go func() {
		for {
			select {
			case <-c.done:
				return
			case frame := <-c.out:
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if _, err := conn.Write(frame); err != nil {
					c.close(padsDone)
					return
				}
			}
		}
	}()
	pads.AttachService(c)
	defer pads.ServiceGone(c)
	reader := bufio.NewReader(conn)
	head := make([]byte, 2)
	for {
		if _, err := io.ReadFull(reader, head); err != nil {
			return
		}
		length := int(binary.LittleEndian.Uint16(head))
		if length < 1 || length > 1+padsServiceMessageLimit {
			return // a frame that isn't one ends the connection; the service connects again
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(reader, payload); err != nil || !servicePayload(pads, c, payload) {
			return
		}
	}
}

func servicePayload(pads *Pads, c *serviceConn, payload []byte) bool {
	if payload[0] == 1 && len(payload) >= 2 && len(payload) <= 2+padMaxFrame {
		return pads.ServiceInput(c, int(payload[1]), payload[2:])
	}
	if payload[0] != 0 || !utf8.Valid(payload[1:]) {
		return false
	}
	// As the Node host's TextDecoder reads it: without a byte order mark in front.
	text := bytes.TrimPrefix(payload[1:], []byte("\xef\xbb\xbf"))
	value, err := contracts.Decode(text)
	if err != nil || contracts.Validate("pads-service", value) != nil {
		return false
	}
	var message padsServiceMessage
	if contracts.Unmarshal(value, &message) != nil {
		return false
	}
	pads.ServiceMessage(c, message, json.RawMessage(append([]byte(nil), text...)))
	return true
}
