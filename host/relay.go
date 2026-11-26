package main

import (
	"encoding/hex"
	"slices"
	"sync"
	"time"
)

// The relay: a room of a game with its own netcode (a net-v2 release) is also
// a zirbel-net room, which passes the game's messages between its seats. The
// relay keeps seats, the host and resume tokens; what the messages say is the
// game's business. relay_socket.go connects it to the player listeners.

const (
	relayMaxMessage = 1 << 20 // the largest payload, announced in WELCOME
	relayHighWater  = 16_384  // unreliable messages wait for no backlog over this
	relayAwayQueue  = 262_144 // bytes of whole messages kept for an away seat
	relayMaxSeat    = 253     // the highest seat; 254 and 255 mean other things
	relayStale      = 3 * time.Second
	relayTokenBytes = 16
)

// How long an away seat keeps its place, and the host role. Tests shorten them.
var (
	relayAwayGrace = 15 * time.Second
	relayHostGrace = 2500 * time.Millisecond
)

type relaySeat struct {
	id      byte
	token   string
	nonce   string
	conn    *relayConn // nil while away
	away    bool
	absence int    // counts the seat's absences, so a timer from an earlier one does nothing
	rel, un []byte // messages not yet sent; rel also holds what an away seat missed
	dirty   bool
	timers  []*time.Timer
}

func (s *relaySeat) stopTimers() {
	for _, timer := range s.timers {
		timer.Stop()
	}
	s.timers = nil
}

// relayRoom is a room's relay state. Its lock is taken after the room's own,
// never before it.
type relayRoom struct {
	mu     sync.Mutex
	seats  map[byte]*relaySeat
	host   byte // 0: none
	closed bool
	dirty  []*relaySeat
}

// others are the seats besides except (which may be nil), in id order.
func (r *relayRoom) others(except *relaySeat) []*relaySeat {
	list := make([]*relaySeat, 0, len(r.seats))
	for _, s := range r.seats {
		if s != except {
			list = append(list, s)
		}
	}
	slices.SortFunc(list, func(a, b *relaySeat) int { return int(a.id) - int(b.id) })
	return list
}

// join seats a connection that said HELLO: in the seat its token names, or a
// new one. It returns an ERROR's code and message when it cannot.
func (r *relayRoom) join(c *relayConn, token, nonce string, capacity int) (byte, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	defer r.flush()
	if r.closed {
		return relayDenied, "no game with that code is running"
	}
	if token != "" {
		for _, s := range r.others(nil) {
			if same(s.token, token) && (s.away || s.nonce == nonce || s.conn == nil || s.conn.silentFor() > relayStale) {
				r.attach(s, c, nonce)
				return 0, ""
			}
		}
	}
	if len(r.seats) >= capacity {
		return relayFull, "room is full"
	}
	id := byte(1)
	for r.seats[id] != nil && id < relayMaxSeat {
		id++
	}
	if r.seats[id] != nil {
		return relayFull, "room is full"
	}
	s := &relaySeat{id: id, token: hex.EncodeToString(randomBytes(relayTokenBytes)), nonce: nonce, conn: c}
	r.seats[id] = s
	c.seat = s
	previous := r.host
	if r.host == 0 {
		r.host = id
	}
	r.welcome(s, false)
	others := r.others(s)
	for _, other := range others {
		r.system(other, relayJoin, id)
	}
	if r.host != previous && len(others) > 0 {
		for _, other := range others {
			r.system(other, relayHost, r.host)
		}
	}
	return 0, ""
}

// attach gives a seat to the connection that resumed it. The connection it had
// is dropped; what the seat missed while away follows the WELCOME.
func (r *relayRoom) attach(s *relaySeat, c *relayConn, nonce string) {
	if old := s.conn; old != nil {
		old.seat = nil
		old.drop()
	}
	s.stopTimers()
	wasAway := s.away
	s.conn, s.nonce, s.away, s.un = c, nonce, false, s.un[:0]
	c.seat = s
	missed := s.rel
	s.rel = nil
	r.welcome(s, true)
	s.rel = append(s.rel, missed...)
	if wasAway {
		for _, other := range r.others(s) {
			r.system(other, relayBack, s.id)
		}
	}
}

// welcome tells a seat who it is, who hosts and who else is in the room.
func (r *relayRoom) welcome(s *relaySeat, resumed bool) {
	flag := byte(0)
	if resumed {
		flag = 1
	}
	payload := appendFloat(appendString([]byte{s.id, r.host}, s.token), hubTime())
	payload = append(payload, flag, 0) // resumed, then the relay's capabilities: none
	others := r.others(s)
	payload = appendVarint(payload, uint64(len(others)))
	for _, other := range others {
		payload = append(payload, other.id)
	}
	payload = appendString(appendString(appendVarint(payload, relayMaxMessage), ""), "") // no revision, no base
	r.deliver(s, relayWelcome, 0, payload, false)
}

// system sends one of the relay's own messages about a seat.
func (r *relayRoom) system(to *relaySeat, kind, seat byte) {
	r.deliver(to, kind, 0, []byte{seat}, false)
}

// deliver queues a message for a seat: unreliable ones only while it is here,
// reliable ones also while it is away, up to relayAwayQueue.
func (r *relayRoom) deliver(s *relaySeat, kind, from byte, payload []byte, unreliable bool) {
	if r.seats[s.id] != s {
		return
	}
	if s.away {
		if unreliable {
			return
		}
		if s.rel = appendMessage(s.rel, kind, from, payload, false); len(s.rel) > relayAwayQueue {
			r.remove(s) // it missed too much
		}
		return
	}
	if unreliable {
		s.un = appendMessage(s.un, kind, from, payload, true)
	} else {
		s.rel = appendMessage(s.rel, kind, from, payload, false)
	}
	if !s.dirty {
		s.dirty = true
		r.dirty = append(r.dirty, s)
	}
}

// flush sends every seat what was queued for it, as one frame: reliable
// messages first, unreliable ones unless its connection is backed up.
func (r *relayRoom) flush() {
	for _, s := range r.dirty {
		s.dirty = false
		c := s.conn
		if s.away || c == nil || r.seats[s.id] != s {
			s.un = s.un[:0]
			continue
		}
		if len(s.un) > 0 && c.pending.Load() > relayHighWater {
			s.un = s.un[:0]
		}
		if len(s.rel)+len(s.un) > 0 {
			frame := make([]byte, 0, 1+len(s.rel)+len(s.un))
			c.push(append(append(append(frame, 0), s.rel...), s.un...))
		}
		s.rel, s.un = shrink(s.rel), shrink(s.un)
	}
	r.dirty = r.dirty[:0]
}

// shrink empties a buffer, letting go of one that grew large.
func shrink(b []byte) []byte {
	if cap(b) > 65_536 {
		return nil
	}
	return b[:0]
}

// frame routes the messages of one frame from a seated connection. It returns
// a close code when the connection broke the rules; its seat is away once the
// connection has ended.
func (r *relayRoom) frame(c *relayConn, data []byte) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	defer r.flush()
	if len(data) == 0 || data[0] != 0 {
		return 0 // a frame of another kind
	}
	cursor := relayCursor{frame: data, pos: 1}
	for cursor.next() {
		s := c.seat
		if s == nil || s.conn != c {
			return 0 // replaced, or the room closed
		}
		switch {
		case len(cursor.payload) > relayMaxMessage:
			return closeTooBig
		case cursor.kind >= relayApp:
			r.route(s, cursor.kind, cursor.peer, cursor.payload, cursor.unreliable)
		case cursor.kind == relayPing:
			clientTime := make([]byte, 8)
			if len(cursor.payload) >= 8 {
				copy(clientTime, cursor.payload)
			}
			r.deliver(s, relayPong, 0, appendFloat(clientTime, hubTime()), true)
		}
	}
	return 0
}

// route passes a game's message on: to every other seat, to the host, or to one seat.
func (r *relayRoom) route(from *relaySeat, kind, to byte, payload []byte, unreliable bool) {
	switch to {
	case relayToAll:
		for _, other := range r.others(from) {
			r.deliver(other, kind, from.id, payload, unreliable)
		}
	case relayToHost:
		if host := r.seats[r.host]; host != nil && host != from {
			r.deliver(host, kind, from.id, payload, unreliable)
		}
	default:
		if seat := r.seats[to]; seat != nil && seat != from {
			r.deliver(seat, kind, from.id, payload, unreliable)
		}
	}
}

// gone is called when a seated connection ended with the code it closed with.
func (r *relayRoom) gone(c *relayConn, code int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	defer r.flush()
	r.lost(c, code)
}

// lost takes a connection from its seat. A seat closed with 1000 leaves; any
// other end makes it away, and it leaves unless it is back within the grace.
func (r *relayRoom) lost(c *relayConn, code int) {
	s := c.seat
	if s == nil || s.conn != c {
		return
	}
	c.seat, s.conn = nil, nil
	if code == closeNormal {
		r.remove(s)
		return
	}
	s.away, s.un = true, s.un[:0]
	s.absence++
	absence := s.absence
	for _, other := range r.others(s) {
		r.system(other, relayAway, s.id)
	}
	s.timers = append(s.timers, time.AfterFunc(relayAwayGrace, func() {
		r.whileAway(s, absence, func() { r.remove(s) })
	}))
	if r.host == s.id {
		s.timers = append(s.timers, time.AfterFunc(relayHostGrace, func() {
			r.whileAway(s, absence, func() { r.handOver(s) })
		}))
	}
}

// whileAway runs a timer's work if the seat is still away on the same absence.
func (r *relayRoom) whileAway(s *relaySeat, absence int, work func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	defer r.flush()
	if s.away && s.absence == absence && r.seats[s.id] == s {
		work()
	}
}

// handOver gives the host role of an away seat to another, if there is one.
func (r *relayRoom) handOver(s *relaySeat) {
	if r.host != s.id {
		return
	}
	if host := r.elect(s); host != 0 {
		r.host = host
		for _, seat := range r.others(nil) {
			r.system(seat, relayHost, host)
		}
	}
}

// remove takes a seat out of the room; the others hear it left, and who hosts
// now if it did.
func (r *relayRoom) remove(s *relaySeat) {
	if r.seats[s.id] != s {
		return
	}
	s.stopTimers()
	delete(r.seats, s.id)
	if c := s.conn; c != nil {
		c.seat, s.conn = nil, nil
		c.drop()
	}
	s.rel, s.un = nil, nil
	for _, other := range r.others(nil) {
		r.system(other, relayLeave, s.id)
	}
	if r.host == s.id {
		r.host = r.elect(nil)
		if r.host != 0 {
			for _, other := range r.others(nil) {
				r.system(other, relayHost, r.host)
			}
		}
	}
}

// elect picks a host among the seats besides except: one that is here before
// one that is away, then the lowest id. 0 when there is none.
func (r *relayRoom) elect(except *relaySeat) byte {
	var best *relaySeat
	for _, s := range r.others(except) {
		if best == nil || (best.away && !s.away) {
			best = s
		}
	}
	if best == nil {
		return 0
	}
	return best.id
}

// close ends the relay with its room: every connection hears the room closed,
// after anything still queued for it, and is closed with 1001.
func (r *relayRoom) close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	why := appendString([]byte{relayClosed}, "the room closed")
	present := r.others(nil)
	for _, s := range present {
		s.stopTimers()
		if s.conn != nil {
			r.deliver(s, relayError, 0, why, false)
		}
	}
	r.flush()
	for _, s := range present {
		if c := s.conn; c != nil {
			c.seat, s.conn = nil, nil
			c.closeWith(closeGoingAway)
		}
	}
	r.seats, r.host, r.dirty = map[byte]*relaySeat{}, 0, nil
}
