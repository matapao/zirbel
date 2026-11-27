package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// A request to /.skalet/* as proxySpaces passes it to the kernel, as
// headersFor in packages/server/spaces-proxy.ts writes it: no x-skalet-* or
// forwarding header a client sent (kernelsOwn) reaches the kernel, which gets
// the host's own (its token, the listener, the host the page named, the
// address it came from, an IPv4 one without its ::ffff:, and http) and the
// client's other headers as they came, but the connection's own. A request
// with a header that can't be sent goes nowhere (502).
func FuzzSpacesProxy(f *testing.F) {
	kernel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(r.Header)
	}))
	f.Cleanup(kernel.Close)
	spaces := &Spaces{http: kernel.URL, token: "the-kernels-token"}
	for _, header := range [][2]string{{"X-Skalet-Proxy", "forged"}, {"x-skalet-listener", "editor"}, {"X-SKALET-ANYTHING", "1"},
		{"x-forwarded-for", "6.6.6.6"}, {"Forwarded", "for=6.6.6.6"}, {"X-Real-IP", "6.6.6.6"}, {"Accept", "text/javascript"},
		{"Connection", "x-skalet-proxy, Cookie"}, {"Cookie", "a=1"}, {"x-skalet-", ""}, {"Bad Name", "x"}, {"X-Value", "a\r\nb"}} {
		f.Add(header[0], header[1], "Origin", "http://zirbel.local:4174", "192.168.1.20:50000", "zirbel.local:4174")
	}
	f.Add("Accept", "*/*", "User-Agent", "a phone", "[::ffff:192.168.1.20]:50000", "")
	f.Add("Accept", "*/*", "Referer", "x", "[::ffff:0:c0a8:114]:50000", "192.168.1.2")
	f.Add("Accept", "*/*", "Referer", "x", "no port", "h")
	f.Fuzz(func(t *testing.T, name, value, other, otherValue, remote, host string) {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/.skalet/net.js", http.NoBody)
		r.RemoteAddr, r.Host, r.Header = remote, host, http.Header{}
		for _, header := range [][2]string{{name, value}, {other, otherValue}, {"X-Skalet-Proxy", "forged"}, {"X-Skalet-Listener", "editor"},
			{"Forwarded", "for=6.6.6.6"}, {"X-Real-Ip", "6.6.6.6"}, {"X-Forwarded-For", "6.6.6.6"}, {"X-Forwarded-Host", "evil"},
			{"X-Forwarded-Proto", "https"}} {
			r.Header.Add(header[0], header[1])
		}
		w := httptest.NewRecorder()
		proxySpaces(spaces, "player", w, r)
		if w.Code == http.StatusBadGateway {
			return
		}
		var got http.Header
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &got) != nil {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
		// The address it came from, as the Node host's regex /^::ffff:(?=\d+\.)/ leaves it.
		client, _, err := net.SplitHostPort(remote)
		if err != nil {
			client = remote
		}
		if rest, mapped := strings.CutPrefix(client, "::ffff:"); mapped {
			digits := len(rest) - len(strings.TrimLeft(rest, "0123456789"))
			if digits > 0 && digits < len(rest) && rest[digits] == '.' {
				client = rest
			}
		}
		// As the kernel's server reads a value (without the spaces around it) and this one writes it in JSON (valid UTF-8).
		sent := func(text string) []string { return []string{asSent(strings.Trim(text, " \t"))} }
		own := map[string][]string{"X-Skalet-Proxy": {"the-kernels-token"}, "X-Skalet-Listener": {"player"}, "X-Forwarded-Host": sent(host),
			"X-Forwarded-For": sent(client), "X-Forwarded-Proto": {"http"}}
		for key, values := range got {
			if mine, ok := own[key]; ok && !slices.Equal(values, mine) || !ok && kernelsOwn(key) {
				t.Fatalf("the kernel has %s: %q (the client sent %q)", key, values, r.Header)
			}
		}
		for key := range own {
			if _, ok := got[key]; !ok {
				t.Fatalf("the kernel has no %s: %q", key, got)
			}
		}
		// The client's other headers, but the connection's own and those its Connection names.
		hop := []string{"Connection", "Keep-Alive", "Proxy-Authorization", "Proxy-Authenticate", "Proxy-Connection", "Te", "Trailer",
			"Transfer-Encoding", "Upgrade", "Host", "Content-Length", "User-Agent"}
		for _, listed := range r.Header.Values("Connection") {
			for token := range strings.SplitSeq(listed, ",") {
				hop = append(hop, http.CanonicalHeaderKey(strings.Trim(token, " \t")))
			}
		}
		for key, values := range r.Header {
			if slices.Contains(hop, key) || kernelsOwn(key) {
				continue
			}
			for _, value := range values {
				if !slices.Contains(got[key], sent(value)[0]) {
					t.Fatalf("the client's %s: %q went as %q", key, value, got[key])
				}
			}
		}
	})
}

// kernelsOwn is a header only the host gives the kernel: x-skalet-* and those
// that say where a request came from.
func kernelsOwn(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasPrefix(lower, "x-skalet-") ||
		slices.Contains([]string{"forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"}, lower)
}
