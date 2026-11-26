package main

import (
	"errors"
	"net/netip"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"

	"zirbel/contracts"
)

// dottedDecimal is an IPv4 address as the URL standard writes one.
var dottedDecimal = regexp.MustCompile(`^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$`)

// A source address the host takes is one it fetches as it is: https, no
// credentials, query or fragment, its host and path as new URL().href writes
// them, and the same address again when it is given back.
func FuzzSourceURL(f *testing.F) {
	for _, seed := range []string{"https://GitHub.com/owner/game.git", " https://example.org:443/a/./b/../c ", "https://example.org/a b/<c>",
		"HTTPS:\\\\example.org\\games\\x.git", "https://[0:0:0:0:0:0:0:1]/x.git", "https://[::ffff:1.2.3.4]:8443/x", "https://0x7f.1/x.git",
		"https://010.0.0.1./", "https://user:secret@example.org/x.git", "https://@example.org/x?", "https://example.org/x.git#main",
		"https://example.org/%E2%9C%93/%2e%2E/ü.git", "http://127.0.0.1/x.git", "file:///tmp/x.git", "https://ex%41mple.org/"} {
		f.Add(seed)
	}
	f.Setenv("ZIRBEL_GIT_ALLOW_LOCAL", "") // https alone, as every host fetches outside tests
	f.Fuzz(func(t *testing.T, input string) {
		address, err := sourceURL(input)
		if again, againErr := sourceURL(input); again != address || !errors.Is(againErr, err) {
			t.Fatalf("%q: %q, then %q", input, address, again)
		}
		if err != nil {
			if !errors.Is(err, errSourceAddress) && !errors.Is(err, errSourceCredentials) && !errors.Is(err, errSourceQuery) {
				t.Fatalf("%q: %v", input, err)
			}
			return
		}
		if parsed, ok := contracts.ParseURL(input); !ok || parsed.Credentials {
			t.Fatalf("%q, which new URL() refuses or that carries credentials, was taken as %q", input, address)
		}
		rest, https := strings.CutPrefix(address, "https://")
		end := strings.IndexByte(rest, '/')
		if !https || end < 0 {
			t.Fatalf("%q was taken as %q", input, address)
		}
		host, path := rest[:end], rest[end:]
		if name, port, found := strings.Cut(host, "]:"); found {
			host = name + "]"
			if port == "443" || port == "" || strings.HasPrefix(port, "0") && port != "0" {
				t.Fatalf("%q: the port in %q", input, address)
			}
		} else if name, port, found := strings.Cut(host, ":"); found && !strings.HasPrefix(host, "[") {
			host = name
			if port == "443" || port == "" || strings.HasPrefix(port, "0") && port != "0" {
				t.Fatalf("%q: the port in %q", input, address)
			}
		}
		if host == "" || strings.ContainsAny(host, "@%/\\?#") || host != strings.ToLower(host) {
			t.Fatalf("%q: the host in %q", input, address)
		}
		if ip, ok := contracts.IPv4(host); ok && (ip != host || !dottedDecimal.MatchString(host)) {
			t.Fatalf("%q: an IPv4 address the URL standard writes as %s, in %q", input, ip, address)
		}
		if inner, bracketed := strings.CutPrefix(host, "["); bracketed {
			ip, err := netip.ParseAddr(strings.TrimSuffix(inner, "]"))
			if err != nil || !ip.Is6() || strings.Contains(inner, ".") {
				t.Fatalf("%q: the IPv6 address in %q", input, address)
			}
		}
		// The path percent-encode set encoded, and at most a bare ? and # after it.
		path = strings.TrimSuffix(strings.TrimSuffix(path, "#"), "?")
		if strings.ContainsFunc(path, func(r rune) bool { return r < 0x21 || r > 0x7e || strings.ContainsRune("\"#<>?`{}\\", r) }) {
			t.Fatalf("%q: the path in %q", input, address)
		}
		for segment := range strings.SplitSeq(path, "/") {
			switch strings.ToLower(segment) {
			case ".", "..", "%2e", ".%2e", "%2e.", "%2e%2e":
				t.Fatalf("%q: a dot segment in %q", input, address)
			}
		}
		if again, err := sourceURL(address); again != address || err != nil {
			t.Fatalf("%q was taken as %q, and that as %q (%v)", input, address, again, err)
		}
		title := sourceTitle(address)
		if title == "" || contracts.Trim(title) != title || utf8.RuneCountInString(title) > 80 || !utf8.ValidString(title) {
			t.Fatalf("%q: the title %q", address, title)
		}
	})
}
