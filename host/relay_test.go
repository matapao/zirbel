package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"testing"
	"time"
)

var tokenPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// The scenario the host contract test runs on both hosts, here against the Go
// host's relay: seats and the host, routing, the clock, refusals, resuming and
// leaving, and the room closing.
func TestRelaySeatsRoutesResumesAndCloses(t *testing.T) {
	listener, rooms, room := relayListener(t, netRelease(t, 3))
	a := dialRelay(t, listener, "null")
	a.hello(room, "", "a")
	if w := a.welcome(); w.id != 1 || w.host != 1 || w.resumed || len(w.others) != 0 || w.maxMsg != 1<<20 || !tokenPattern.MatchString(w.token) {
		t.Fatalf("first WELCOME %+v", w)
	}
	b := dialRelay(t, listener, "")
	b.hello(room, "", "b")
	wb := b.welcome()
	if wb.id != 2 || wb.host != 1 || !slices.Equal(wb.others, []byte{1}) {
		t.Fatalf("second WELCOME %+v", wb)
	}
	a.expectSeat(relayJoin, 2)

	// To everyone else, to the host, to a seat; the relay names the sender.
	a.send(message(40, relayToAll, []byte("all"), false))
	if m := b.expect(40); m.peer != 1 || string(m.payload) != "all" || m.unreliable {
		t.Fatalf("ALL: %+v", m)
	}
	b.send(message(41, relayToHost, []byte("host"), true))
	if m := a.expect(41); m.peer != 2 || string(m.payload) != "host" || !m.unreliable {
		t.Fatalf("HOST: %+v", m)
	}
	// The host's own HOST message, and one to a seat nobody has, go nowhere.
	a.send(message(42, relayToHost, nil, false), message(43, 9, nil, false), message(44, 2, []byte("seat"), false))
	if m := b.expect(44); m.peer != 1 || string(m.payload) != "seat" {
		t.Fatalf("to a seat: %+v", m)
	}
	// PING is answered with PONG: the client's time back, and the relay's.
	clientTime := binary.LittleEndian.AppendUint64(nil, math.Float64bits(1234.5))
	a.send(message(relayPing, 0, clientTime, true))
	pong := a.expect(relayPong)
	if !pong.unreliable || len(pong.payload) != 16 || !bytes.Equal(pong.payload[:8], clientTime) ||
		math.Abs(math.Float64frombits(binary.LittleEndian.Uint64(pong.payload[8:]))-hubTime()) > 5000 {
		t.Fatalf("PONG %+v", pong)
	}
	a.quiet()

	// The wrong key, and a seat past the game's players.
	wrong := dialRelay(t, listener, "")
	wrong.send(message(relayHello, 0, helloPayload(relayVersion, "game", upper(room.ID), "not-the-key", "", "w"), false))
	wrong.expectError(relayDenied, "no game with that code is running", closePolicy)
	c := dialRelay(t, listener, "")
	c.hello(room, "", "c")
	if w := c.welcome(); w.id != 3 || !slices.Equal(w.others, []byte{1, 2}) {
		t.Fatalf("third WELCOME %+v", w)
	}
	a.expectSeat(relayJoin, 3)
	b.expectSeat(relayJoin, 3)
	full := dialRelay(t, listener, "")
	full.hello(room, "", "d")
	full.expectError(relayFull, "room is full", closePolicy)

	// A connection that drops makes its seat away: reliable messages wait for
	// it, unreliable ones don't, and its token brings it back.
	_ = b.conn.Close()
	a.expectSeat(relayAway, 2)
	c.expectSeat(relayAway, 2)
	a.send(message(45, 2, []byte("missed"), false), message(46, 2, []byte("stale"), true))
	again := dialRelay(t, listener, "")
	again.hello(room, wb.token, "b2")
	if w := again.welcome(); w.id != 2 || w.host != 1 || !w.resumed || w.token != wb.token || !slices.Equal(w.others, []byte{1, 3}) {
		t.Fatalf("resumed WELCOME %+v", w)
	}
	if m := again.expect(45); string(m.payload) != "missed" || m.peer != 1 {
		t.Fatalf("queued: %+v", m)
	}
	a.expectSeat(relayBack, 2)
	c.expectSeat(relayBack, 2)
	again.quiet()

	// The host leaving for good (close 1000): the others hear it left, and who hosts now.
	a.closeWith(closeNormal)
	a.expectClose(closeNormal)
	for _, other := range []*relayClient{again, c} {
		other.expectSeat(relayLeave, 1)
		other.expectSeat(relayHost, 2)
	}
	// The relay's traffic keeps the room active.
	room.mu.Lock()
	active := time.Since(room.activity) < time.Second
	room.mu.Unlock()
	if !active {
		t.Error("relay traffic did not count as activity")
	}

	// The room closing ends every connection with ERROR 5 and 1001.
	rooms.Close(room.ID)
	again.expectError(relayClosed, "the room closed", closeGoingAway)
	c.expectError(relayClosed, "the room closed", closeGoingAway)
	late := dialRelay(t, listener, "")
	late.hello(room, "", "e")
	late.expectError(relayDenied, "no game with that code is running", closePolicy)
}

func TestRelayRefusesWhatIsNotItsOwn(t *testing.T) {
	listener, rooms, room := relayListener(t, netRelease(t, 2))
	if status := upgradeStatus(t, listener, "http://elsewhere.example"); status != http.StatusForbidden {
		t.Fatalf("another site's page: %d", status)
	}
	if status := upgradeStatus(t, listener, "http://127.0.0.1:1"); status != http.StatusForbidden {
		t.Fatalf("another port: %d", status)
	}
	for name, hello := range map[string]struct {
		payload []byte
		code    byte
		why     string
	}{
		"version":   {helloPayload(3, "game", upper(room.ID), room.DocumentKey, "", ""), relayBadVersion, "protocol v3 not supported, this host speaks v2"},
		"empty":     {nil, relayBadVersion, "protocol v0 not supported, this host speaks v2"},
		"game name": {helloPayload(2, "a game", upper(room.ID), room.DocumentKey, "", ""), relayBadName, "bad game or room name"},
		"room name": {helloPayload(2, "game", "", room.DocumentKey, "", ""), relayBadName, "bad game or room name"},
		"cut short": {[]byte{2, 4, 'g'}, relayBadName, "bad game or room name"},
		"no room":   {helloPayload(2, "game", "ABCDEF", room.DocumentKey, "", ""), relayDenied, "no game with that code is running"},
	} {
		t.Run(name, func(t *testing.T) {
			c := dialRelay(t, listener, "")
			c.send(message(relayHello, 0, hello.payload, false))
			c.expectError(hello.code, hello.why, closePolicy)
		})
	}

	// Text messages and frames of another kind are ignored, even before HELLO;
	// a first frame that doesn't start with a whole HELLO closes the
	// connection without an ERROR; what follows a HELLO in its frame is ignored.
	payload := helloPayload(relayVersion, "game", upper(room.ID), room.DocumentKey, "", "h")
	hello := message(relayHello, 0, payload, false)
	// A HELLO that says it is one byte longer than the frame holds.
	cutShort := append(appendVarint([]byte{relayHello, 0}, uint64(len(payload)+1)*2), payload...)
	for name, first := range map[string][]byte{
		"not HELLO": message(relayPing, 0, make([]byte, 8), true), "empty": nil, "cut short": cutShort,
	} {
		t.Run(name, func(t *testing.T) {
			c := dialRelay(t, listener, "http://127.0.0.1:"+strconv.Itoa(listener.port))
			if _, err := c.conn.Write(frame(true, opText, append([]byte{0}, hello...), true)); err != nil {
				t.Fatal(err)
			}
			c.raw(append([]byte{1}, hello...))
			c.send(first)
			c.expectClose(closePolicy)
		})
	}
	c := dialRelay(t, listener, "")
	c.send(hello, message(40, relayToAll, []byte("ignored"), false))
	if w := c.welcome(); w.id != 1 {
		t.Fatalf("WELCOME %+v", w)
	}
	c.closeWith(closeNormal)
	c.expectClose(closeNormal)

	// A room of a game without net has no relay, even with its key.
	shared, _ := fakeRelease(t)
	other, err := rooms.Create(shared, "local")
	if err != nil {
		t.Fatal(err)
	}
	s := dialRelay(t, listener, "")
	s.hello(other, "", "")
	s.expectError(relayDenied, "no game with that code is running", closePolicy)

	// A message over 1 MiB closes the connection with 1009, and its seat is away
	// once the connection has ended.
	first := dialRelay(t, listener, "")
	first.hello(room, "", "1")
	first.welcome()
	second := dialRelay(t, listener, "")
	second.hello(room, "", "2")
	second.welcome()
	first.expectSeat(relayJoin, 2)
	second.send(message(40, relayToAll, make([]byte, relayMaxMessage), false))
	if m := first.expect(40); len(m.payload) != relayMaxMessage {
		t.Fatalf("a message at the limit arrived with %d bytes", len(m.payload))
	}
	second.send(message(40, relayToAll, make([]byte, relayMaxMessage+1), false))
	second.expectClose(closeTooBig)
	second.closeWith(closeTooBig) // as a browser answers it
	first.expectSeat(relayAway, 2)
}

// A seat away past the grace leaves; a host away hands the role over first;
// an away seat that misses too much leaves at once; and a connection with the
// same nonce takes its seat over while it is still there.
func TestRelayAwaySeatsAndTheHostRole(t *testing.T) {
	away, host := relayAwayGrace, relayHostGrace
	relayAwayGrace, relayHostGrace = 600*time.Millisecond, 200*time.Millisecond
	t.Cleanup(func() { relayAwayGrace, relayHostGrace = away, host })
	listener, _, room := relayListener(t, netRelease(t, 3))
	a := dialRelay(t, listener, "")
	a.hello(room, "", "a")
	wa := a.welcome()
	b := dialRelay(t, listener, "")
	b.hello(room, "", "b")
	b.welcome()
	a.expectSeat(relayJoin, 2)

	_ = a.conn.Close()
	started := time.Now()
	b.expectSeat(relayAway, 1)
	b.expectSeat(relayHost, 2)
	b.expectSeat(relayLeave, 1)
	if elapsed := time.Since(started); elapsed < 500*time.Millisecond {
		t.Fatalf("the away seat left after %v", elapsed)
	}
	// Its token no longer names a seat: a new one, as seat 1.
	back := dialRelay(t, listener, "")
	back.hello(room, wa.token, "a")
	if w := back.welcome(); w.id != 1 || w.resumed || w.host != 2 {
		t.Fatalf("after leaving: %+v", w)
	}
	b.expectSeat(relayJoin, 1)

	// The same nonce takes a seat over at once, without AWAY or BACK.
	room.relay.mu.Lock()
	seat := room.relay.seats[2]
	room.relay.mu.Unlock()
	if seat == nil {
		t.Fatal("seat 2 is empty")
	}
	twin := dialRelay(t, listener, "")
	token := seat.token
	twin.hello(room, token, "b")
	if w := twin.welcome(); w.id != 2 || !w.resumed {
		t.Fatalf("taken over: %+v", w)
	}
	back.quiet()

	// Seat 1 goes away. Whole messages of 256 KB wait for it; one byte more
	// and it leaves at once.
	_ = back.conn.Close()
	twin.expectSeat(relayAway, 1)
	exactly := message(40, 1, make([]byte, relayAwayQueue-5), false) // type, peer, a 3-byte varint and the payload
	if len(exactly) != relayAwayQueue {
		t.Fatalf("the message takes %d bytes", len(exactly))
	}
	twin.send(exactly)
	twin.quiet()
	twin.send(message(40, 1, nil, true)) // unreliable: not kept for it
	twin.quiet()
	twin.send(message(40, 1, nil, false))
	twin.expectSeat(relayLeave, 1)
	twin.quiet()

	// The host away with nobody to hand the role to keeps it until it leaves.
	_ = twin.conn.Close()
	time.Sleep(relayHostGrace + 150*time.Millisecond)
	room.relay.mu.Lock()
	kept, hostNow := room.relay.seats[2] != nil, room.relay.host
	room.relay.mu.Unlock()
	if !kept || hostNow != 2 {
		t.Fatalf("seat 2 kept %v, host %d", kept, hostNow)
	}
	time.Sleep(relayAwayGrace)
	room.relay.mu.Lock()
	empty, hostNow := len(room.relay.seats) == 0, room.relay.host
	room.relay.mu.Unlock()
	if !empty || hostNow != 0 {
		t.Fatalf("after the grace: empty %v, host %d", empty, hostNow)
	}
}
