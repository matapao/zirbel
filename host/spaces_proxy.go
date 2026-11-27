package main

import (
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// /.skalet/* on the host's listeners, passed to the spaces kernel the host
// runs (spaces.go), mirroring packages/server/spaces-proxy.ts: its modules, its
// HTTP routes and the WebSocket at /.skalet/spaces. Each request goes with the
// kernel's token (x-skalet-proxy), the listener of skalet.json it came by
// (x-skalet-listener: player or editor), the host its page named
// (x-forwarded-host) and the address it came from (x-forwarded-for); whatever
// x-skalet-* or forwarding headers a client sent are dropped. The kernel checks
// the rest. Under a host that runs the kernel, its front answers these paths
// before the host sees them, so a request here then finds none.

const spacesUnavailable = "Multiplayer isn't available on this host now."

// isSpacesPath is one of the kernel's paths.
func isSpacesPath(pathname string) bool {
	return pathname == "/.skalet" || strings.HasPrefix(pathname, "/.skalet/")
}

// proxySpaces answers a request to /.skalet/*, or its WebSocket upgrade, with
// the kernel's answer.
func proxySpaces(spaces *Spaces, listener string, w http.ResponseWriter, r *http.Request) {
	address, token, ok := spaces.Target()
	if !ok {
		replyError(w, fail(http.StatusServiceUnavailable, spacesUnavailable))
		return
	}
	if strings.EqualFold(r.Header.Get("upgrade"), "websocket") {
		// The listener's deadlines are for requests; a socket lasts.
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Time{})
		_ = controller.SetWriteDeadline(time.Time{})
	}
	client, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		client = r.RemoteAddr
	}
	target := &url.URL{Scheme: "http", Host: strings.TrimPrefix(address, "http://")}
	proxy := &httputil.ReverseProxy{
		// Rewrite starts from a request without the client's X-Forwarded-* and hop-by-hop headers.
		Rewrite: func(out *httputil.ProxyRequest) {
			out.SetURL(target)
			out.Out.Host = target.Host
			for name := range out.Out.Header {
				lower := strings.ToLower(name)
				if strings.HasPrefix(lower, "x-skalet-") || lower == "forwarded" || lower == "x-real-ip" {
					out.Out.Header.Del(name)
				}
			}
			out.Out.Header.Set("x-skalet-proxy", token)
			out.Out.Header.Set("x-skalet-listener", listener)
			out.Out.Header.Set("x-forwarded-host", r.Host)
			out.Out.Header.Set("x-forwarded-for", plainAddress(client)) // an IPv4 address mapped into IPv6 as itself
			out.Out.Header.Set("x-forwarded-proto", "http")
		},
		// The kernel's own headers stand in for the listener's of the same name, as the Node host's do.
		ModifyResponse: func(response *http.Response) error {
			for name := range response.Header {
				w.Header().Del(name)
			}
			return nil
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			replyError(w, fail(http.StatusBadGateway, spacesUnavailable))
		},
	}
	proxy.ServeHTTP(w, r)
}
