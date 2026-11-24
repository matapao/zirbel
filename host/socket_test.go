package main

import (
	"bufio"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// readServerFrame reads one unmasked frame from the server.
func readServerFrame(rd *bufio.Reader) ([]byte, error) {
	head := make([]byte, 2)
	if _, err := io.ReadFull(rd, head); err != nil {
		return nil, err
	}
	n := uint64(head[1] & 0x7F)
	if n >= 126 {
		extended := make([]byte, 2+6*(n-126))
		if _, err := io.ReadFull(rd, extended); err != nil {
			return nil, err
		}
		n = uint64(binary.BigEndian.Uint16(extended))
		if len(extended) == 8 {
			n = binary.BigEndian.Uint64(extended)
		}
	}
	payload := make([]byte, n)
	_, err := io.ReadFull(rd, payload)
	return payload, err
}

// stuckSeat seats a client on a room socket over loopback TCP. The
// client then stops reading until the server's writer is stuck mid-write.
// done closes when the server has torn the socket down.
func stuckSeat(t *testing.T) (*net.TCPConn, <-chan struct{}) {
	t.Helper()
	release, _ := fakeRelease(t)
	rooms := NewRooms()
	t.Cleanup(rooms.Dispose)
	room, err := rooms.Create(release, "local")
	if err != nil {
		t.Fatal(err)
	}
	ticket, err := room.Reserve(room.Invite, "Ada", "player")
	if err != nil {
		t.Fatal(err)
	}
	socket, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = socket.Close() })
	raw, err := (&net.Dialer{}).DialContext(t.Context(), "tcp4", socket.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server, err := socket.Accept()
	client, ok := raw.(*net.TCPConn)
	if err != nil || !ok {
		t.Fatal("no TCP connection", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	listener := &Listener{}
	listener.sockets.Add(1)
	listener.handshakes.Add(1)
	done := make(chan struct{})
	go func() {
		listener.runSocket(t.Context(), newWSConn(server, bufio.NewReader(server), roomMessageLimit), room)
		close(done)
	}()

	send := func(text string) {
		if _, err := client.Write(frame(true, opText, []byte(text), true)); err != nil {
			t.Fatal(err)
		}
	}
	send(`{"type":"hello","version":1,"credential":"` + ticket + `","releaseId":"r1"}`)
	if welcome, err := readServerFrame(bufio.NewReader(client)); err != nil || !strings.Contains(string(welcome), `"welcome"`) {
		t.Fatalf("no welcome: %.80s %v", welcome, err)
	}
	room.mu.Lock()
	var peer *socketPeer
	for _, s := range room.seats {
		peer, _ = s.peer.(*socketPeer)
	}
	room.mu.Unlock()
	if peer == nil {
		t.Fatal("no seated socket")
	}
	// A 4 KB shared state, then resyncs at 50 a second (the limit is 60) until a write stays stuck.
	half := strings.Repeat("x", 2000)
	send(`{"type":"action","sequence":1,"action":{"a":"` + half + `","b":"` + half + `"}}`)
	var stuckSince time.Time
	for started := time.Now(); stuckSince.IsZero() || time.Since(stuckSince) < 200*time.Millisecond; {
		if time.Since(started) > 20*time.Second {
			t.Fatal("the server's writer never got stuck")
		}
		if peer.queued.Load() > 0 {
			if stuckSince.IsZero() {
				stuckSince = time.Now()
			}
			time.Sleep(5 * time.Millisecond)
			continue
		}
		stuckSince = time.Time{}
		send(`{"type":"resync"}`)
		time.Sleep(20 * time.Millisecond)
	}
	return client, done
}

// A write stuck on a client that stopped reading has a 10-second deadline;
// tearing the socket down must not wait for it.
func TestSocketTeardownDoesNotWaitOnAStuckWrite(t *testing.T) {
	triggers := map[string]func(*net.TCPConn) error{
		"half-close": func(client *net.TCPConn) error { return client.CloseWrite() },
		"close frame": func(client *net.TCPConn) error {
			_, err := client.Write(frame(true, opClose, []byte{0x03, 0xE8}, true))
			return err
		},
	}
	for name, trigger := range triggers {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			client, done := stuckSeat(t)
			select {
			case <-done:
				t.Fatal("the socket ended before the client did anything")
			default:
			}
			started := time.Now()
			if err := trigger(client); err != nil {
				t.Fatal(err)
			}
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("the socket was still open 5 s later")
			}
			if elapsed := time.Since(started); elapsed > 3*time.Second {
				t.Fatalf("teardown took %v", elapsed)
			}
		})
	}
}
