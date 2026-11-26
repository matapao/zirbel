package main

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"net"
	"net/http"
	"strconv"
	"testing"
	"time"

	"zirbel/host/webfiles"
)

// A zirbel-net client for the relay's tests: it speaks protocol v2 over a
// WebSocket on loopback TCP, as zirbel-net in a game does.

// netRelease is a release of a game with its own netcode for players.
func netRelease(t *testing.T, players int) *Release {
	t.Helper()
	game := `{"html":"<canvas></canvas>","maxPlayers":` + strconv.Itoa(players) + `,"net":true}`
	document := map[string]any{
		"manifest": map[string]any{
			"format": 1, "releaseId": "n1", "gameId": "g1", "sourceRevision": "s1", "title": "Net", "sdk": "1.0.0",
			"protocol": 1, "client": "player.html", "simulation": "net-v2", "players": map[string]int{"min": 1, "max": players},
			"capabilities": []string{"multiplayer"}, "permissions": map[string]bool{"play": true, "download": true, "remix": true},
			"assets": []any{}, "credits": []any{}, "files": map[string]string{"player.js": digest([]byte("ok"))},
		},
		"game": json.RawMessage(game), "sceneHash": digest([]byte(game)),
		"files": map[string]string{"player.js": base64.StdEncoding.EncodeToString([]byte("ok"))}, "assets": map[string]string{},
	}
	data, _ := jsJSON(document)
	release, err := ParseRelease(data)
	if err != nil {
		t.Fatal(err)
	}
	return release
}

// relayListener opens a room for release on a loopback player listener.
func relayListener(t *testing.T, release *Release) (*Listener, *Rooms, *Room) {
	t.Helper()
	rooms := NewRooms()
	t.Cleanup(rooms.Dispose)
	room, err := rooms.Create(release, "local")
	if err != nil {
		t.Fatal(err)
	}
	runtime := map[string]*webfiles.File{"player.html": {Bytes: []byte("<head></head>")}}
	listener, err := Listen(t.Context(), rooms, runtime, "127.0.0.1", 0, listenerConfig{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(listener.Close)
	return listener, rooms, room
}

type relayMessage struct {
	kind, peer byte
	payload    []byte
	unreliable bool
}

// serverFrame is a WebSocket frame from the server: a binary message, or the
// close frame with its code (closed is 0 for a dropped connection).
type serverFrame struct {
	opcode  byte
	payload []byte
}

type relayClient struct {
	t      *testing.T
	conn   net.Conn
	frames chan serverFrame
	queue  []relayMessage
}

// dialRelay opens /mp with origin (none if empty).
func dialRelay(t *testing.T, l *Listener, origin string) *relayClient {
	t.Helper()
	conn, reader, status := upgrade(t, l, origin)
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("the upgrade was refused with %d", status)
	}
	c := &relayClient{t: t, conn: conn, frames: make(chan serverFrame, 64)}
	go c.read(reader)
	return c
}

// upgradeStatus is the status the relay answers an upgrade from origin with.
func upgradeStatus(t *testing.T, l *Listener, origin string) int {
	t.Helper()
	_, _, status := upgrade(t, l, origin)
	return status
}

func upgrade(t *testing.T, l *Listener, origin string) (net.Conn, *bufio.Reader, int) {
	t.Helper()
	conn, err := (&net.Dialer{}).DialContext(t.Context(), "tcp4", "127.0.0.1:"+strconv.Itoa(l.port))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	request := "GET /mp?r=game%2Froom HTTP/1.1\r\nHost: 127.0.0.1:" + strconv.Itoa(l.port) +
		"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
	if origin != "" {
		request += "Origin: " + origin + "\r\n"
	}
	if _, err := conn.Write([]byte(request + "\r\n")); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	return conn, reader, response.StatusCode
}

// read passes on the server's frames until the connection ends.
func (c *relayClient) read(reader *bufio.Reader) {
	defer close(c.frames)
	for {
		head := make([]byte, 2)
		if _, err := io.ReadFull(reader, head); err != nil {
			return
		}
		n := uint64(head[1] & 0x7F)
		switch n {
		case 126:
			extended := make([]byte, 2)
			if _, err := io.ReadFull(reader, extended); err != nil {
				return
			}
			n = uint64(binary.BigEndian.Uint16(extended))
		case 127:
			extended := make([]byte, 8)
			if _, err := io.ReadFull(reader, extended); err != nil {
				return
			}
			n = binary.BigEndian.Uint64(extended)
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return
		}
		c.frames <- serverFrame{head[0] & 0x0F, payload}
	}
}

// send sends one frame holding messages.
func (c *relayClient) send(messages ...[]byte) {
	c.t.Helper()
	data := []byte{0}
	for _, message := range messages {
		data = append(data, message...)
	}
	c.raw(data)
}
func (c *relayClient) raw(data []byte) {
	c.t.Helper()
	if _, err := c.conn.Write(frame(true, opBinary, data, true)); err != nil {
		c.t.Fatal(err)
	}
}
func message(kind, peer byte, payload []byte, unreliable bool) []byte {
	return appendMessage(nil, kind, peer, payload, unreliable)
}
func helloPayload(version byte, game, room, key, token, nonce string) []byte {
	payload := []byte{version}
	for _, field := range []string{game, room, key, token, nonce} {
		payload = appendString(payload, field)
	}
	return append(payload, 0)
}
func (c *relayClient) hello(room *Room, token, nonce string) {
	c.t.Helper()
	c.send(message(relayHello, 0, helloPayload(relayVersion, "game", upper(room.ID), room.DocumentKey, token, nonce), false))
}

// upper is how launchParams passes the room: upper-cased.
func upper(id string) string {
	out := []byte(id)
	for i, b := range out {
		if b >= 'a' && b <= 'z' {
			out[i] = b - 32
		}
	}
	return string(out)
}

// next returns the next message from the relay; a close frame or the end of
// the connection fails the test.
func (c *relayClient) next() relayMessage {
	c.t.Helper()
	for len(c.queue) == 0 {
		select {
		case f, ok := <-c.frames:
			if !ok || f.opcode == opClose {
				c.t.Fatalf("the connection closed (%v) while a message was due", f.payload)
			}
			if len(f.payload) == 0 || f.payload[0] != 0 {
				c.t.Fatalf("not a frame of this protocol: %v", f.payload)
			}
			cursor := relayCursor{frame: f.payload, pos: 1}
			for cursor.next() {
				c.queue = append(c.queue, relayMessage{cursor.kind, cursor.peer, cursor.payload, cursor.unreliable})
			}
		case <-time.After(5 * time.Second):
			c.t.Fatal("no message within 5 s")
		}
	}
	m := c.queue[0]
	c.queue = c.queue[1:]
	return m
}

// expect returns the next message, which must be of kind.
func (c *relayClient) expect(kind byte) relayMessage {
	c.t.Helper()
	m := c.next()
	if m.kind != kind {
		c.t.Fatalf("got message type %d (%v), want %d", m.kind, m.payload, kind)
	}
	return m
}

// expectSeat expects one of the relay's messages about a seat.
func (c *relayClient) expectSeat(kind, seat byte) {
	c.t.Helper()
	if m := c.expect(kind); m.peer != 0 || len(m.payload) != 1 || m.payload[0] != seat || m.unreliable {
		c.t.Fatalf("type %d: got peer %d payload %v, want seat %d", kind, m.peer, m.payload, seat)
	}
}

// expectError expects an ERROR, then the close frame with closeCode.
func (c *relayClient) expectError(code byte, why string, closeCode int) {
	c.t.Helper()
	m := c.expect(relayError)
	in := relayReader{b: m.payload}
	if got, text := in.u8(), in.str(); got != code || text != why || in.overrun() {
		c.t.Fatalf("ERROR %d %q, want %d %q", got, text, code, why)
	}
	c.expectClose(closeCode)
}

// expectClose expects the close frame next, with code.
func (c *relayClient) expectClose(code int) {
	c.t.Helper()
	if len(c.queue) > 0 {
		c.t.Fatalf("messages before the close: %v", c.queue)
	}
	select {
	case f, ok := <-c.frames:
		if !ok || f.opcode != opClose || len(f.payload) < 2 || int(binary.BigEndian.Uint16(f.payload)) != code {
			c.t.Fatalf("got frame %v (open %v), want close %d", f, ok, code)
		}
	case <-time.After(5 * time.Second):
		c.t.Fatalf("no close %d within 5 s", code)
	}
}

// quiet checks that nothing more arrives for a moment.
func (c *relayClient) quiet() {
	c.t.Helper()
	select {
	case f := <-c.frames:
		c.t.Fatalf("unexpected frame %v", f)
	case <-time.After(150 * time.Millisecond):
	}
	if len(c.queue) > 0 {
		c.t.Fatalf("unexpected messages %v", c.queue)
	}
}

// closeWith sends a close frame with code, as a browser's ws.close(code) does.
func (c *relayClient) closeWith(code int) {
	c.t.Helper()
	if _, err := c.conn.Write(frame(true, opClose, binary.BigEndian.AppendUint16(nil, uint16(code)), true)); err != nil { // #nosec G115 -- a close code
		c.t.Fatal(err)
	}
}

type welcomed struct {
	id, host byte
	token    string
	resumed  bool
	others   []byte
	maxMsg   uint64
}

func (c *relayClient) welcome() welcomed {
	c.t.Helper()
	m := c.expect(relayWelcome)
	in := relayReader{b: m.payload}
	w := welcomed{id: in.u8(), host: in.u8(), token: in.str()}
	sent := math.Float64frombits(binary.LittleEndian.Uint64(in.b[in.pos : in.pos+8]))
	in.pos += 8
	w.resumed = in.u8() == 1
	if caps := in.u8(); caps != 0 || math.Abs(sent-hubTime()) > 5000 {
		c.t.Fatalf("WELCOME caps %d, time %v", caps, sent)
	}
	for range in.varint() {
		w.others = append(w.others, in.u8())
	}
	w.maxMsg = in.varint()
	if revision, base := in.str(), in.str(); revision != "" || base != "" || in.overrun() || in.pos != len(in.b) {
		c.t.Fatalf("WELCOME ends %q %q, overrun %v", revision, base, in.overrun())
	}
	return w
}
