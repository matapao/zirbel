package main

import (
	"context"
	"strconv"
	"sync"
	"time"

	"zirbel/host/webfiles"
)

// Players owns the player listeners, like Players in
// packages/server/hosting.ts: the loopback listener that always runs, and the
// LAN listener, which starts with --lan or when the editor first shares a room.
type Players struct {
	rooms   *Rooms
	runtime map[string]*webfiles.File
	local   *Listener
	lanHost string // the host name for LAN links; empty means the first LAN address
	lanPort int

	mu  sync.Mutex // editor requests may start the LAN listener at the same time
	lan *Listener
}

// StartLAN returns the LAN listener, starting it on first use.
func (p *Players) StartLAN(ctx context.Context) (*Listener, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.lan == nil {
		extra := []string{}
		if p.lanHost != "" {
			extra = append(extra, p.lanHost)
		}
		listener, err := Listen(ctx, p.rooms, p.runtime, "0.0.0.0", p.lanPort, listenerConfig{lan: true, extraHosts: extra})
		if err != nil {
			return nil, err
		}
		p.lan = listener
	}
	return p.lan, nil
}

// Describe mirrors Players.describe in packages/server/hosting.ts: a room and
// its links on the listener that serves it. The Go host does not render QR
// codes yet; the editor shows the link.
func (p *Players) Describe(ctx context.Context, room *Room) (any, error) {
	active, address := p.local, ""
	if room.Access == "lan" {
		var err error
		if active, err = p.StartLAN(ctx); err != nil {
			return nil, err
		}
		address = p.lanHost
		if address == "" {
			if list := LANAddresses(); len(list) > 0 {
				address = list[0]
			}
		}
	}
	host := address
	if host == "" {
		host = "127.0.0.1"
	}
	base := "http://" + host + ":" + strconv.Itoa(active.port)
	return struct {
		summary
		LAN       bool    `json:"lan"`
		Link      string  `json:"link"`
		LocalLink string  `json:"localLink"`
		QR        *string `json:"qr"`
	}{room.Summary(), address != "", roomLink(base, room), roomLink(loopback(active.port), room), nil}, nil
}

// Close lets seated sockets flush, then stops both listeners.
func (p *Players) Close() {
	p.mu.Lock()
	lan := p.lan
	p.mu.Unlock()
	for _, listener := range []*Listener{p.local, lan} {
		if listener != nil {
			listener.Wait(2 * time.Second)
			listener.Close()
		}
	}
}
