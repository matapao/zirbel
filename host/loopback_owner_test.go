package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"

	"zirbel/contracts"
)

// The kernel's socket tables as Linux writes them, as in test/loopback-owner.test.ts.
const tableHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"

func tableRow(n int, local, remote, state string, uid int) string {
	return fmt.Sprintf("  %d: %s %s %s 00000000:00000000 00:00000000 00000000 %5d        0 %d 1 0000000000000000 20 4 30 10 -1",
		n, local, remote, state, uid, 4000+n)
}

// The editor (uid 1001) on port 80 (0050): its listening socket, its end of
// each connection, and the connecting ends: the TV's browser (1002) from
// 54321 (D431), the setup service (root) from 54322 (D432); over IPv6, ::1
// from 45056 (B000) as the editor's user and an IPv6 socket mapping
// 127.0.0.1 from 45057 (B001).
var fixtureTables = socketTables{
	v4: strings.Join([]string{tableHeader,
		tableRow(0, "00000000:0050", "00000000:0000", "0A", 1001),
		tableRow(1, "0100007F:0050", "0100007F:D431", "01", 1001),
		tableRow(2, "0100007F:D431", "0100007F:0050", "01", 1002),
		tableRow(3, "0100007F:D432", "0100007F:0050", "01", 0),
		tableRow(4, "0100007F:D433", "0100007F:1F90", "01", 1001),
		tableRow(5, "0100007F:D433", "0100007F:0050", "01", 1002),
	}, "\n") + "\n",
	v6: strings.Join([]string{tableHeader,
		tableRow(0, "00000000000000000000000000000000:0050", "00000000000000000000000000000000:0000", "0A", 1001),
		tableRow(1, "00000000000000000000000001000000:B000", "00000000000000000000000001000000:0050", "01", 1001),
		tableRow(2, "0000000000000000FFFF00000100007F:B001", "0000000000000000FFFF00000100007F:0050", "01", 1002),
	}, "\n") + "\n",
}

func TestALoopbackConnectionBelongsToTheUserWhoseSocketReachesOurs(t *testing.T) {
	cases := []struct {
		peer       string
		peerPort   int
		ourPort    int
		uid        int
		found      bool
		tables     socketTables
		endianness binary.ByteOrder
	}{
		{"127.0.0.1", 54321, 80, 1002, true, fixtureTables, binary.LittleEndian},
		{"::ffff:127.0.0.1", 54321, 80, 1002, true, fixtureTables, binary.LittleEndian},
		{"127.0.0.1", 54322, 80, 0, true, fixtureTables, binary.LittleEndian},
		{"127.0.0.1", 54323, 80, 1002, true, fixtureTables, binary.LittleEndian},
		{"::1", 45056, 80, 1001, true, fixtureTables, binary.LittleEndian},
		{"[::1]", 45056, 80, 1001, true, fixtureTables, binary.LittleEndian},
		{"::ffff:127.0.0.1", 45057, 80, 1002, true, fixtureTables, binary.LittleEndian},
		{"127.0.0.1", 80, 54321, 1001, true, fixtureTables, binary.LittleEndian},
		{"127.0.0.1", 54321, 8080, 0, false, fixtureTables, binary.LittleEndian},
		{"127.0.0.2", 54321, 80, 0, false, fixtureTables, binary.LittleEndian},
		{"nowhere", 54321, 80, 0, false, fixtureTables, binary.LittleEndian},
		{"127.0.0.1", 54321, 80, 0, false, socketTables{v4: "garbage\n  9: zz:zz yy:yy 01 x x x x\n"}, binary.LittleEndian},
		// A big-endian host writes each 32-bit word as it is.
		{"127.0.0.1", 54321, 80, 1002, true, socketTables{v4: tableRow(0, "7F000001:D431", "7F000001:0050", "01", 1002)}, binary.BigEndian},
		{"::1", 45056, 80, 1001, true, socketTables{v6: tableRow(0, "00000000000000000000000000000001:B000", "00000000000000000000000000000001:0050", "01", 1001)}, binary.BigEndian},
		{"127.0.0.1", 54321, 80, 0, false, socketTables{v4: tableRow(0, "7F000001:D431", "7F000001:0050", "01", 1002)}, binary.LittleEndian},
	}
	for _, c := range cases {
		if uid, found := socketOwner(c.tables, c.peer, c.peerPort, c.ourPort, c.endianness); uid != c.uid || found != c.found {
			t.Errorf("%s:%d to %d: %d %v, want %d %v", c.peer, c.peerPort, c.ourPort, uid, found, c.uid, c.found)
		}
	}
}

// contextWithLocal is a request's context as the server gives it: with the
// local address the request came in on.
func contextWithLocal(r *http.Request, local net.Addr) context.Context {
	return context.WithValue(r.Context(), http.LocalAddrContextKey, local)
}

func TestTheBoxsOwnLoopbackIsTheHostsUserAndRoot(t *testing.T) {
	read, me := readTables, myUID
	t.Cleanup(func() { readTables, myUID = read, me })
	request := func(from string) *http.Request {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", http.NoBody)
		r.RemoteAddr = from
		return r.WithContext(contextWithLocal(r, &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 80}))
	}
	readTables = func() (socketTables, bool) { return fixtureTables, true }
	myUID = 1001
	for from, want := range map[string]bool{"127.0.0.1:54321": false, "127.0.0.1:54322": true, "[::1]:45056": true, "127.0.0.1:60000": false,
		"garbage": false} {
		if got := ownLoopback(request(from)); got != want {
			t.Errorf("%s: %v, want %v", from, got, want)
		}
	}
	myUID = 1002
	if !ownLoopback(request("127.0.0.1:54321")) {
		t.Error("the host's own user is not the box's own")
	}
	// No local address: not one the host accepted.
	if ownLoopback(httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", http.NoBody)) {
		t.Error("a request with no local address is the box's own")
	}
	readTables = func() (socketTables, bool) { return socketTables{}, false }
	if !ownLoopback(request("127.0.0.1:54321")) {
		t.Error("where the tables can't be read, loopback is not the box's own")
	}
}

// On this system, a request from this process is its own user's, whether
// the tables name it (Linux) or can't be read.
func TestThisSystemsLoopbackRequestIsThisUsers(t *testing.T) {
	// No Content for the box's own, Forbidden for another's.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ownLoopback(r) {
			w.WriteHeader(http.StatusNoContent)
		} else {
			w.WriteHeader(http.StatusForbidden)
		}
	}))
	t.Cleanup(server.Close)
	r, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/", http.NoBody)
	response, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("a request from this process on %s: %d", runtime.GOOS, response.StatusCode)
	}
	if _, readable := readSocketTables(); readable != (runtime.GOOS == "linux") {
		t.Fatalf("the tables are readable on %s: %v", runtime.GOOS, readable)
	}
}

// The socket tables and a peer as socketOwner in packages/server/loopback-owner.ts
// reads them, on any text: a uid only for a line whose local address and port
// are the peer's and whose remote port is ours, the first such line's, and a
// row written for a peer is found again by it, in either byte order.
func FuzzSocketOwner(f *testing.F) {
	f.Add(fixtureTables.v4, fixtureTables.v6, "127.0.0.1", uint16(54321), uint16(80), []byte{10, 1, 2, 3}, uint32(1002), uint8(0), true)
	f.Add(fixtureTables.v4, fixtureTables.v6, "[::1]", uint16(45056), uint16(80), []byte(net.IPv6loopback), uint32(0), uint8(1), false)
	f.Add(fixtureTables.v4, fixtureTables.v6, "::ffff:127.0.0.1", uint16(45057), uint16(80), []byte{127, 0, 0, 1}, uint32(7), uint8(2), true)
	for _, row := range []string{
		"  x: 0100007F:D431 0100007F:0050 01 0 0 0 1002", // a slot that isn't digits
		"  0: 0100007F:D431 0100007F:0050 01 0 0 0 99999999999999999999",
		"\ufeff0: 0100007F:D431 0100007F:0050 01 0 0 0 1002",    // JavaScript's white space
		"  0:\u00850100007F:D431 0100007F:0050 01 0 0 0 1002",   // not JavaScript's
		"  0: 0100007F:D431:00 0100007F:0050 01 0 0 0 1002",     // a port with more after it
		"  0: 0100007F:+D431 0100007F:0050 01 0 0 0 1002",       // a sign
		"  0: 0100007F:0000D431 0100007F:0050 01 0 0 0 0001002", // zeros in front
	} {
		f.Add(row, "", "127.0.0.1", uint16(54321), uint16(80), []byte{127, 0, 0, 1}, uint32(5), uint8(3), true)
	}
	for _, peer := range []string{"[::1]%eth0", "[[::1]]", "::1]", "::1%\n", "fe80::1%eth0", "::ffff:7f00:1", "1::2::3", "01.2.3.4", "::1.2.3.4"} {
		f.Add("", fixtureTables.v6, peer, uint16(45056), uint16(80), []byte(net.IPv6loopback), uint32(9), uint8(4), true)
	}
	f.Fuzz(func(t *testing.T, v4, v6, peer string, peerPort, ourPort uint16, address []byte, owner uint32, format uint8, little bool) {
		order := binary.ByteOrder(binary.BigEndian)
		if little {
			order = binary.LittleEndian
		}
		tables := socketTables{v4, v6}
		uid, found := socketOwner(tables, peer, int(peerPort), int(ourPort), order)
		wantUID, wantFound := nodeSocketOwner(tables, peer, int(peerPort), int(ourPort), little)
		if uid != wantUID || found != wantFound {
			t.Fatalf("%q:%d to %d: %d %v; Node reads %d %v", peer, peerPort, ourPort, uid, found, wantUID, wantFound)
		}
		if again, still := socketOwner(tables, peer, int(peerPort), int(ourPort), order); again != uid || still != found {
			t.Fatal("read twice, it reads otherwise")
		}
		// A row of the peer's own, ahead of the rest of its table, as the
		// kernel writes it: each 32-bit word of the address in the host's order.
		var ip net.IP
		switch {
		case len(address) >= 16:
			ip = net.IP(address[:16])
		case len(address) >= 4:
			ip = net.IPv4(address[0], address[1], address[2], address[3])
		default:
			return
		}
		row := func(ip net.IP) string {
			var field strings.Builder
			for i := 0; i < len(ip); i += 4 {
				fmt.Fprintf(&field, "%08X", order.Uint32(ip[i:]))
			}
			return tableRow(0, fmt.Sprintf("%s:%04X", field.String(), peerPort), fmt.Sprintf("%s:%04X", field.String(), ourPort),
				"01", int(owner))
		}
		if v4 := ip.To4(); v4 != nil && format%2 == 0 {
			tables = socketTables{v4: row(v4) + "\n" + tables.v4, v6: tables.v6}
		} else {
			tables = socketTables{v6: row(ip.To16()) + "\n" + tables.v6}
		}
		written := ip.String()
		switch {
		case format%4 == 1:
			written = "[" + written + "]"
		case format%4 == 2 && ip.To4() != nil:
			written = "::ffff:" + written
		case format%4 == 3:
			written += "%eth0"
		}
		if uid, found := socketOwner(tables, written, int(peerPort), int(ourPort), order); !found || uid != int(owner) {
			t.Fatalf("%s's own row (%q): %d %v", written, strings.SplitN(tables.v4+tables.v6, "\n", 2)[0], uid, found)
		}
	})
}

// nodeSocketOwner is socketOwner in packages/server/loopback-owner.ts, as the
// kernel writes its fields: each address and port with one colon between, and
// each port only hex digits (Node's parseInt would read "+D431" or "D431x" as
// D431 too).
func nodeSocketOwner(tables socketTables, peer string, peerPort, ourPort int, little bool) (int, bool) {
	want := nodeAddressKey(peer)
	if want == "" {
		return 0, false
	}
	for _, text := range []string{tables.v4, tables.v6} {
		for line := range strings.SplitSeq(text, "\n") {
			fields := jsWhiteSpace.Split(contracts.Trim(line), -1)
			if len(fields) < 8 || !slotField.MatchString(fields[0]) || !uidField.MatchString(fields[7]) {
				continue
			}
			local, remote := strings.Split(fields[1], ":"), strings.Split(fields[2], ":")
			if len(local) != 2 || len(remote) != 2 || hexPort(local[1]) != peerPort || hexPort(remote[1]) != ourPort ||
				nodeTableAddress(local[0], little) != want {
				continue
			}
			uid, err := strconv.ParseInt(fields[7], 10, 64)
			if err != nil {
				return -1, true
			}
			return int(uid), true
		}
	}
	return 0, false
}

var (
	jsWhiteSpace = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}\x{2001}\x{2002}\x{2003}\x{2004}\x{2005}\x{2006}\x{2007}\x{2008}\x{2009}\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)
	slotField    = regexp.MustCompile(`^[0-9]+:$`)
	uidField     = regexp.MustCompile(`^[0-9]+$`)
	tableHex     = regexp.MustCompile(`^(?i:[0-9A-F]{8}|[0-9A-F]{32})$`)
	hexGroup     = regexp.MustCompile(`^(?i:[0-9a-f]{1,4})$`)
	embeddedIPv4 = regexp.MustCompile(`^(.*:)([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$`)
	nodeIPv4     = regexp.MustCompile(`^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$`)
)

// hexPort is a port of hex digits, or -1.
func hexPort(text string) int {
	value, err := strconv.ParseUint(strings.TrimLeft(text, "0")+"0", 16, 20)
	if err != nil || value/16 > 0xFFFF {
		return -1
	}
	return int(value / 16)
}

// nodeAddressKey is addressKey: 32 hex digits, or "" for an address that isn't one.
func nodeAddressKey(address string) string {
	lineEnd := func(text string) bool { return strings.ContainsAny(text, "\n\r\u2028\u2029") }
	if len(address) >= 2 && address[0] == '[' && address[len(address)-1] == ']' && !lineEnd(address[1:len(address)-1]) {
		address = address[1 : len(address)-1]
	}
	for at := range len(address) {
		if address[at] == '%' && !lineEnd(address[at:]) {
			address = address[:at]
			break
		}
	}
	ipv4 := func(text string) string {
		var key strings.Builder
		for part := range strings.SplitSeq(text, ".") {
			value, _ := strconv.Atoi(part)
			fmt.Fprintf(&key, "%02x", value)
		}
		return key.String()
	}
	if nodeIPv4.MatchString(address) {
		return "00000000000000000000ffff" + ipv4(address)
	}
	if embedded := embeddedIPv4.FindStringSubmatch(address); embedded != nil {
		if !nodeIPv4.MatchString(embedded[2]) {
			return ""
		}
		key := ipv4(embedded[2])
		address = embedded[1] + key[:4] + ":" + key[4:]
	}
	halves := strings.Split(address, "::")
	groups := func(half string) []string {
		if half == "" {
			return nil
		}
		return strings.Split(half, ":")
	}
	head, tail := groups(halves[0]), []string(nil)
	if len(halves) == 2 {
		tail = groups(halves[1])
	}
	missing := 8 - len(head) - len(tail)
	if len(halves) > 2 || (len(halves) == 1 && missing != 0) || (len(halves) == 2 && missing < 1) {
		return ""
	}
	if len(halves) == 1 {
		missing = 0
	}
	var key strings.Builder
	for _, group := range append(append(head, slices.Repeat([]string{"0"}, missing)...), tail...) {
		if !hexGroup.MatchString(group) {
			return ""
		}
		key.WriteString(strings.Repeat("0", 4-len(group)) + strings.ToLower(group))
	}
	return key.String()
}

// nodeTableAddress is tableAddress: a table's field as addressKey writes it.
func nodeTableAddress(field string, little bool) string {
	if !tableHex.MatchString(field) {
		return ""
	}
	var key strings.Builder
	if len(field) == 8 {
		key.WriteString("00000000000000000000ffff")
	}
	for at := 0; at < len(field); at += 8 {
		word := field[at : at+8]
		if little {
			word = word[6:8] + word[4:6] + word[2:4] + word[0:2]
		}
		key.WriteString(strings.ToLower(word))
	}
	return key.String()
}
