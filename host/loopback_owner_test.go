package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"runtime"
	"strings"
	"testing"
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
		r, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, "/", http.NoBody)
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
	if r, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, "/", http.NoBody); ownLoopback(r) {
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
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, ownLoopback(r))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	r, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+listener.Addr().String()+"/", http.NoBody)
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if string(body) != "true" {
		t.Fatalf("a request from this process on %s: %s", runtime.GOOS, body)
	}
	if _, readable := readSocketTables(); readable != (runtime.GOOS == "linux") {
		t.Fatalf("the tables are readable on %s: %v", runtime.GOOS, readable)
	}
}
