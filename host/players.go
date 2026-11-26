package main

import (
	"context"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"zirbel/host/webfiles"
)

// Players owns the player listeners, like Players in
// packages/server/hosting.ts: the loopback listener that always runs, and the
// LAN listener, which starts with --lan, on a box, or when the editor first
// shares a room. Both serve the lobby.
type Players struct {
	rooms   *Rooms
	runtime map[string]*webfiles.File
	local   *Listener
	lanHost string // the host name for LAN links; empty means the first LAN address
	lanPort int
	lobby   *Lobby
	// box, on a box: the LAN listener answers the box's network by its names,
	// IPv6 too, for the guests its door sends to the lobby.
	box *playerReach

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
		config, bind := listenerConfig{lan: true, extraHosts: extra, lobby: p.lobby}, "0.0.0.0"
		if box := p.box; box != nil {
			config.box = &playerReach{hosts: func() []string { return append(box.hosts(), extra...) }, network: box.network,
				editorOrigins: func(string) []string { return nil }}
			bind = everyInterface
		}
		listener, err := Listen(ctx, p.rooms, p.runtime, bind, p.lanPort, config)
		if err != nil {
			return nil, err
		}
		p.lan = listener
	}
	return p.lan, nil
}

// Describe mirrors Players.describe in packages/server/hosting.ts: a room and
// its links on the listener that serves it, a local room's on host (the name
// a box was reached by; loopback otherwise). The Go host does not render QR
// codes yet; the editor shows the link.
func (p *Players) Describe(ctx context.Context, room *Room, host string) (any, error) {
	active, address := p.local, ""
	if room.Access == "lan" {
		var err error
		if active, err = p.StartLAN(ctx); err != nil {
			return nil, err
		}
		address = p.lanAddress()
	}
	linked := address
	if linked == "" {
		linked = host
	}
	port := ":" + strconv.Itoa(active.port)
	return struct {
		summary
		LAN       bool    `json:"lan"`
		Link      string  `json:"link"`
		LocalLink string  `json:"localLink"`
		QR        *string `json:"qr"`
	}{room.Summary(), address != "", roomLink("http://"+linked+port, room), roomLink("http://"+host+port, room), nil}, nil
}

// LobbyLink mirrors Players.lobbyLink in packages/server/hosting.ts: the
// lobby's address for other devices on the network, on the LAN listener. It
// is on host, the name a box was reached by, where others can use it, and
// otherwise on the address a shared room's link has. Nil while no LAN
// listener runs, or while it has no address.
func (p *Players) LobbyLink(host string) *string {
	port := p.LANPort()
	if port == 0 {
		return nil
	}
	address := p.reachableAddress(host)
	if address == "" {
		return nil
	}
	link := "http://" + address + ":" + strconv.Itoa(port) + "/"
	return &link
}

// reachableAddress is an address another device can open as it is: host, the
// name a box was reached by, when it is an IP address that isn't only this
// device's own, else the LAN address. A name, even one this device resolved (a
// box's .local name), is often one a phone or an office network can't.
func (p *Players) reachableAddress(host string) string {
	if host == "" || loopbackName(host) || net.ParseIP(strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")) == nil {
		return p.lanAddress()
	}
	return host
}

// lanAddress is the host LAN links are on: the --player-host name, or the
// first LAN address; empty when there is neither.
func (p *Players) lanAddress() string {
	if p.lanHost != "" {
		return p.lanHost
	}
	if list := LANAddresses(); len(list) > 0 {
		return list[0]
	}
	return ""
}

// loopbackName is a host name only the device it is on reaches itself by.
func loopbackName(host string) bool {
	return host == "localhost" || host == "[::1]" || loopbackHost.MatchString(host)
}

var loopbackHost = regexp.MustCompile(`^127\.\d+\.\d+\.\d+$`)

// LANPort is the LAN listener's port, 0 until it has started.
func (p *Players) LANPort() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.lan == nil {
		return 0
	}
	return p.lan.port
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
