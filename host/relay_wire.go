package main

import (
	"encoding/binary"
	"math"
	"regexp"
	"time"
)

// zirbel-net's wire protocol, version 2, as packages/net/protocol.ts describes
// it. Every WebSocket message is one frame: kind 0, then messages. A message is
// type u8, peer u8, lenflags varint (length * 2 + 1 if unreliable) and its
// payload. Varints are unsigned LEB128, a string is a varint byte length and
// UTF-8, and numbers are little-endian (f64 IEEE 754).

const relayVersion = 2

// Message types: 1 to 31 are the relay's own, 32 and above a game's.
const (
	relayHello   = 1
	relayWelcome = 2
	relayJoin    = 3
	relayLeave   = 4
	relayHost    = 5
	relayPing    = 6
	relayPong    = 7
	relayError   = 9
	relayAway    = 10
	relayBack    = 11
	relayApp     = 32
)

// A message's peer, from a client: everyone else, the host, or a seat.
const (
	relayToAll  = 0
	relayToHost = 255
)

// ERROR codes.
const (
	relayBadVersion = 1
	relayFull       = 2
	relayBadName    = 3
	relayClosed     = 5
	relayDenied     = 6
)

// relayName is what a game and a room may be called (NAME in protocol.ts).
var relayName = regexp.MustCompile(`^[\w.-]{1,32}$`)

func appendVarint(b []byte, v uint64) []byte {
	for v >= 128 {
		b = append(b, byte(v)|128)
		v >>= 7
	}
	return append(b, byte(v))
}
func appendString(b []byte, s string) []byte { return append(appendVarint(b, uint64(len(s))), s...) }
func appendFloat(b []byte, v float64) []byte {
	return binary.LittleEndian.AppendUint64(b, math.Float64bits(v))
}

// appendMessage appends one message: its type, peer, lenflags and payload.
func appendMessage(b []byte, kind, peer byte, payload []byte, unreliable bool) []byte {
	lenflags := uint64(len(payload)) * 2
	if unreliable {
		lenflags++
	}
	return append(appendVarint(append(b, kind, peer), lenflags), payload...)
}

// relayErrorFrame is a frame with one ERROR: its code and why.
func relayErrorFrame(code byte, why string) []byte {
	return appendMessage([]byte{0}, relayError, 0, appendString([]byte{code}, why), false)
}

// hubTime is the relay's clock, in milliseconds since the epoch.
func hubTime() float64 { return float64(time.Now().UnixMilli()) }

// relayCursor steps through a frame's messages, as Cursor in protocol.ts does:
// it stops at the end, or where a message is cut short or malformed.
type relayCursor struct {
	frame      []byte
	pos        int
	kind, peer byte
	payload    []byte
	unreliable bool
}

func (c *relayCursor) next() bool {
	b, q := c.frame, c.pos
	if q+3 > len(b) {
		return false
	}
	kind, peer := b[q], b[q+1]
	q += 2
	var lenflags uint64
	for i := 0; ; i++ {
		// Six varint bytes reach 2^42, far past any message limit.
		if q >= len(b) || i == 6 {
			return false
		}
		digit := b[q]
		q++
		lenflags |= uint64(digit&127) << (7 * i)
		if digit < 128 {
			break
		}
	}
	if lenflags/2 > uint64(len(b)-q) { // #nosec G115 -- q is at most len(b) here
		return false
	}
	end := q + int(lenflags/2) // #nosec G115 -- at most the frame's length, checked above
	c.kind, c.peer, c.payload, c.unreliable, c.pos = kind, peer, b[q:end:end], lenflags%2 == 1, end
	return true
}

// relayReader reads a payload as Reader in codec.ts does: past the end it
// reads zeros and empty strings, and overrun reports that it went there.
type relayReader struct {
	b   []byte
	pos int
}

func (r *relayReader) overrun() bool { return r.pos > len(r.b) }
func (r *relayReader) u8() byte {
	p := r.pos
	r.pos++
	if p < len(r.b) {
		return r.b[p]
	}
	return 0
}
func (r *relayReader) varint() uint64 {
	var v uint64
	for i := range 8 {
		digit := r.u8()
		v |= uint64(digit&127) << (7 * i)
		if digit < 128 {
			break
		}
	}
	return v
}

// str returns a string's bytes as they came; a game or room name must match
// relayName, and keys, tokens and nonces are only compared.
func (r *relayReader) str() string {
	n := r.varint()
	start := min(r.pos, len(r.b))
	if r.overrun() || n > uint64(len(r.b)-start) { // #nosec G115 -- start is at most len(r.b)
		r.pos = len(r.b) + 1
		return string(r.b[start:])
	}
	r.pos += int(n) // #nosec G115 -- at most the payload's length, checked above
	return string(r.b[start:r.pos])
}
