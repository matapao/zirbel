package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"zirbel/contracts"
)

// /pads on every player listener, mirroring packages/server/pads-socket.ts:
// the WebSocket screens and phones open. Text frames carry JSON control
// messages, binary frames pad state; pads.go routes between them.

const (
	padsMessageLimit = 1024             // one control message
	padsPing         = 10 * time.Second // screens are pinged; one that misses its pong is dropped
	padsSilence      = 10 * time.Second // a phone that sends nothing this long is dropped (it sends at 4 Hz while still)
	padsFrameBacklog = 64 << 10         // pad frames to a reader this far behind are dropped
	padsBacklog      = 256 << 10        // a reader of control messages this far behind is dropped
)

var padPlaceQuery = regexp.MustCompile(`^[0-7]$`)

// padConn is one /pads socket. Its writer sends queued messages in order, so
// the pads never wait on a slow reader.
type padConn struct {
	ws     *wsConn
	drop   context.CancelFunc
	wake   chan struct{}
	lastRx atomic.Int64

	mu      sync.Mutex
	queue   []padOut
	pending int
	closing int
}
type padOut struct {
	data   []byte
	binary bool
}

func newPadConn(ws *wsConn, drop context.CancelFunc) *padConn {
	c := &padConn{ws: ws, drop: drop, wake: make(chan struct{}, 1)}
	c.lastRx.Store(time.Now().UnixNano())
	return c
}

func (c *padConn) text(message any) {
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	c.push(data, false)
}
func (c *padConn) binary(frame []byte) { c.push(frame, true) }
func (c *padConn) push(data []byte, binary bool) {
	c.mu.Lock()
	if c.closing != 0 || binary && c.pending > padsFrameBacklog {
		c.mu.Unlock()
		return
	}
	if c.pending > padsBacklog {
		c.mu.Unlock()
		c.drop()
		return
	}
	c.queue = append(c.queue, padOut{data, binary})
	c.pending += len(data)
	c.mu.Unlock()
	c.signal()
}

// close sends the close frame with code once the queued messages are out.
func (c *padConn) close(code int) {
	c.mu.Lock()
	if c.closing == 0 {
		c.closing = code
	}
	c.mu.Unlock()
	c.signal()
}
func (c *padConn) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *padConn) write(ctx context.Context) {
	for {
		c.mu.Lock()
		if len(c.queue) > 0 {
			out := c.queue[0]
			c.queue[0] = padOut{}
			c.queue = c.queue[1:]
			c.pending -= len(out.data)
			c.mu.Unlock()
			write := c.ws.Write
			if out.binary {
				write = c.ws.WriteBinary
			}
			if err := write(out.data, time.Now().Add(10*time.Second)); err != nil {
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

func (l *Listener) servePads(w http.ResponseWriter, r *http.Request) error {
	// Pages of this listener open it; a game's opaque-origin frame never does.
	if r.Header.Get("Origin") == "null" || !sameHost(r) {
		return fail(http.StatusForbidden, "Cross-origin requests are denied.")
	}
	query := r.URL.Query()
	role := query.Get("role")
	if role != "screen" && role != "pad" {
		return fail(http.StatusBadRequest, "Open the pads socket as a screen or a pad.")
	}
	if l.config.pads == nil {
		return fail(http.StatusNotFound, "Player route does not exist.")
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	ws, err := acceptWebSocket(w, r, padsMessageLimit)
	if err != nil {
		var refused *HTTPError
		if errors.As(err, &refused) {
			return err
		}
		return nil //nolint:nilerr // the connection was hijacked and is gone; no response is possible
	}
	l.sockets.Add(1)
	go l.runPads(context.WithoutCancel(r.Context()), ws, role == "screen", query.Get, remoteAddress(r))
	return nil
}

func (l *Listener) runPads(parent context.Context, ws *wsConn, screen bool, query func(string) string, address string) {
	defer l.sockets.Done()
	defer func() {
		if failure := recover(); failure != nil {
			log.Printf("pads socket: %v", failure)
			ws.CloseNow()
		}
	}()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	context.AfterFunc(ctx, ws.CloseNow)
	c := newPadConn(ws, cancel)
	// No room closes a pads socket at shutdown: Wait drops it with those still joining.
	pendingKey := &cancel
	l.pending.Store(pendingKey, cancel)
	defer l.pending.Delete(pendingKey)
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		c.write(ctx)
	}()
	pads := l.config.pads
	if screen {
		if held := pads.OpenScreen(c, l.access(), isLoopbackAddress(address), query("resume")); held != nil {
			go c.heartbeat(ctx)
			c.read(ctx, func(kind byte, data []byte) {
				if kind == opBinary {
					c.close(padsUnsupported) // a screen sends no pad frames
				} else if message, ok := padMessage(c, "pads-screen", data, &padsScreenMessage{}); ok {
					pads.ScreenMessage(held, c, *message)
				}
			})
			pads.ScreenGone(held, c, ws.PeerCloseCode())
		} else {
			c.read(ctx, func(byte, []byte) {}) // for the peer's answer to the refusal
		}
	} else {
		var asked *int
		if place := query("place"); padPlaceQuery.MatchString(place) {
			number, _ := strconv.Atoi(place)
			asked = &number
		}
		if phone := pads.OpenPad(c, l.access(), address, query("code"), asked, query("resume")); phone != nil {
			go c.watch(ctx)
			c.read(ctx, func(kind byte, data []byte) {
				if kind == opBinary {
					pads.PadFrame(phone, data)
				} else if message, ok := padMessage(c, "pads-pad", data, &struct {
					Place int `json:"place"`
				}{}); ok {
					pads.PadMessage(phone, message.Place)
				}
			})
			pads.PadGone(phone)
		} else {
			c.read(ctx, func(byte, []byte) {})
		}
	}
	// A close the host began goes out, and the peer's answer is read, before the end.
	c.mu.Lock()
	closing := c.closing != 0
	c.mu.Unlock()
	if closing {
		select {
		case <-writerDone:
		case <-time.After(2 * time.Second):
		}
	}
	cancel()
	<-writerDone
	ws.CloseNow()
}

// read hands each message to handle until the socket ends; after the host
// closes it, it reads on only for the peer's close frame.
func (c *padConn) read(ctx context.Context, handle func(kind byte, data []byte)) {
	for {
		kind, data, err := c.ws.Read(ctx)
		if err != nil {
			return
		}
		c.lastRx.Store(time.Now().UnixNano())
		c.mu.Lock()
		closing := c.closing != 0
		c.mu.Unlock()
		if !closing {
			handle(kind, data)
		}
	}
}

// message reads a control message by its contract into out, or closes the
// socket: 1007 for one that isn't JSON, 1008 for one that isn't a message.
func padMessage[T any](c *padConn, contract string, data []byte, out *T) (*T, bool) {
	value, err := contracts.Decode(data)
	if err != nil {
		c.close(closeInvalidData)
		return nil, false
	}
	if contracts.Validate(contract, value) != nil || contracts.Unmarshal(value, out) != nil {
		c.close(closePolicy)
		return nil, false
	}
	return out, true
}

// heartbeat drops a screen that misses a pong.
func (c *padConn) heartbeat(ctx context.Context) {
	ticker := time.NewTicker(padsPing)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		ping, done := context.WithTimeout(ctx, padsPing)
		err := c.ws.Ping(ping)
		done()
		if err != nil {
			c.drop()
			return
		}
	}
}

// watch drops a phone that went quiet.
func (c *padConn) watch(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if time.Duration(time.Now().UnixNano()-c.lastRx.Load()) > padsSilence {
			c.drop()
			return
		}
	}
}

// sameHost is a socket's origin check, as upgradeOrigin in
// packages/server/http.ts: a page on this listener's own host, or a page in an
// opaque-origin sandbox ("null"), or a program, which sends none.
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
