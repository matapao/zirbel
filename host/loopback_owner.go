package main

import (
	"encoding/binary"
	"encoding/hex"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Who is at the other end of a loopback connection, mirroring
// packages/server/loopback-owner.ts: on Linux, the user that owns the
// connecting socket, as the kernel's socket tables say (/proc/net/tcp and
// tcp6, the uid column). On a box a loopback request is the box's own, with
// its owner's powers (box_routes.go), only when that user is the host's own or
// root (its setup service): a program another user runs on the box, such as
// the TV's browser as zirbel-tv, is a device on its network like any other.
// Where the tables can't be read (not Linux) every loopback request stays the
// box's own.

// socketTables are the kernel's socket tables as text.
type socketTables struct{ v4, v6 string }

// readSocketTables reads them, or reports that neither can be read.
func readSocketTables() (socketTables, bool) {
	v4, err4 := os.ReadFile("/proc/net/tcp")
	v6, err6 := os.ReadFile("/proc/net/tcp6")
	return socketTables{string(v4), string(v6)}, err4 == nil || err6 == nil
}

// tableAddress is a table's address field (hex, each 32-bit word in the
// host's byte order) as 16 bytes, an IPv4 one mapped into IPv6.
func tableAddress(field string, order binary.ByteOrder) net.IP {
	raw, err := hex.DecodeString(field)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return nil
	}
	ip := make(net.IP, len(raw))
	for i := 0; i < len(raw); i += 4 {
		binary.BigEndian.PutUint32(ip[i:], order.Uint32(raw[i:]))
	}
	return ip.To16()
}

// socketOwner is the uid that owns the socket whose local address and port
// are the peer's and whose remote port is ours, in the tables: found says
// whether either has one. An IPv4 peer may be either an IPv4 socket or an
// IPv6 one mapped. A line is read as socketOwner in loopback-owner.ts reads
// it: fields between JavaScript's white space, a slot of digits and a colon,
// and a uid of digits; one past any int is no one's (-1), as Number(uid) is
// neither root's nor ours there.
func socketOwner(tables socketTables, peer string, peerPort, ourPort int, order binary.ByteOrder) (uid int, found bool) {
	want := net.ParseIP(peerAddress(peer))
	if want == nil {
		return 0, false
	}
	for _, text := range []string{tables.v4, tables.v6} {
		for line := range strings.SplitSeq(text, "\n") {
			fields := strings.FieldsFunc(line, jsSpace)
			if len(fields) < 8 {
				continue
			}
			slot, slotOK := strings.CutSuffix(fields[0], ":")
			address, port, ok := strings.Cut(fields[1], ":")
			_, remotePort, remoteOK := strings.Cut(fields[2], ":")
			if !slotOK || !digits(slot) || !digits(fields[7]) || !ok || !remoteOK {
				continue
			}
			local, localErr := strconv.ParseUint(port, 16, 16)
			remote, remoteErr := strconv.ParseUint(remotePort, 16, 16)
			if localErr == nil && remoteErr == nil && int(local) == peerPort && int(remote) == ourPort &&
				want.Equal(tableAddress(address, order)) {
				owner, err := strconv.Atoi(fields[7])
				if err != nil {
					owner = -1
				}
				return owner, true
			}
		}
	}
	return 0, false
}

// A peer's address as addressKey in loopback-owner.ts takes it: without the
// brackets around all of it, then without a zone (from a % to the end, where
// no line ends between: JavaScript's . matches no line terminator).
var (
	bracketedPeer = regexp.MustCompile(`^\[([^\n\r\x{2028}\x{2029}]*)\]$`)
	peerZone      = regexp.MustCompile(`%[^\n\r\x{2028}\x{2029}]*$`)
)

func peerAddress(peer string) string {
	return peerZone.ReplaceAllString(bracketedPeer.ReplaceAllString(peer, "$1"), "")
}

func digits(text string) bool {
	for _, character := range text {
		if character < '0' || character > '9' {
			return false
		}
	}
	return text != ""
}

// readTables is how ownLoopback reads the tables, and myUID whose they must
// name; tests set their own.
var (
	readTables = readSocketTables
	myUID      = os.Getuid()
)

// ownLoopback reports whether a loopback request is the box's own: its other
// end belongs to this user or root, or the tables can't be read. One the
// tables don't have is not. The Go host has few loopback requests (no
// harnesses), so each reads the tables.
func ownLoopback(r *http.Request) bool {
	tables, readable := readTables()
	if !readable {
		return true
	}
	host, peerPort, err := net.SplitHostPort(r.RemoteAddr)
	peer, portErr := strconv.Atoi(peerPort)
	local, _ := r.Context().Value(http.LocalAddrContextKey).(*net.TCPAddr)
	if err != nil || portErr != nil || local == nil {
		return false
	}
	uid, found := socketOwner(tables, host, peer, local.Port, binary.NativeEndian)
	return found && (uid == 0 || uid == myUID)
}
