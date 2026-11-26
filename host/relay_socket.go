package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The relay's WebSocket at /mp on every player listener (relay.go has its rooms).

const (
	relayReadLimit = relayMaxMessage + 64<<10 // one incoming WebSocket message
	relayHelloWait = 10 * time.Second
	relayIdle      = 15 * time.Second // a seated connection that sends nothing for this long is dropped
	relayBacklog   = 8 << 20          // unsent bytes that drop a connection that stopped reading
)

// relayConn is one connection to the relay. Its writer sends queued frames in
// order, so a room never waits on a slow client.
type relayConn struct {
	ws      *wsConn
	drop    context.CancelFunc // ends the connection without a close frame
	room    *Room              // set by the reader once HELLO seated it
	seat    *relaySeat         // guarded by room.relay.mu
	pending atomic.Int64       // bytes queued and not yet written
	lastRx  atomic.Int64       // when the last binary message arrived, in Unix nanoseconds
	wake    chan struct{}

	mu      sync.Mutex
	frames  [][]byte
	closing int // a close code to send after the frames
}

func newRelayConn(ws *wsConn, drop context.CancelFunc) *relayConn {
	c := &relayConn{ws: ws, drop: drop, wake: make(chan struct{}, 1)}
	c.lastRx.Store(time.Now().UnixNano())
	return c
}

// push queues a frame; a connection with too much unsent is dropped instead.
func (c *relayConn) push(frame []byte) {
	c.mu.Lock()
	if c.closing != 0 {
		c.mu.Unlock()
		return
	}
	if c.pending.Add(int64(len(frame))) > relayBacklog {
		c.mu.Unlock()
		c.drop()
		return
	}
	c.frames = append(c.frames, frame)
	c.mu.Unlock()
	c.signal()
}

// closeWith closes the connection with code once the queued frames are out.
func (c *relayConn) closeWith(code int) {
	c.mu.Lock()
	if c.closing == 0 {
		c.closing = code
	}
	c.mu.Unlock()
	c.signal()
}
func (c *relayConn) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}
func (c *relayConn) closed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closing != 0
}

// silentFor is how long the connection has sent no message.
func (c *relayConn) silentFor() time.Duration {
	return time.Duration(time.Now().UnixNano() - c.lastRx.Load())
}

// write sends the queued frames, then the close frame if one is due.
func (c *relayConn) write(ctx context.Context) {
	for {
		c.mu.Lock()
		if len(c.frames) > 0 {
			frame := c.frames[0]
			c.frames[0] = nil
			c.frames = c.frames[1:]
			c.mu.Unlock()
			err := c.ws.WriteBinary(frame, time.Now().Add(10*time.Second))
			c.pending.Add(-int64(len(frame)))
			if err != nil {
				c.drop()
				return
			}
			continue
		}
		code := c.closing
		c.mu.Unlock()
		if code != 0 {
			_ = c.ws.Close(code, "")
			c.drop()
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-c.wake:
		}
	}
}

// refuse answers a HELLO with an ERROR and closes the connection.
func (c *relayConn) refuse(code byte, why string) {
	c.push(relayErrorFrame(code, why))
	c.closeWith(closePolicy)
}

// sameHost is the relay's origin check: a page on this listener's own host, or
// a game, whose sandbox gives it the opaque origin "null".
func sameHost(r *http.Request) bool {
	values, present := r.Header["Origin"]
	if !present {
		return true
	}
	origin := strings.Join(values, ",")
	if origin == "null" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	host := strings.ToLower(parsed.Host)
	// As a URL's host has it: without the scheme's default port.
	if port := parsed.Port(); (port == "80" && (parsed.Scheme == "http" || parsed.Scheme == "ws")) ||
		(port == "443" && (parsed.Scheme == "https" || parsed.Scheme == "wss")) {
		host = strings.TrimSuffix(host, ":"+port)
	}
	return host == strings.ToLower(r.Host)
}

func (l *Listener) serveRelay(w http.ResponseWriter, r *http.Request) error {
	if !sameHost(r) {
		return fail(http.StatusForbidden, "Cross-origin requests are denied.")
	}
	if l.handshakes.Add(1) > 32 {
		l.handshakes.Add(-1)
		return fail(http.StatusServiceUnavailable, "Too many connections are joining.")
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	conn, err := acceptWebSocket(w, r, relayReadLimit)
	if err != nil {
		l.handshakes.Add(-1)
		var refused *HTTPError
		if errors.As(err, &refused) {
			return err
		}
		return nil //nolint:nilerr // the connection was hijacked and is gone; no response is possible
	}
	l.sockets.Add(1)
	go l.runRelay(context.WithoutCancel(r.Context()), conn)
	return nil
}

func (l *Listener) runRelay(parent context.Context, ws *wsConn) {
	defer l.sockets.Done()
	defer func() {
		if failure := recover(); failure != nil {
			log.Printf("relay socket: %v", failure)
			ws.CloseNow()
		}
	}()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	context.AfterFunc(ctx, ws.CloseNow)
	c := newRelayConn(ws, cancel)
	handshaking := true
	endHandshake := func() {
		if handshaking {
			handshaking = false
			l.handshakes.Add(-1)
		}
	}
	defer endHandshake()
	// Until it has a seat, a connection has no room to close it at shutdown.
	pendingKey := &cancel
	l.pending.Store(pendingKey, cancel)
	defer l.pending.Delete(pendingKey)
	helloTimer := time.AfterFunc(relayHelloWait, cancel)
	defer helloTimer.Stop()

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		c.write(ctx)
	}()
	go c.watch(ctx)
	for {
		kind, data, err := ws.Read(ctx)
		if err != nil {
			break
		}
		if kind != opBinary || c.closed() {
			continue // the protocol is binary; and a closing connection is done
		}
		c.lastRx.Store(time.Now().UnixNano())
		if c.room == nil {
			if len(data) == 0 || data[0] != 0 {
				continue // a frame of another kind, even before HELLO
			}
			if l.hello(c, data); c.room != nil {
				helloTimer.Stop()
				l.pending.Delete(pendingKey)
				endHandshake()
			}
			continue
		}
		c.room.touch()
		if code := c.room.relay.frame(c, data); code != 0 {
			c.closeWith(code)
		}
	}
	cancel()
	<-writerDone
	ws.CloseNow()
	if c.room != nil {
		c.room.relay.gone(c, ws.PeerCloseCode())
	}
}

// watch drops a connection that went quiet: zirbel-net pings every second.
func (c *relayConn) watch(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if c.silentFor() > relayIdle {
			c.drop()
			return
		}
	}
}

// hello reads a connection's first frame: HELLO, which names the room and the
// key of its game, and the seat to resume. What follows it in the frame is
// ignored; a frame that doesn't start with a whole HELLO ends the connection.
func (l *Listener) hello(c *relayConn, data []byte) {
	cursor := relayCursor{frame: data, pos: 1}
	if !cursor.next() || cursor.kind != relayHello {
		c.closeWith(closePolicy)
		return
	}
	in := relayReader{b: cursor.payload}
	if version := in.u8(); version != relayVersion {
		c.refuse(relayBadVersion, "protocol v"+strconv.Itoa(int(version))+" not supported, this host speaks v2")
		return
	}
	game, name, key, token, nonce := in.str(), in.str(), in.str(), in.str(), in.str()
	if in.overrun() || !relayName.MatchString(game) || !relayName.MatchString(name) {
		c.refuse(relayBadName, "bad game or room name")
		return
	}
	room, err := l.room(strings.ToLower(name))
	if err != nil || !isNet(room.Release.Manifest.Simulation) || !same(key, room.DocumentKey) {
		c.refuse(relayDenied, "no game with that code is running")
		return
	}
	if code, why := room.relay.join(c, token, nonce, room.capacity("player")); code != 0 {
		c.refuse(code, why)
		return
	}
	c.room = room
	room.touch()
}
