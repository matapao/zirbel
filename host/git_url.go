package main

import (
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"unicode/utf8"

	"zirbel/contracts"
)

// A source's address as the host fetches it, mirroring sourceUrl in
// packages/core/git-source.ts: https, public (no user name or password), no
// query or fragment, written as new URL(address).href writes it. Tests alone
// also give file: URLs and http on loopback (localSources).

var (
	errSourceAddress     = fail(http.StatusBadRequest, "Give the repository’s https:// address.")
	errSourceCredentials = fail(http.StatusBadRequest, "The host imports public repositories only: give the address without a user name or password.")
	errSourceQuery       = fail(http.StatusBadRequest, "Give the repository’s address without a query or fragment.")
)

// sourceURL is the address the host fetches a source from, or why it won't.
func sourceURL(input string) (string, error) {
	// The URL parser drops leading and trailing C0 controls and spaces, and every tab and newline.
	text := strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(strings.TrimFunc(input, func(r rune) bool { return r <= ' ' }))
	scheme, rest, found := strings.Cut(text, ":")
	scheme = strings.ToLower(scheme)
	if !found {
		return "", errSourceAddress
	}
	rest, fragment, hasFragment := strings.Cut(rest, "#")
	rest, query, hasQuery := strings.Cut(rest, "?")
	var href string
	switch scheme {
	case "https", "http":
		parsed, ok := contracts.ParseURL(text)
		if !ok {
			return "", errSourceAddress
		}
		host, credentials, path, ok := specialParts(rest, scheme)
		if !ok {
			return "", errSourceAddress
		}
		loopback := host == "127.0.0.1" || host == "localhost" || host == "[::1]"
		if scheme == "http" && (!localSources() || !loopback) {
			return "", errSourceAddress
		}
		if credentials || parsed.Credentials {
			return "", errSourceCredentials
		}
		href = scheme + "://" + host + path
	case "file":
		if !localSources() {
			return "", errSourceAddress
		}
		host, path := "", strings.ReplaceAll(rest, `\`, "/")
		if after, ok := strings.CutPrefix(path, "//"); ok {
			end := strings.IndexByte(after, '/')
			if end < 0 {
				end = len(after)
			}
			host, path = strings.ToLower(after[:end]), after[end:]
			if host == "localhost" {
				host = ""
			}
		}
		href = "file://" + host + normalizedPath(path)
	default:
		return "", errSourceAddress
	}
	if query != "" || fragment != "" {
		return "", errSourceQuery
	}
	if hasQuery {
		href += "?"
	}
	if hasFragment {
		href += "#"
	}
	return href, nil
}

// specialParts reads an http or https URL's authority and path: its host as
// the URL standard writes it (lowercase, with a port other than the scheme's
// own), whether it carries credentials, and its path.
func specialParts(rest, scheme string) (host string, credentials bool, path string, ok bool) {
	rest = strings.TrimLeft(rest, `/\`)
	authority := rest
	if end := strings.IndexAny(rest, `/\`); end >= 0 {
		authority, path = rest[:end], rest[end:]
	}
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		user, password, _ := strings.Cut(authority[:at], ":")
		credentials, authority = user != "" || password != "", authority[at+1:]
	}
	host, port := authority, ""
	if colon := strings.LastIndexByte(authority, ':'); colon >= 0 && !strings.HasSuffix(authority, "]") {
		host, port = authority[:colon], authority[colon+1:]
	}
	host = strings.ToLower(host)
	if strings.HasPrefix(host, "[") {
		address, err := netip.ParseAddr(strings.Trim(host, "[]"))
		if err != nil || !address.Is6() {
			return "", false, "", false
		}
		host = "[" + ipv6Text(address) + "]"
	}
	// Hosts the URL standard would rewrite otherwise (non-ASCII, percent-encoded) aren't taken.
	for i := 0; i < len(host); i++ {
		if c := host[i]; c >= utf8.RuneSelf || c == '%' {
			return "", false, "", false
		}
	}
	if host == "" {
		return "", false, "", false
	}
	if address, ok := contracts.IPv4(host); ok {
		host = address
	}
	if port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 0 || number > 65535 {
			return "", false, "", false
		}
		if own := (scheme == "https" && number == 443) || (scheme == "http" && number == 80); !own {
			host += ":" + strconv.Itoa(number)
		}
	}
	return host, credentials, normalizedPath(strings.ReplaceAll(path, `\`, "/")), true
}

// ipv6Text is an IPv6 address as the URL standard writes it: in hexadecimal
// pieces throughout, where netip writes an IPv4-mapped one's last two as an
// IPv4 address (::ffff:1.2.3.4 is ::ffff:102:304).
func ipv6Text(address netip.Addr) string {
	if !address.Is4In6() {
		return address.String()
	}
	four := address.As4()
	return "::ffff:" + strconv.FormatUint(uint64(four[0])<<8|uint64(four[1]), 16) + ":" +
		strconv.FormatUint(uint64(four[2])<<8|uint64(four[3]), 16)
}

// normalizedPath is a URL's path as the URL standard writes it: its dot
// segments resolved, and the path percent-encode set encoded.
func normalizedPath(path string) string {
	segments := []string{}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for i, part := range parts {
		last := i == len(parts)-1
		switch strings.ToLower(part) {
		case ".", "%2e":
			if last {
				segments = append(segments, "")
			}
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(segments) > 0 {
				segments = segments[:len(segments)-1]
			}
			if last {
				segments = append(segments, "")
			}
		default:
			segments = append(segments, encodePath(part))
		}
	}
	return "/" + strings.Join(segments, "/")
}

func encodePath(segment string) string {
	var out strings.Builder
	for i := 0; i < len(segment); i++ {
		c := segment[i]
		if c < 0x21 || c > 0x7e || strings.IndexByte("\"#<>?`{}", c) >= 0 {
			out.WriteString("%" + strings.ToUpper(strconv.FormatUint(uint64(c)>>4, 16)+strconv.FormatUint(uint64(c)&15, 16)))
		} else {
			out.WriteByte(c)
		}
	}
	return out.String()
}

// decodeURIComponent is JavaScript's: false where it would throw.
func decodeURIComponent(text string) (string, bool) {
	var out []byte
	for i := 0; i < len(text); i++ {
		if text[i] != '%' {
			out = append(out, text[i])
			continue
		}
		if i+2 >= len(text) {
			return "", false
		}
		value, err := strconv.ParseUint(text[i+1:i+3], 16, 8)
		if err != nil {
			return "", false
		}
		out = append(out, byte(value))
		i += 2
	}
	return string(out), utf8.Valid(out)
}
