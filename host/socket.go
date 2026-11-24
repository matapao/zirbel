package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"zirbel/contracts"
)

// socketPeer queues outgoing messages so rooms never block on a slow client.
// slowClientBytes matches the Node host's bufferedAmount limit.
const slowClientBytes = 256_000

// roomMessageLimit bounds one client message: a 4096-unit state can need about
// 12.3 KB of UTF-8 inside its envelope.
const roomMessageLimit = 16_384

type socketPeer struct {
	out    chan outgoing
	queued atomic.Int64 // bytes waiting in out
	closed atomic.Bool
	drop   context.CancelFunc // ends the connection without a close frame
}
type outgoing struct {
	data   []byte
	close  int // a close code instead of a message
	reason string
}

func (p *socketPeer) Send(message []byte) {
	if p.closed.Load() {
		return
	}
	// Like the Node host's bufferedAmount limit: drop a client that cannot keep up.
	if p.queued.Add(int64(len(message))) > slowClientBytes {
		p.Close(1008)
		return
	}
	select {
	case p.out <- outgoing{data: message}:
	default:
		p.Close(1008)
	}
}
func (p *socketPeer) Close(code int) { p.closeWith(code, "") }

// closeWith queues the close frame behind any pending messages, so a client
// sees why it was refused before the connection ends.
func (p *socketPeer) closeWith(code int, reason string) {
	if p.closed.Swap(true) {
		return
	}
	select {
	case p.out <- outgoing{close: code, reason: reason}:
	default:
		p.drop()
	}
}
func (l *Listener) serveSocket(w http.ResponseWriter, r *http.Request, pathname string) error {
	match := socketPath.FindStringSubmatch(pathname)
	if match == nil {
		return fail(http.StatusNotFound, "Room socket does not exist.")
	}
	if err := checkOrigin(r, true); err != nil {
		return err
	}
	room, err := l.room(match[1])
	if err != nil {
		return err
	}
	if l.handshakes.Add(1) > 32 {
		l.handshakes.Add(-1)
		return fail(http.StatusServiceUnavailable, "Too many connections are joining.")
	}
	// The server's request deadlines would outlive the upgrade; a room socket stays open.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	// The origin was checked above against this listener's own host.
	conn, err := acceptWebSocket(w, r, roomMessageLimit)
	if err != nil {
		l.handshakes.Add(-1)
		var refused *HTTPError
		if errors.As(err, &refused) {
			return err // nothing was taken over yet, so answer with the status
		}
		return nil //nolint:nilerr // the connection was hijacked and is gone; no response is possible
	}
	l.sockets.Add(1)
	// A room socket outlives its upgrade request, so it must not end with it.
	go l.runSocket(context.WithoutCancel(r.Context()), conn, room)
	return nil
}
func (l *Listener) runSocket(parent context.Context, conn *wsConn, room *Room) {
	defer l.sockets.Done()
	// net/http recovers handler panics; this goroutine is ours, so one bad
	// connection must not stop the host.
	defer func() {
		if failure := recover(); failure != nil {
			log.Printf("room socket: %v", failure)
			conn.CloseNow()
		}
	}()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	// Ending the socket closes the connection, so a write stuck on a client
	// that stopped reading cannot hold the teardown until its deadline.
	context.AfterFunc(ctx, conn.CloseNow)
	peer := &socketPeer{out: make(chan outgoing, 1024), drop: cancel}
	handshaking := true
	endHandshake := func() {
		if handshaking {
			handshaking = false
			l.handshakes.Add(-1)
		}
	}
	defer endHandshake()

	// Writer: sends queued messages in order, then the close frame.
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		for {
			select {
			case <-ctx.Done():
				return
			case item := <-peer.out:
				if item.close != 0 {
					_ = conn.Close(item.close, item.reason)
					cancel()
					return
				}
				err := conn.Write(item.data, time.Now().Add(10*time.Second))
				peer.queued.Add(-int64(len(item.data)))
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	// Heartbeat: a client that misses a pong for 30 seconds is dropped.
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				pingCtx, done := context.WithTimeout(ctx, 30*time.Second)
				err := conn.Ping(pingCtx)
				done()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	handshakeTimer := time.AfterFunc(5*time.Second, cancel)
	defer handshakeTimer.Stop()
	// Until it has a seat, a socket has no room to close it at shutdown.
	pendingKey := &cancel
	l.pending.Store(pendingKey, cancel)
	defer l.pending.Delete(pendingKey)

	seatID := ""
	received, window := 0, time.Now()
	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		if time.Since(window) > time.Second {
			window, received = time.Now(), 0
		}
		received++
		if received > 60 || kind != opText {
			peer.closeWith(closePolicy, "Unsupported traffic")
			break
		}
		value, err := contracts.Decode(data)
		if err != nil {
			peer.closeWith(closeInvalidData, "Invalid JSON")
			break
		}
		if contracts.Validate("client-message", value) != nil {
			peer.Send(errorMessage("protocol", "Invalid message or protocol version."))
			if seatID == "" {
				peer.closeWith(closePolicy, "Protocol mismatch")
				break
			}
			continue
		}
		var message clientMessage
		_ = json.Unmarshal(data, &message)
		if seatID != "" {
			room.Message(seatID, peer, message)
			continue
		}
		if message.Type != "hello" {
			peer.closeWith(closePolicy, "Expected handshake")
			break
		}
		if seatID = room.Connect(hello{message.Credential, message.ReleaseID}, peer); seatID == "" {
			peer.closeWith(closePolicy, "Join failed")
			break
		}
		handshakeTimer.Stop()
		l.pending.Delete(pendingKey)
		endHandshake()
	}
	if peer.closed.Load() {
		// The writer flushes queued messages, sends the close frame and waits
		// for the client's reply, which only a reader can receive: keep
		// reading (and discarding) until it arrives or time runs out.
		drain, stop := context.WithTimeout(ctx, 2*time.Second)
		go func() {
			for {
				if _, _, err := conn.Read(drain); err != nil {
					return
				}
			}
		}()
		select {
		case <-writerDone:
		case <-drain.Done():
		}
		stop()
	}
	cancel()
	<-writerDone
	conn.CloseNow()
	if seatID != "" {
		room.Disconnected(seatID, peer)
	}
}
