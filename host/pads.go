package main

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"slices"
	"sync"
	"time"
)

// The pads socket's routing, mirroring packages/core/pads.ts: screens (any
// page that shows a game) and the controllers in their places, P1 to P8 (0 to
// 7): phones, which join a screen by its code, and the box's own gamepads,
// which its controller service reads (pads_box.go). The host never reads
// input: it checks a pad frame's shape, writes the controller's place into it
// and passes it to the screen, and only looks for a button going down, which
// may take a controller to a screen or a place. pads_socket.go carries it over
// WebSocket at /pads, pads_local.go over the box's local socket.

const (
	padPlaces      = 8
	padsScreens    = 64 // per listener
	padsClaims     = 16
	padsKept       = 32 // dropped phones a screen keeps places for
	padsResume     = 15 * time.Second
	padResume      = 60 * time.Second
	padsClaimTime  = 30 * time.Second
	padsPerSecond  = 120 // frames and control messages from one controller or screen
	padButtonA     = 1
	padMaxFrame    = 8 + 32 + 2*8
	padAxisLimit   = 32767
	padStandardBit = 1
)

// WebSocket close codes: a screen's own close (padsDone) ends it at once.
const (
	padsDone        = 1000
	padsUnsupported = 1003
	padsReleased    = 4000
	padsReplaced    = 4001
	padsUnknown     = 4404
	padsFull        = 4409
	padsTries       = 4429
)

// padsLink is a socket as the pads see it; none of its methods may block.
type padsLink interface {
	text(message any)
	binary(frame []byte)
	close(code int)
}

type padRate struct {
	window time.Time
	count  int
}

type padLabel struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

// padController is a phone or one of the box's gamepads (box).
type padController struct {
	box     bool
	on      *padScreen
	place   int
	pressed uint32
	rate    padRate
	// A phone's.
	link   padsLink
	resume string
	gone   bool
	// A box gamepad's.
	device   int
	name     string
	standard bool
}

type padKept struct {
	token string
	place int
	at    time.Time
}

type padScreen struct {
	id, code, resume, access string
	order                    int
	box                      bool
	link                     padsLink // nil while its socket is dropped
	lost                     time.Time
	open                     *string // a Show on TV link waiting for the page that resumes it
	rate                     padRate
	slots                    [padPlaces]*padController
	labels                   [padPlaces]*padLabel
	local                    [padPlaces]bool
	kept                     []padKept // dropped phones' places, oldest first
}

type padClaim struct {
	screen *padScreen
	at     time.Time
	place  *int
}

// Pads holds every listener's screens and the box's gamepads.
type Pads struct {
	mu      sync.Mutex
	now     func() time.Time
	screens map[string]*padScreen
	order   int
	devices []*padController // in the order they appeared
	claims  []*padClaim
	service padsLink
	tries   codeTries
	// controllers is the controller service's last view of the box's
	// controllers and Bluetooth, while it is connected.
	controllers json.RawMessage
}

func NewPads(now func() time.Time) *Pads {
	return &Pads{now: now, screens: map[string]*padScreen{}, tries: codeTries{now: now, tries: map[string]wrongTries{}}}
}

// Run sweeps the pads every second until ctx ends.
func (p *Pads) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.Sweep()
		}
	}
}

// validPad: a pad frame, as decodePad in packages/sdk/pads.ts reads one.
func validPad(frame []byte) bool {
	if len(frame) < 8 {
		return false
	}
	slot, flags, buttons, axes := frame[0], frame[1], int(frame[2]), int(frame[3])
	if slot >= padPlaces || flags&^padStandardBit != 0 || buttons > 32 || axes > 8 || len(frame) != 8+buttons+2*axes {
		return false
	}
	if pressed := binary.LittleEndian.Uint32(frame[4:]); buttons < 32 && pressed>>buttons != 0 {
		return false
	}
	for i := range axes {
		if int16(binary.LittleEndian.Uint16(frame[8+buttons+2*i:])) < -padAxisLimit { // #nosec G115 -- a signed axis, as sent
			return false
		}
	}
	return true
}

func (p *Pads) counts(rate *padRate) bool {
	at := p.now()
	if at.Sub(rate.window) >= time.Second {
		rate.window, rate.count = at, 0
	}
	rate.count++
	return rate.count <= padsPerSecond
}

// isOpen: the place is free, and not one the screen's own gamepads hold.
func (s *padScreen) isOpen(place int) bool {
	return place >= 0 && place < padPlaces && s.slots[place] == nil && !s.local[place]
}
func (s *padScreen) free() int {
	for place := range padPlaces {
		if s.isOpen(place) {
			return place
		}
	}
	return -1
}

// OpenScreen mirrors Pads.openScreen: the screen resume names on this
// listener, or a new one; nil when the listener holds all it may.
func (p *Pads) OpenScreen(link padsLink, access string, box bool, resume string) *padScreen {
	p.mu.Lock()
	defer p.mu.Unlock()
	tv := p.tv(access)
	var screen *padScreen
	if resume != "" {
		for _, item := range p.screens {
			if item.access == access && same(item.resume, resume) {
				screen = item
			}
		}
	}
	if screen != nil {
		if screen.link != nil {
			screen.link.close(padsReplaced)
		}
		screen.link, screen.lost, screen.box, screen.local = link, time.Time{}, box, [padPlaces]bool{}
		p.label(screen, [padPlaces]*padLabel{}, false)
	} else {
		count := 0
		for _, item := range p.screens {
			if item.access == access {
				count++
			}
		}
		if count >= padsScreens {
			link.close(padsFull)
			return nil
		}
		p.order++
		screen = &padScreen{id: hex.EncodeToString(randomBytes(6)), code: p.freeCode(), resume: secret(), access: access, order: p.order,
			box: box, link: link}
		p.screens[screen.id] = screen
		// The box's own screen takes every box gamepad that is on no screen.
		if box {
			for _, device := range p.devices {
				if device.on == nil && screen.free() >= 0 {
					p.seat(device, screen, screen.free(), false)
				}
			}
		}
	}
	link.text(p.about(screen))
	p.list(screen)
	if screen.open != nil {
		link.text(map[string]string{"type": "open", "link": *screen.open})
		screen.open = nil
	}
	if p.tv(access) != tv {
		p.retell(access, screen)
	}
	return screen
}

func (p *Pads) freeCode() string {
	for {
		code, taken := randomSessionCode(), false
		for _, screen := range p.screens {
			taken = taken || screen.code == code
		}
		if !taken {
			return code
		}
	}
}

// ScreenGone: its own close ends a screen, any other keeps it for its resume.
func (p *Pads) ScreenGone(screen *padScreen, link padsLink, code int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if screen.link != link {
		return
	}
	screen.link, screen.lost = nil, p.now()
	if code == padsDone {
		p.end(screen)
	}
}

// Sweep ends the screens whose sockets dropped longer ago than their resume
// keeps them, and forgets old claims and phones' places.
func (p *Pads) Sweep() {
	p.mu.Lock()
	defer p.mu.Unlock()
	at := p.now()
	for _, screen := range p.screensInOrder() {
		if screen.link == nil && at.Sub(screen.lost) >= padsResume {
			p.end(screen)
		}
		kept := screen.kept[:0]
		for _, item := range screen.kept {
			if at.Sub(item.at) < padResume {
				kept = append(kept, item)
			}
		}
		screen.kept = kept
	}
	p.expireClaims(at)
}

// end: a screen's phones are told and closed, and its box gamepads go back to
// no screen, and to the box's own screen when one is open.
func (p *Pads) end(screen *padScreen) {
	tv := p.tv(screen.access)
	delete(p.screens, screen.id)
	claims := p.claims[:0]
	for _, claim := range p.claims {
		if claim.screen != screen {
			claims = append(claims, claim)
		}
	}
	p.claims = claims
	freed := []*padController{}
	for _, held := range screen.slots {
		switch {
		case held == nil:
		case held.box:
			held.on = nil
			freed = append(freed, held)
		default:
			held.gone = true
			held.link.text(map[string]string{"type": "closed"})
			held.link.close(padsDone)
		}
	}
	for _, device := range freed {
		if target := p.newestBox(nil, true); target != nil {
			p.seat(device, target, target.free(), true)
		}
	}
	if p.tv(screen.access) != tv {
		p.retell(screen.access, nil)
	}
}

func (p *Pads) forward(screen *padScreen, place int, frame []byte) {
	if screen.link == nil {
		return
	}
	copied := append([]byte(nil), frame...)
	copied[0] = byte(place) // #nosec G115 -- a place, 0 to 7
	screen.link.binary(copied)
}

func (p *Pads) byCode(code, access string) *padScreen {
	for _, screen := range p.screens {
		if screen.code == code && screen.access == access {
			return screen
		}
	}
	return nil
}

// newestBox is the newest of the box's own screens that passes also (if
// any) and has room for a controller, unless room is false.
func (p *Pads) newestBox(also func(*padScreen) bool, room bool) *padScreen {
	var newest *padScreen
	for _, screen := range p.screens {
		if screen.box && (!room || screen.free() >= 0) && (also == nil || also(screen)) && (newest == nil || screen.order > newest.order) {
			newest = screen
		}
	}
	return newest
}

// tv: a box screen is open on the listener, for Show on TV.
func (p *Pads) tv(access string) bool {
	for _, screen := range p.screens {
		if screen.box && screen.access == access {
			return true
		}
	}
	return false
}

func (p *Pads) about(screen *padScreen) any {
	return struct {
		Type   string `json:"type"`
		ID     string `json:"id"`
		Code   string `json:"code"`
		Resume string `json:"resume"`
		Box    bool   `json:"box"`
		TV     bool   `json:"tv"`
	}{"screen", screen.id, screen.code, screen.resume, screen.box, p.tv(screen.access)}
}

// retell: every other connected screen on the listener hears that tv changed.
func (p *Pads) retell(access string, except *padScreen) {
	for _, screen := range p.screensInOrder() {
		if screen != except && screen.access == access && screen.link != nil {
			screen.link.text(p.about(screen))
		}
	}
}

type padItem struct {
	Slot      int       `json:"slot"`
	Place     int       `json:"place"`
	Kind      string    `json:"kind"`
	Name      string    `json:"name"`
	Connected bool      `json:"connected"`
	Label     *padLabel `json:"label"`
}

func (p *Pads) list(screen *padScreen) {
	if screen.link == nil {
		return
	}
	items := []padItem{}
	for place, held := range screen.slots {
		if held == nil {
			continue
		}
		item := padItem{Slot: place, Place: place, Kind: "phone", Name: "Phone " + string(rune('1'+place)), Connected: true, Label: screen.labels[place]}
		if held.box {
			item.Kind, item.Name = "box", held.name
		}
		items = append(items, item)
	}
	screen.link.text(struct {
		Type string    `json:"type"`
		Pads []padItem `json:"pads"`
	}{"pads", items})
}

// screensInOrder lists the screens oldest first, as the Node host's map
// iterates them.
func (p *Pads) screensInOrder() []*padScreen {
	list := make([]*padScreen, 0, len(p.screens))
	for _, screen := range p.screens {
		list = append(list, screen)
	}
	slices.SortFunc(list, func(a, b *padScreen) int { return a.order - b.order })
	return list
}
