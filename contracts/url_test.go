package contracts

import (
	"net/netip"
	"regexp"
	"strings"
	"testing"
)

// dottedDecimal is an IPv4 address as the URL standard writes one.
var dottedDecimal = regexp.MustCompile(`^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$`)

// A URL a contract holds (z.string().url()), as ParseURL reads it: the value it
// keeps is trimmed, without tabs or line breaks, with a well-formed scheme, and
// reads the same again; credentials are a user name or password before an @.
func FuzzParseURL(f *testing.F) {
	for _, seed := range []string{"https://example.com/50%off.png", "https://user:pass@example.com/", "https://:@example.com/", "https:example.com",
		`https:\\example.com\a`, "https://[::1]:8080/", "https://[fe80::1%25eth0]/", "https://0x7f.1/", "https://256.0.0.1/", "https://ex%41mple.com/",
		"https://b\u00fccher.example/", "mailto:someone", " \ufeffhttps://exa\nmple.com/ ", "HTTP://a@b@c/", "ws://h:0/", "1https://example.com/"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		url, ok := ParseURL(raw)
		if again, same := ParseURL(raw); again != url || same != ok {
			t.Fatalf("%q read twice reads otherwise", raw)
		}
		if !ok {
			if url != (URL{}) {
				t.Fatalf("%q was refused with %+v", raw, url)
			}
			return
		}
		// Zod keeps the string JavaScript's trim leaves; the URL parser also drops C0 controls around it.
		value := url.Value
		parsed := strings.TrimFunc(value, func(r rune) bool { return r <= ' ' })
		colon := strings.IndexByte(parsed, ':')
		if strings.ContainsAny(value, "\t\n\r") || Trim(value) != value || colon < 1 || !validScheme(parsed[:colon]) {
			t.Fatalf("%q was kept as %q", raw, value)
		}
		if url.Credentials && !strings.Contains(value, "@") {
			t.Fatalf("%q has credentials without an @", raw)
		}
		if again, same := ParseURL(value); !same || again != url {
			t.Fatalf("%q was kept as %+v, which reads as %+v (%v)", raw, url, again, same)
		}
	})
}

// A host the URL parser reads as an IPv4 address, as IPv4 writes it: dotted
// decimal, written the same again, and a host the parser takes; a host that
// ends in a number but isn't one is a URL the parser refuses.
func FuzzIPv4(f *testing.F) {
	for _, host := range []string{"127.0.0.1", "127.1", "0x7f.0.0.1", "0X7F.1.", "010.0.0.1", "4294967295", "4294967296", "1.2.3.4.5", "0x", "1.0x",
		"09", "1.2.3.08", "a.1", "1.a", "example.com", "255.255.255.255", "0.0.0.0.", "..1", "1..2", "18446744073709551616"} {
		f.Add(host)
	}
	f.Fuzz(func(t *testing.T, host string) {
		ip, isIPv4 := IPv4(host)
		_, taken := ParseURL("https://" + host + "/")
		parsable := !strings.ContainsAny(host, "/\\?#@:[]%") && strings.IndexFunc(host, func(r rune) bool { return r <= ' ' || r >= 0x7f }) < 0
		if !isIPv4 {
			if ip != "" || (parsable && taken && host != "" && endsInNumber(strings.ToLower(host))) {
				t.Fatalf("%q, which ends in a number, isn't an address but was taken", host)
			}
			return
		}
		if !dottedDecimal.MatchString(ip) || !taken {
			t.Fatalf("%q is the address %q (taken %v)", host, ip, taken)
		}
		if again, ok := IPv4(ip); !ok || again != ip {
			t.Fatalf("%q, written again, is %q", ip, again)
		}
		if address, err := netip.ParseAddr(ip); err != nil || !address.Is4() || address.String() != ip {
			t.Fatalf("%q is not %v", ip, address)
		}
		if dottedDecimal.MatchString(host) && ip != host {
			t.Fatalf("%q, written as the standard writes it, became %q", host, ip)
		}
	})
}
