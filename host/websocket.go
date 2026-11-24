package main

import (
	"bufio"
	"context"
	"crypto/sha1" // #nosec G505 -- RFC 6455 mandates SHA-1 for Sec-WebSocket-Accept; it is not used for security.
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// A server-side WebSocket (RFC 6455) on the standard library: no extensions,
// no compression, text and binary messages, ping/pong and the close
// handshake. Room sockets need nothing more.

const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA

	closeNormal        = 1000
	closeProtocol      = 1002
	closeInvalidData   = 1007
	closePolicy        = 1008
	closeTooBig        = 1009
	websocketGUID      = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	closeHandshakeWait = 5 * time.Second
)

var errClosed = errors.New("websocket closed")

type wsConn struct {
	conn      net.Conn
	reader    *bufio.Reader
	readLimit int64

	writeMu sync.Mutex // one frame at a time
	pong    chan struct{}

	closeOnce sync.Once
	closeSent bool // a close frame went out or a write failed; guarded by writeMu
	peerOnce  sync.Once
	peerClose chan struct{} // closed when the peer's close frame arrives
}

func headerHas(h http.Header, name, token string) bool {
	for _, value := range h.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

func newWSConn(conn net.Conn, reader *bufio.Reader, readLimit int64) *wsConn {
	return &wsConn{conn: conn, reader: reader, readLimit: readLimit, pong: make(chan struct{}, 1), peerClose: make(chan struct{})}
}

// acceptWebSocket completes the opening handshake and takes over the
// connection. readLimit bounds one incoming message.
func acceptWebSocket(w http.ResponseWriter, r *http.Request, readLimit int64) (*wsConn, error) {
	key := r.Header.Get("Sec-WebSocket-Key")
	decoded, err := base64.StdEncoding.DecodeString(key)
	if r.Method != http.MethodGet || !headerHas(r.Header, "Connection", "upgrade") || !headerHas(r.Header, "Upgrade", "websocket") ||
		r.Header.Get("Sec-WebSocket-Version") != "13" || err != nil || len(decoded) != 16 {
		return nil, fail(http.StatusBadRequest, "Invalid WebSocket handshake.")
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("the response cannot be hijacked")
	}
	conn, buffered, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}
	// RFC 6455 requires SHA-1 for Sec-WebSocket-Accept; it protects nothing.
	// nosemgrep: go.lang.security.audit.crypto.use_of_weak_crypto.use-of-sha1
	sum := sha1.Sum([]byte(key + websocketGUID)) // #nosec G401 -- required by RFC 6455
	response := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
		base64.StdEncoding.EncodeToString(sum[:]) + "\r\n\r\n"
	_ = conn.SetDeadline(time.Time{})
	if _, err := conn.Write([]byte(response)); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return newWSConn(conn, buffered.Reader, readLimit), nil
}

func (c *wsConn) writeFrame(opcode byte, payload []byte, deadline time.Time) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closeSent {
		return errClosed
	}
	header := make([]byte, 2, 10)
	header[0] = 0x80 | opcode
	switch n := len(payload); {
	case n < 126:
		header[1] = byte(n)
	case n <= 0xFFFF:
		header[1] = 126
		header = binary.BigEndian.AppendUint16(header, uint16(n))
	default:
		header[1] = 127
		header = binary.BigEndian.AppendUint64(header, uint64(n))
	}
	if opcode == opClose {
		c.closeSent = true
	}
	_ = c.conn.SetWriteDeadline(deadline)
	_, err := c.conn.Write(append(header, payload...))
	if err != nil {
		c.closeSent = true // part of the frame may have gone out: send nothing after it
	}
	return err
}

// Write sends one text message, giving up at the deadline.
func (c *wsConn) Write(data []byte, deadline time.Time) error {
	return c.writeFrame(opText, data, deadline)
}

// Ping sends a ping and waits for the pong.
func (c *wsConn) Ping(ctx context.Context) error {
	deadline, _ := ctx.Deadline()
	if err := c.writeFrame(opPing, nil, deadline); err != nil {
		return err
	}
	select {
	case <-c.pong:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// closeCode keeps a close code in the range RFC 6455 lets servers send.
func closeCode(code int) uint16 {
	if code < 1000 || code > 4999 {
		return closeNormal
	}
	return uint16(code)
}

// Close sends a close frame, waits briefly for the peer's, then closes.
func (c *wsConn) Close(code int, reason string) error {
	payload := binary.BigEndian.AppendUint16(nil, closeCode(code))
	if len(reason) > 123 {
		reason = reason[:123]
	}
	err := c.writeFrame(opClose, append(payload, reason...), time.Now().Add(closeHandshakeWait))
	if err == nil {
		select {
		case <-c.peerClose:
		case <-time.After(closeHandshakeWait):
		}
	}
	c.CloseNow()
	return err
}

// CloseNow drops the connection without a handshake.
func (c *wsConn) CloseNow() { c.closeOnce.Do(func() { _ = c.conn.Close() }) }

// closeAfterError answers a protocol error or the peer's close with a close
// frame and ends the read. A write stuck on a client that stopped reading
// holds writeMu until its own deadline, so bring that deadline forward: the
// close frame waits a second at most.
func (c *wsConn) closeAfterError(code uint16) error {
	deadline := time.Now().Add(time.Second)
	_ = c.conn.SetWriteDeadline(deadline)
	_ = c.writeFrame(opClose, binary.BigEndian.AppendUint16(nil, code), deadline)
	c.CloseNow()
	return errClosed
}

// Read returns the next text or binary message. Control frames are handled
// here; ctx ends the read by closing the connection.
func (c *wsConn) Read(ctx context.Context) (byte, []byte, error) {
	stop := context.AfterFunc(ctx, c.CloseNow)
	defer stop()
	var message []byte
	var kind byte
	for {
		head := make([]byte, 2)
		if _, err := io.ReadFull(c.reader, head); err != nil {
			return 0, nil, err
		}
		fin, opcode, masked := head[0]&0x80 != 0, head[0]&0x0F, head[1]&0x80 != 0
		if head[0]&0x70 != 0 || !masked {
			return 0, nil, c.closeAfterError(closeProtocol) // no extensions; clients must mask
		}
		length := int64(head[1] & 0x7F)
		switch length {
		case 126:
			extended := make([]byte, 2)
			if _, err := io.ReadFull(c.reader, extended); err != nil {
				return 0, nil, err
			}
			length = int64(binary.BigEndian.Uint16(extended))
		case 127:
			extended := make([]byte, 8)
			if _, err := io.ReadFull(c.reader, extended); err != nil {
				return 0, nil, err
			}
			value := binary.BigEndian.Uint64(extended)
			if value > uint64(c.readLimit) {
				return 0, nil, c.closeAfterError(closeTooBig)
			}
			length = int64(value) // #nosec G115 -- bounded by readLimit above
		}
		control := opcode >= opClose
		if control && (!fin || length > 125) {
			return 0, nil, c.closeAfterError(closeProtocol)
		}
		if !control && int64(len(message))+length > c.readLimit {
			return 0, nil, c.closeAfterError(closeTooBig)
		}
		mask := make([]byte, 4)
		if _, err := io.ReadFull(c.reader, mask); err != nil {
			return 0, nil, err
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.reader, payload); err != nil {
			return 0, nil, err
		}
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
		switch opcode {
		case opPing:
			_ = c.writeFrame(opPong, payload, time.Now().Add(10*time.Second))
			continue
		case opPong:
			select {
			case c.pong <- struct{}{}:
			default:
			}
			continue
		case opClose:
			// A room keeps reading after its own read loop ends, to receive the
			// peer's close reply; a client can send more than one close frame.
			c.peerOnce.Do(func() { close(c.peerClose) })
			code := uint16(closeNormal)
			if len(payload) >= 2 {
				code = binary.BigEndian.Uint16(payload)
			}
			return 0, nil, c.closeAfterError(code)
		case opText, opBinary:
			if message != nil {
				return 0, nil, c.closeAfterError(closeProtocol) // a new message inside a fragmented one
			}
			kind, message = opcode, payload
		case opContinuation:
			if message == nil {
				return 0, nil, c.closeAfterError(closeProtocol)
			}
			message = append(message, payload...)
		default:
			return 0, nil, c.closeAfterError(closeProtocol)
		}
		if !fin {
			continue
		}
		if kind == opText && !utf8.Valid(message) {
			return 0, nil, c.closeAfterError(closeInvalidData)
		}
		return kind, message, nil
	}
}
