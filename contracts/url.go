package contracts

import (
	"errors"
	"math"
	"net/netip"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Trim is JavaScript's String.prototype.trim. Its white space differs from
// unicode.IsSpace: U+FEFF is white space and U+0085 is not.
func Trim(s string) string { return strings.TrimFunc(s, jsSpace) }

func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// URL is what the pinned Zod's url check makes of a string.
type URL struct {
	Value       string // the string Zod keeps: trimmed, without ASCII tabs and newlines
	Credentials bool   // whether new URL(Value) has a username or a password
}

// ParseURL mirrors z.string().url(): it trims the string and accepts it where
// the WHATWG URL parser (new URL) does. It follows that parser exactly for
// http, https, ws, wss and ftp URLs with ASCII hosts. It accepts hosts with
// non-ASCII or punycode labels without IDNA validation, and URLs with other
// schemes once the scheme is well formed.
func ParseURL(raw string) (URL, bool) {
	value := strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(Trim(raw))
	// The parser also drops leading and trailing C0 controls and spaces.
	input := strings.TrimFunc(value, func(r rune) bool { return r <= ' ' })
	colon := strings.IndexByte(input, ':')
	if colon < 1 || !validScheme(input[:colon]) {
		return URL{}, false
	}
	switch strings.ToLower(input[:colon]) {
	case "http", "https", "ws", "wss", "ftp":
	default:
		return URL{Value: value}, true
	}
	rest := strings.TrimLeft(input[colon+1:], `/\`)
	authority := rest
	if end := strings.IndexAny(rest, `/\?#`); end >= 0 {
		authority = rest[:end]
	}
	credentials := false
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		user, password, _ := strings.Cut(authority[:at], ":")
		credentials, authority = user != "" || password != "", authority[at+1:]
	}
	host, port := splitPort(authority)
	if host == "" || !validPort(port) || !validHost(host) {
		return URL{}, false
	}
	return URL{value, credentials}, true
}

func validScheme(scheme string) bool {
	// A letter first, then letters, digits, "+", "-" and ".".
	for i, c := range []byte(scheme) {
		alpha := (c|0x20) >= 'a' && (c|0x20) <= 'z'
		other := c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.'
		if !alpha && (i == 0 || !other) {
			return false
		}
	}
	return true
}

// splitPort splits at the first colon outside IPv6 brackets.
func splitPort(authority string) (host, port string) {
	inside := false
	for i := 0; i < len(authority); i++ {
		switch authority[i] {
		case '[':
			inside = true
		case ']':
			inside = false
		case ':':
			if !inside {
				return authority[:i], authority[i+1:]
			}
		}
	}
	return authority, ""
}

func validPort(port string) bool {
	if port == "" {
		return true
	}
	n, err := strconv.ParseUint(port, 10, 64)
	return err == nil && n <= math.MaxUint16
}

func validHost(host string) bool {
	if strings.HasPrefix(host, "[") {
		address, err := netip.ParseAddr(strings.TrimSuffix(host[1:], "]"))
		return strings.HasSuffix(host, "]") && err == nil && address.Is6() && address.Zone() == ""
	}
	domain := percentDecode(host)
	if !utf8.ValidString(domain) {
		return false
	}
	domain = strings.ToLower(domain)
	// Forbidden domain code points: C0 controls, space, DEL and these.
	if strings.ContainsAny(domain, "#%/:<>?@[\\]^|\x7f") || strings.IndexFunc(domain, func(r rune) bool { return r <= ' ' }) >= 0 {
		return false
	}
	return !endsInNumber(domain) || validIPv4(domain)
}

func percentDecode(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if b, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				out = append(out, byte(b))
				i += 2
				continue
			}
		}
		out = append(out, s[i])
	}
	return string(out)
}

// ipv4Labels splits a host into its dot-separated parts, without a trailing empty one.
func ipv4Labels(host string) []string {
	parts := strings.Split(host, ".")
	if len(parts) > 1 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts
}

// endsInNumber decides whether the host is parsed as an IPv4 address.
func endsInNumber(host string) bool {
	parts := ipv4Labels(host)
	last := parts[len(parts)-1]
	if last == "" {
		return false
	}
	_, number := ipv4Number(last)
	return strings.Trim(last, "0123456789") == "" || number
}

// ipv4Number parses a decimal, octal (leading 0) or hex (0x) IPv4 part.
// A part too large for 64 bits is still a number, larger than any limit.
func ipv4Number(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	radix := 10
	switch {
	case len(s) >= 2 && (s[:2] == "0x" || s[:2] == "0X"):
		s, radix = s[2:], 16
	case len(s) >= 2 && s[0] == '0':
		s, radix = s[1:], 8
	}
	if s == "" {
		return 0, true
	}
	n, err := strconv.ParseUint(s, radix, 64)
	if errors.Is(err, strconv.ErrRange) {
		return math.MaxUint64, true
	}
	return n, err == nil
}

func validIPv4(host string) bool {
	parts := ipv4Labels(host)
	if len(parts) > 4 {
		return false
	}
	for i, part := range parts {
		n, ok := ipv4Number(part)
		if !ok || (i < len(parts)-1 && n > 255) || (i == len(parts)-1 && n >= 1<<(8*(5-len(parts)))) {
			return false
		}
	}
	return true
}
