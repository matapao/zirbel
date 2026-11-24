package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHostAndOriginChecks(t *testing.T) {
	request := func(method, host, origin string) *http.Request {
		r := httptest.NewRequestWithContext(t.Context(), method, "/api/health", http.NoBody)
		r.Host = host
		if origin != "" {
			r.Header.Set("origin", origin)
		}
		return r
	}
	hosts := []string{"127.0.0.1", "localhost"}
	for host, want := range map[string]bool{"127.0.0.1:4173": true, "localhost:4173": true, "127.0.0.1": false, "evil.example:4173": false} {
		if got := checkHost(request(http.MethodGet, host, ""), 4173, hosts) == nil; got != want {
			t.Errorf("host %q on port 4173: allowed %v, want %v", host, got, want)
		}
	}
	// On port 80 a browser leaves the port out of Host.
	for host, want := range map[string]bool{"127.0.0.1": true, "localhost:80": true, "evil.example": false} {
		if got := checkHost(request(http.MethodGet, host, ""), 80, hosts) == nil; got != want {
			t.Errorf("host %q on port 80: allowed %v, want %v", host, got, want)
		}
	}
	own, other := "http://127.0.0.1:4173", "http://evil.example"
	browserPost := request(http.MethodPost, "127.0.0.1:4173", "")
	browserPost.Header.Set("sec-fetch-mode", "cors")
	for name, check := range map[string]struct {
		request       *http.Request
		requireClient bool
		want          bool
	}{
		"own origin":                       {request(http.MethodPost, "127.0.0.1:4173", own), true, true},
		"another origin":                   {request(http.MethodPost, "127.0.0.1:4173", other), false, false},
		"a sandboxed frame":                {request(http.MethodPost, "127.0.0.1:4173", "null"), false, false},
		"no origin, players":               {request(http.MethodGet, "127.0.0.1:4173", ""), true, false},
		"no origin, local client":          {request(http.MethodPost, "127.0.0.1:4173", ""), false, true},
		"no origin, browser POST (editor)": {browserPost, false, false},
	} {
		if got := checkOrigin(check.request, check.requireClient) == nil; got != check.want {
			t.Errorf("%s: allowed %v, want %v", name, got, check.want)
		}
	}
}
