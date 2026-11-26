package main

import "encoding/binary"

// A screen's phones, and how any controller takes a place (pads.go has the
// screens): mirroring packages/core/pads.ts.

// OpenPad mirrors Pads.openPad: a phone's place on the screen with the code
// it typed, from address: its old one by its resume, else the one it asks
// for, else the first free one. Nil when it gets none (the link is closed).
func (p *Pads) OpenPad(link padsLink, access, address, input string, asked *int, resume string) *padController {
	p.mu.Lock()
	defer p.mu.Unlock()
	address = plainAddress(address)
	if p.tries.blocked(address) {
		link.close(padsTries)
		return nil
	}
	var screen *padScreen
	if code := sessionCode(input); code != "" {
		screen = p.byCode(code, access)
	}
	if screen == nil {
		p.tries.wrong(address)
		link.close(padsUnknown)
		return nil
	}
	token, back := "", -1
	if resume != "" {
		// The same phone again before its old socket was seen to drop: it takes the place over.
		for _, held := range screen.slots {
			if held != nil && !held.box && same(held.resume, resume) {
				held.gone = true
				held.link.close(padsReplaced)
				screen.slots[held.place] = nil
				token, back = held.resume, held.place
				break
			}
		}
		for i := 0; token == "" && i < len(screen.kept); i++ {
			if kept := screen.kept[i]; same(kept.token, resume) {
				screen.kept = append(screen.kept[:i], screen.kept[i+1:]...)
				token, back = kept.token, kept.place
			}
		}
	}
	place := screen.free()
	if asked != nil && screen.isOpen(*asked) {
		place = *asked
	}
	if back >= 0 && screen.isOpen(back) {
		place = back
	}
	if place < 0 {
		link.close(padsFull)
		return nil
	}
	if token == "" {
		token = secret()
	}
	phone := &padController{link: link, on: screen, resume: token}
	p.seat(phone, screen, place, true)
	return phone
}

// PadFrame passes a phone's frame to its screen with its place; anything
// that isn't a pad frame closes the phone. A phone whose A goes down while its
// screen claims a free place takes it.
func (p *Pads) PadFrame(phone *padController, frame []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if phone.gone {
		return
	}
	if !validPad(frame) {
		p.padGone(phone, false)
		phone.link.close(padsUnsupported)
		return
	}
	if !p.counts(&phone.rate) {
		return
	}
	pressed := binary.LittleEndian.Uint32(frame[4:])
	down := pressed &^ phone.pressed
	phone.pressed = pressed
	if down&padButtonA != 0 {
		p.claimed(phone, phone.on)
	}
	p.forward(phone.on, phone.place, frame)
}

// PadMessage: a phone moves to a free place.
func (p *Pads) PadMessage(phone *padController, place int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if phone.gone || !p.counts(&phone.rate) || !phone.on.isOpen(place) {
		return
	}
	phone.on.slots[phone.place] = nil
	p.seat(phone, phone.on, place, true)
}

// PadGone: a phone's socket closed. It leaves its place, which its resume
// may take back within 60 s.
func (p *Pads) PadGone(phone *padController) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.padGone(phone, true)
}
func (p *Pads) padGone(phone *padController, keep bool) {
	if phone.gone {
		return
	}
	phone.gone = true
	screen := phone.on
	if screen.slots[phone.place] != phone {
		return
	}
	screen.slots[phone.place] = nil
	if keep && p.screens[screen.id] == screen {
		screen.kept = append(screen.kept, padKept{token: phone.resume, place: phone.place, at: p.now()})
		if len(screen.kept) > padsKept {
			screen.kept = screen.kept[1:]
		}
	}
	p.list(screen)
}

// seat puts a controller in a place; a phone hears its place, and the screen
// its list unless more follows (tell).
func (p *Pads) seat(held *padController, screen *padScreen, place int, tell bool) {
	screen.slots[place] = held
	held.place = place
	if held.box {
		held.on = screen
	} else {
		p.told(held)
	}
	if tell {
		p.list(screen)
	}
}

func (p *Pads) told(phone *padController) {
	phone.link.text(struct {
		Type   string    `json:"type"`
		Slot   int       `json:"slot"`
		Screen string    `json:"screen"`
		Resume string    `json:"resume"`
		Label  *padLabel `json:"label"`
	}{"pad", phone.place, phone.on.id, phone.resume, phone.on.labels[phone.place]})
}

// label gives the screen these labels: each phone whose own changed hears
// it, and the screen its list (tell).
func (p *Pads) label(screen *padScreen, labels [padPlaces]*padLabel, tell bool) {
	before := screen.labels
	screen.labels = labels
	changed := false
	for place, held := range screen.slots {
		old, now := before[place], labels[place]
		if held == nil || (old == nil) == (now == nil) && (old == nil || *old == *now) {
			continue
		}
		changed = true
		if !held.box {
			p.told(held)
		}
	}
	if changed && tell {
		p.list(screen)
	}
}
