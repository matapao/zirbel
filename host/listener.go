package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"zirbel/contracts"
	"zirbel/host/webfiles"
)

const immutable = "private, max-age=31536000, immutable"

var (
	privateAddress = regexp.MustCompile(`^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|169\.254\.|127\.)`)
	lanAddress     = regexp.MustCompile(`^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|169\.254\.)`)
	socketPath     = regexp.MustCompile(`^/rooms/([a-z0-9]+)/socket$`)
	doctype        = regexp.MustCompile(`(?i)^\s*<!doctype\s+html\s*>`)
)

type listenerConfig struct {
	lan           bool
	extraHosts    []string
	editorOrigins []string // may frame the local player (editor playtests)
	// box, on a box: the player answers the box's network by its names, and
	// the editor that may frame it is on the host name the device reached.
	box *playerReach
}

// playerReach mirrors PlayerReach in packages/server/player-listener.ts.
type playerReach struct {
	hosts         func() []string
	network       func(address string) bool
	editorOrigins func(host string) []string
}

// ancestors are the documents that may frame the player reached at host.
func (l *Listener) ancestors(host string) string {
	origins := l.config.editorOrigins
	if l.config.box != nil {
		origins = l.config.box.editorOrigins(host)
	}
	return strings.Join(append([]string{"'self'"}, origins...), " ")
}

// hostnameOf is a Host header's name as a URL's hostname has it: lowercase,
// without its port, an IPv6 address in its brackets.
func hostnameOf(host string) string {
	host = strings.ToLower(host)
	if strings.HasPrefix(host, "[") {
		if end := strings.Index(host, "]"); end > 0 {
			return host[:end+1]
		}
	}
	if colon := strings.LastIndex(host, ":"); colon >= 0 {
		return host[:colon]
	}
	return host
}

// Listener serves one player address, like playerListener in packages/server.
type Listener struct {
	rooms      *Rooms
	runtime    map[string]*webfiles.File
	config     listenerConfig
	port       int
	playerPage string
	handshakes atomic.Int32
	server     *http.Server
	sockets    sync.WaitGroup
	pending    sync.Map // *context.CancelFunc of sockets still in their handshake
}

func (l *Listener) hosts() []string {
	if l.config.box != nil {
		return l.config.box.hosts()
	}
	hosts := []string{"localhost", "127.0.0.1"}
	if l.config.lan {
		hosts = append(hosts, LANAddresses()...)
	}
	return append(hosts, l.config.extraHosts...)
}
func (l *Listener) localNetwork(r *http.Request) bool {
	if l.config.box != nil {
		return l.config.box.network(remoteAddress(r))
	}
	if !l.config.lan {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	return err == nil && privateAddress.MatchString(strings.TrimPrefix(host, "::ffff:"))
}
func (l *Listener) access() string {
	if l.config.lan {
		return "lan"
	}
	return "local"
}
func (l *Listener) room(id string) (*Room, error) {
	room, err := l.rooms.Get(id)
	if err != nil {
		return nil, err
	}
	if room.Access != l.access() {
		return nil, fail(http.StatusNotFound, "This room is unavailable on this listener.")
	}
	return room, nil
}
func (l *Listener) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	secure(w)
	if err := l.serve(w, r); err != nil {
		replyError(w, err)
	}
}
func (l *Listener) serve(w http.ResponseWriter, r *http.Request) error {
	if !l.localNetwork(r) {
		return fail(http.StatusForbidden, "LAN access requires a local network address.")
	}
	if err := checkHost(r, l.port, l.hosts()); err != nil {
		return err
	}
	pathname := r.URL.EscapedPath()
	if strings.EqualFold(r.Header.Get("upgrade"), "websocket") {
		return l.serveSocket(w, r, pathname)
	}
	if r.Method == http.MethodGet && pathname == "/health" {
		reply(w, http.StatusOK, map[string]string{"status": "ok", "role": "player"})
		return nil
	}
	segments := strings.Split(pathname, "/")
	route, roomID, parts := "", "", []string{}
	if len(segments) > 1 {
		route = segments[1]
	}
	if len(segments) > 2 {
		roomID, parts = segments[2], segments[3:]
	}
	if roomID == "" {
		return fail(http.StatusNotFound, "Open the invitation link from the host.")
	}
	room, err := l.room(roomID)
	if err != nil {
		return err
	}
	frame := "'none'"
	if !l.config.lan {
		frame = l.ancestors(hostnameOf(r.Host))
	}
	w.Header().Set("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"+
		// The LAN player is plain HTTP by design, so its room socket is ws: on this same host.
		// nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
		" connect-src 'self' ws://"+r.Host+"; frame-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors "+frame)
	get := r.Method == http.MethodGet
	switch {
	case route == "game" && get && len(parts) >= 1 && room.Release.Game != nil && same(parts[0], room.DocumentKey):
		return l.serveGame(w, r, room, strings.Join(parts[1:], "/"))
	case route == "join" && get && len(parts) == 0:
		// room.ID is a server-generated hex ID from the room table, not request input.
		// nosemgrep: go.lang.security.injection.raw-html-format.raw-html-format
		page := strings.Replace(l.playerPage, "<head>", `<head><base href="/runtime/`+room.ID+`/">`, 1)
		bytesReply(w, []byte(page), typeFor(".html"), nil)
		return nil
	case route == "rooms" && get && len(parts) == 1 && parts[0] == "info":
		if !room.MayView(bearer(r)) {
			return fail(http.StatusForbidden, "An invitation or current seat is required.")
		}
		info := struct {
			summary
			Scene           json.RawMessage `json:"scene,omitempty"`
			RegisterObjects *bool           `json:"registerObjects,omitempty"`
			GameURL         string          `json:"gameUrl,omitempty"`
		}{summary: room.Summary(), Scene: room.Release.SceneRaw}
		if game := room.Release.Game; game != nil {
			info.RegisterObjects = game.RegisterObjects
			info.GameURL = gamePath(room)
		}
		reply(w, http.StatusOK, info)
		return nil
	case route == "rooms" && r.Method == http.MethodPost && len(parts) == 1 && parts[0] == "reserve":
		return l.reserve(w, r, room)
	case route == "runtime" && get:
		return l.serveRuntime(w, r, parts)
	}
	return fail(http.StatusNotFound, "Player route does not exist.")
}
func (l *Listener) reserve(w http.ResponseWriter, r *http.Request, room *Room) error {
	if err := checkOrigin(r, true); err != nil {
		return err
	}
	data, err := readBody(r, 4096)
	if err != nil {
		return err
	}
	// The contract checks the name's length after Zod's trim.
	var input struct{ Invite, Name, Role string }
	if err := decodeContract("reserve", data, &input); err != nil {
		return err
	}
	key, err := room.Reserve(input.Invite, contracts.Trim(input.Name), input.Role)
	if err != nil {
		return err
	}
	reply(w, http.StatusCreated, map[string]string{"ticket": key})
	return nil
}
func (l *Listener) serveRuntime(w http.ResponseWriter, r *http.Request, parts []string) error {
	// Game assets are inlined as data URLs in the game page; only runtime files are served here.
	name := strings.Join(parts, "/")
	file := l.runtime[name]
	addon, isAddon := strings.CutPrefix(name, threeAddons)
	if isAddon {
		file = webfiles.Addon(addon)
	}
	if file == nil {
		return fail(http.StatusNotFound, "Runtime file does not exist.")
	}
	// The game's origin is opaque, so the modules and decoders it loads are CORS requests.
	if isAddon || name == "three.module.js" || name == "game-sdk.js" {
		w.Header().Set("access-control-allow-origin", "*")
	}
	header := w.Header()
	header.Set("content-type", typeFor(name))
	header.Set("cache-control", immutable)
	header.Set("etag", file.ETag)
	header.Set("vary", "accept-encoding")
	if r.Header.Get("if-none-match") == file.ETag {
		w.WriteHeader(http.StatusNotModified)
		return nil
	}
	body := file.Bytes
	if compressed := file.Gzip(); compressed != nil && acceptsGzip(r) {
		header.Set("content-encoding", "gzip")
		body = compressed
	}
	w.WriteHeader(http.StatusOK)
	// Not XSS: runtime files with their own content type, nosniff and a CSP.
	// nosemgrep: go.lang.security.audit.xss.no-direct-write-to-responsewriter.no-direct-write-to-responsewriter
	_, _ = w.Write(body) // #nosec G705 -- the request only picks which embedded runtime file to send
	return nil
}

// Listen starts a player listener on bind:port and returns it once it accepts.
func Listen(ctx context.Context, rooms *Rooms, runtime map[string]*webfiles.File, bind string, port int, config listenerConfig) (*Listener, error) {
	page := runtime["player.html"]
	if page == nil {
		return nil, errors.New("the player runtime is missing player.html")
	}
	socket, port, err := listenOn(ctx, bind, port)
	if err != nil {
		return nil, err
	}
	l := &Listener{rooms: rooms, runtime: runtime, config: config, port: port, playerPage: string(page.Bytes)}
	l.server = &http.Server{Handler: l, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 20 * time.Second, IdleTimeout: 5 * time.Second}
	go func() { _ = l.server.Serve(&limitListener{socket, make(chan struct{}, 256)}) }()
	return l, nil
}

// Wait drops sockets still in their handshake, then gives seated sockets (which
// the rooms have already told to close) up to the timeout to flush.
func (l *Listener) Wait(timeout time.Duration) {
	l.pending.Range(func(_, value any) bool {
		if cancel, ok := value.(context.CancelFunc); ok {
			cancel()
		}
		return true
	})
	done := make(chan struct{})
	go func() { l.sockets.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}

func (l *Listener) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if l.server.Shutdown(ctx) != nil {
		_ = l.server.Close()
	}
}
