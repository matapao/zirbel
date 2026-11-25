package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

// LANAddresses mirrors lanAddresses in packages/server/http.ts.
func LANAddresses() []string {
	addresses := []string{}
	interfaces, _ := net.Interfaces()
	for _, item := range interfaces {
		if item.Flags&net.FlagUp == 0 || item.Flags&net.FlagLoopback != 0 {
			continue
		}
		list, _ := item.Addrs()
		for _, address := range list {
			network, ok := address.(*net.IPNet)
			if !ok || network.IP.To4() == nil {
				continue
			}
			if ip := network.IP.To4().String(); lanAddress.MatchString(ip) {
				addresses = append(addresses, ip)
			}
		}
	}
	return addresses
}
func typeFor(name string) string {
	switch path.Ext(name) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js":
		return "application/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".txt":
		return "text/plain; charset=utf-8"
	case ".wasm":
		return "application/wasm"
	}
	return "application/octet-stream"
}

// secure mirrors secure in packages/server/http.ts.
func secure(w http.ResponseWriter) {
	w.Header().Set("x-content-type-options", "nosniff")
	w.Header().Set("referrer-policy", "no-referrer")
}
func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func replyError(w http.ResponseWriter, err error) {
	var known *HTTPError
	if errors.As(err, &known) {
		reply(w, known.Status, map[string]string{"error": known.Message})
		return
	}
	log.Print(err)
	reply(w, http.StatusInternalServerError, map[string]string{"error": "The server could not complete that request."})
}

// send answers with value unless the operation failed.
func send(w http.ResponseWriter, status int, value any, err error) error {
	if err == nil {
		reply(w, status, value)
	}
	return err
}
func bytesReply(w http.ResponseWriter, body []byte, contentType string, headers map[string]string) {
	w.Header().Set("content-type", contentType)
	w.Header().Set("cache-control", "no-store")
	for key, value := range headers {
		w.Header().Set(key, value)
	}
	w.WriteHeader(http.StatusOK)
	// Not XSS: a fixed content type, nosniff and a CSP go with every body; HTML here is the runtime or a sandboxed game.
	// nosemgrep: go.lang.security.audit.xss.no-direct-write-to-responsewriter.no-direct-write-to-responsewriter
	_, _ = w.Write(body)
}

// readBody mirrors body() in packages/server/http.ts.
func readBody(r *http.Request, max int64) ([]byte, error) {
	if media, _, _ := mime.ParseMediaType(r.Header.Get("content-type")); media != "application/json" {
		return nil, fail(http.StatusUnsupportedMediaType, "Send application/json.")
	}
	if r.ContentLength > max {
		return nil, fail(http.StatusRequestEntityTooLarge, "This file exceeds the upload limit.")
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return nil, fail(http.StatusBadRequest, "Invalid JSON.")
	}
	if int64(len(data)) > max {
		return nil, fail(http.StatusRequestEntityTooLarge, "This file exceeds the upload limit.")
	}
	if !json.Valid(data) {
		return nil, fail(http.StatusBadRequest, "Invalid JSON.")
	}
	return data, nil
}
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("accept-encoding"), ",") {
		if strings.TrimSpace(strings.SplitN(part, ";", 2)[0]) == "gzip" {
			return true
		}
	}
	return false
}
func bearer(r *http.Request) string {
	return strings.TrimPrefix(r.Header.Get("authorization"), "Bearer ")
}

// checkHost mirrors requestUrl in packages/server/http.ts: the Host header must
// name this listener, which is what stops DNS rebinding.
func checkHost(r *http.Request, port int, hosts []string) error {
	for _, host := range hosts {
		if r.Host == host+":"+strconv.Itoa(port) || (port == 80 && r.Host == host) {
			if !strings.HasPrefix(r.RequestURI, "/") || strings.HasPrefix(r.RequestURI, "//") {
				return fail(http.StatusBadRequest, "Invalid request URL.")
			}
			return nil
		}
	}
	return fail(http.StatusForbidden, "This host name is not configured.")
}

// checkOrigin mirrors checkOrigin in packages/server/http.ts: a browser must
// send this listener's own Origin. Without requireClient a request with no
// Origin comes from a local non-browser client and is trusted, unless
// Sec-Fetch-Mode shows a browser sent the POST.
func checkOrigin(r *http.Request, requireClient bool) error {
	origin := r.Header.Get("origin")
	host := strings.TrimSuffix(strings.ToLower(r.Host), ":80")
	_, fetchMode := r.Header["Sec-Fetch-Mode"]
	missing := origin == "" && (requireClient || (r.Method == http.MethodPost && fetchMode))
	if missing || (origin != "" && origin != "http://"+host) {
		return fail(http.StatusForbidden, "Cross-origin requests are denied.")
	}
	return nil
}

// loopback is the origin of a listener on this machine.
func loopback(port int) string { return "http://127.0.0.1:" + strconv.Itoa(port) }

// listenTCP4 mirrors listen in packages/server/http.ts and returns the port it
// got. tcp4: like Node, a 0.0.0.0 bind must not also accept IPv6, whose clients
// would fail the private-address check instead of falling back to IPv4. The
// context covers only the bind; the listener outlives it.
func listenTCP4(ctx context.Context, bind string, port int) (net.Listener, int, error) {
	socket, err := (&net.ListenConfig{}).Listen(ctx, "tcp4", net.JoinHostPort(bind, strconv.Itoa(port)))
	if err != nil {
		return nil, 0, err
	}
	address, ok := socket.Addr().(*net.TCPAddr)
	if !ok {
		_ = socket.Close()
		return nil, 0, errors.New("the listener has no TCP address")
	}
	return socket, address.Port, nil
}

// limitListener caps open connections like the Node host's maxConnections.
type limitListener struct {
	net.Listener
	slots chan struct{}
}
type limitedConn struct {
	net.Conn
	release func()
}

func (l *limitListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.slots <- struct{}{}:
			return l.wrap(conn), nil
		default:
			// Like Node's maxConnections: refuse at once instead of queueing.
			_ = conn.Close()
		}
	}
}
func (l *limitListener) wrap(conn net.Conn) net.Conn {
	var once sync.Once
	return &limitedConn{conn, func() { once.Do(func() { <-l.slots }) }}
}
func (c *limitedConn) Close() error {
	err := c.Conn.Close()
	c.release()
	return err
}
func roomLink(base string, room *Room) string {
	return base + "/join/" + room.ID + "#" + room.Invite
}
