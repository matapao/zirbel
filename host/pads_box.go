package main

import (
	"encoding/binary"
	"encoding/json"
	"time"
)

// A screen's control messages, its claims, and the box's own gamepads from
// its controller service, mirroring packages/core/pads.ts.

// padsScreenMessage is one of contracts/pads-screen.schema.json.
type padsScreenMessage struct {
	Type     string  `json:"type"`
	Place    *int    `json:"place"`
	Slot     int     `json:"slot"`
	Duration float64 `json:"duration"`
	Strong   float64 `json:"strong"`
	Weak     float64 `json:"weak"`
	Link     string  `json:"link"`
	From     int     `json:"from"`
	To       int     `json:"to"`
	Labels   []struct {
		Place int    `json:"place"`
		Name  string `json:"name"`
		Color string `json:"color"`
	} `json:"labels"`
	Places []int `json:"places"`
}

// padsServiceMessage is one of contracts/pads-service.schema.json.
type padsServiceMessage struct {
	Type     string `json:"type"`
	Device   int    `json:"device"`
	Name     string `json:"name"`
	Standard bool   `json:"standard"`
}

type padRumble struct {
	Type     string  `json:"type"`
	Slot     *int    `json:"slot,omitempty"`
	Device   *int    `json:"device,omitempty"`
	Duration float64 `json:"duration"`
	Strong   float64 `json:"strong"`
	Weak     float64 `json:"weak"`
}

// ScreenMessage mirrors Pads.screenMessage.
func (p *Pads) ScreenMessage(screen *padScreen, link padsLink, message padsScreenMessage) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if screen.link != link || !p.counts(&screen.rate) {
		return
	}
	switch message.Type {
	case "claim":
		at := p.now()
		claims := []*padClaim{}
		for _, claim := range p.claims {
			if claim.screen != screen && at.Sub(claim.at) < padsClaimTime {
				claims = append(claims, claim)
			}
		}
		claims = append(claims, &padClaim{screen: screen, at: at, place: message.Place})
		p.claims = claims
		if len(p.claims) > padsClaims {
			p.claims = p.claims[len(p.claims)-padsClaims:]
		}
	case "release":
		held := screen.slots[message.Slot]
		if held == nil {
			return
		}
		screen.slots[message.Slot] = nil
		if held.box {
			held.on = nil
		} else {
			held.gone = true
			held.link.close(padsReleased)
		}
		p.list(screen)
	case "rumble":
		held := screen.slots[message.Slot]
		rumble := padRumble{Type: "rumble", Duration: message.Duration, Strong: message.Strong, Weak: message.Weak}
		switch {
		case held == nil:
		case !held.box:
			rumble.Slot = &message.Slot
			held.link.text(rumble)
		case p.service != nil:
			rumble.Device = &held.device
			p.service.text(rumble)
		}
	case "show":
		target := p.newestBox(func(item *padScreen) bool { return item != screen && item.access == screen.access }, false)
		if target == nil {
			return
		}
		if target.link != nil {
			target.link.text(map[string]string{"type": "open", "link": message.Link})
		} else {
			target.open = &message.Link
		}
		link.text(map[string]string{"type": "shown", "code": target.code})
	case "move":
		from, to := screen.slots[message.From], screen.slots[message.To]
		if message.From == message.To || (from == nil && to == nil) {
			return
		}
		screen.slots[message.From], screen.slots[message.To] = nil, nil
		if from != nil {
			p.seat(from, screen, message.To, false)
		}
		if to != nil {
			p.seat(to, screen, message.From, false)
		}
		p.list(screen)
	case "labels":
		labels := [padPlaces]*padLabel{}
		for _, item := range message.Labels {
			labels[item.Place] = &padLabel{Name: item.Name, Color: item.Color}
		}
		p.label(screen, labels, true)
	case "local":
		screen.local = [padPlaces]bool{}
		for _, place := range message.Places {
			screen.local[place] = true
		}
		// A place the screen's own gamepad took is no longer to be claimed.
		claims := []*padClaim{}
		for _, claim := range p.claims {
			if claim.screen != screen || claim.place == nil || !screen.local[*claim.place] {
				claims = append(claims, claim)
			}
		}
		p.claims = claims
	}
}

// claimed: the controller whose A went down on its screen takes the place
// the screen claims, when it is free.
func (p *Pads) claimed(held *padController, screen *padScreen) {
	for i, claim := range p.claims {
		if claim.screen != screen || claim.place == nil {
			continue
		}
		if p.now().Sub(claim.at) >= padsClaimTime || !screen.isOpen(*claim.place) {
			return
		}
		p.claims = append(p.claims[:i:i], p.claims[i+1:]...)
		screen.slots[held.place] = nil
		p.seat(held, screen, *claim.place, true)
		return
	}
}

func (p *Pads) expireClaims(at time.Time) {
	claims := []*padClaim{}
	for _, claim := range p.claims {
		if at.Sub(claim.at) < padsClaimTime {
			claims = append(claims, claim)
		}
	}
	p.claims = claims
}

// AttachService: the box's controller service connected, in place of any
// other, whose gamepads are gone.
func (p *Pads) AttachService(link padsLink) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if old := p.service; old != nil {
		p.serviceGone(old)
		old.close(padsDone)
	}
	p.service = link
}

// ServiceMessage: a gamepad appeared or went, or the service's view of the
// controllers (raw, for Box settings).
func (p *Pads) ServiceMessage(link padsLink, message padsServiceMessage, raw json.RawMessage) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if link != p.service {
		return
	}
	if message.Type == "controllers" {
		p.controllers = raw
		return
	}
	index := -1
	for i, device := range p.devices {
		if device.device == message.Device {
			index = i
		}
	}
	switch {
	case message.Type == "gone" && index >= 0:
		p.leave(p.devices[index])
		p.devices = append(p.devices[:index:index], p.devices[index+1:]...)
	case message.Type == "gone":
	case index >= 0:
		known := p.devices[index]
		known.name, known.standard = message.Name, message.Standard
		if known.on != nil {
			p.list(known.on)
		}
	default:
		device := &padController{box: true, device: message.Device, name: message.Name, standard: message.Standard}
		p.devices = append(p.devices, device)
		// The box's own screen takes each gamepad that appears.
		if target := p.newestBox(nil, true); target != nil {
			p.seat(device, target, target.free(), true)
		}
	}
}

// ServiceInput mirrors Pads.serviceInput: false for a frame that isn't a pad
// state. A gamepad on no screen whose button goes down joins the newest
// screen that claims one (its A, for a claim of a place: that place), or else
// the box's own screen; one on a screen whose A goes down while it claims a
// free place takes it.
func (p *Pads) ServiceInput(link padsLink, id int, frame []byte) bool {
	if !validPad(frame) {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var device *padController
	for _, item := range p.devices {
		if item.device == id {
			device = item
		}
	}
	if link != p.service || device == nil || !p.counts(&device.rate) {
		return true
	}
	pressed := binary.LittleEndian.Uint32(frame[4:])
	down := pressed &^ device.pressed
	device.pressed = pressed
	switch {
	case device.on != nil && down&padButtonA != 0:
		p.claimed(device, device.on)
	case device.on == nil && down != 0:
		p.expireClaims(p.now())
		var claim *padClaim
		for i := len(p.claims) - 1; i >= 0 && claim == nil; i-- {
			item := p.claims[i]
			if item.place == nil && item.screen.free() >= 0 || item.place != nil && down&padButtonA != 0 && item.screen.isOpen(*item.place) {
				claim = item
				p.claims = append(p.claims[:i:i], p.claims[i+1:]...)
			}
		}
		switch {
		case claim != nil && claim.place != nil:
			p.seat(device, claim.screen, *claim.place, true)
		case claim != nil:
			p.seat(device, claim.screen, claim.screen.free(), true)
		default:
			if target := p.newestBox(nil, true); target != nil {
				p.seat(device, target, target.free(), true)
			}
		}
	}
	if device.on != nil {
		p.forward(device.on, device.place, frame)
	}
	return true
}

// ServiceGone: the service's connection closed, and its gamepads are gone.
func (p *Pads) ServiceGone(link padsLink) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.serviceGone(link)
}
func (p *Pads) serviceGone(link padsLink) {
	if link != p.service {
		return
	}
	p.service, p.controllers = nil, nil
	for _, device := range p.devices {
		p.leave(device)
	}
	p.devices = nil
}

// ToService sends the service a control message: false while none is
// connected.
func (p *Pads) ToService(message any) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.service == nil {
		return false
	}
	p.service.text(message)
	return true
}

// leave: a gamepad leaves its screen.
func (p *Pads) leave(device *padController) {
	screen := device.on
	if screen == nil {
		return
	}
	device.on = nil
	screen.slots[device.place] = nil
	p.list(screen)
}
