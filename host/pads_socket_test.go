package main

import (
	"encoding/json"
	"regexp"
	"testing"
	"unicode/utf16"
	"unicode/utf8"

	"zirbel/contracts"
)

// A control message on /pads as read in packages/server/pads-socket.ts reads
// it: 1007 for one that isn't JSON, 1008 for one that isn't a message of its
// contract, else the message, which keeps its limits (places and slots 0 to 7,
// at most 8 labels and places, a name of 1 to 24 UTF-16 code units, a colour
// #rrggbb, a rumble within its range, a link to a join page) and which the
// pads then take with every controller still in its own place.
func FuzzPadsMessage(f *testing.F) {
	for _, message := range []string{`{"type":"claim"}`, `{"type":"claim","place":7}`, `{"type":"claim","place":8}`, `{"type":"release","slot":1}`,
		`{"type":"rumble","slot":0,"duration":200,"strong":1,"weak":0.5}`, `{"type":"rumble","slot":0,"duration":5001,"strong":1,"weak":0}`,
		`{"type":"show","link":"/join/abc#skalet.invite=x"}`, `{"type":"show","link":"/join/../x"}`, `{"type":"move","from":0,"to":1}`,
		`{"type":"labels","labels":[{"place":1,"name":"Red car","color":"#d03030"}]}`, `{"type":"labels","labels":[{"place":1,"name":"","color":"#d03030"}]}`,
		`{"type":"local","places":[0,2]}`, `{"type":"local","places":[8]}`, `{"type":"place","place":3}`, `{"type":"place","place":3.0}`,
		`{"type":"place","place":-0}`, `{"type":"place","place":3,"type":"claim"}`, `{"type":"place","place":"3"}`, `not json`, `{"type":`, `[]`,
		`{"type":"claim"} {}`, `{"type":"labels","labels":[{"place":0,"name":"` + "\U0001F697" + `","color":"#000000"}]}`} {
		f.Add([]byte(message), true)
		f.Add([]byte(message), false)
	}
	_, clock := padClock()
	link := regexp.MustCompile(`^/join/[a-z0-9]{1,64}(?:#[A-Za-z0-9_.&=-]{1,180})?$`)
	color := regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	place := func(value int) bool { return value >= 0 && value < padPlaces }
	f.Fuzz(func(t *testing.T, data []byte, screen bool) {
		if !utf8.Valid(data) {
			return // the socket closes a text frame that isn't UTF-8 with 1007 before it is read
		}
		contract := map[bool]string{true: "pads-screen", false: "pads-pad"}[screen]
		want := 0
		if value, err := contracts.Decode(data); !json.Valid(data) || err != nil {
			want = closeInvalidData
		} else if contracts.Validate(contract, value) != nil {
			want = closePolicy
		}
		c := newPadConn(nil, func() {})
		closing := func() int {
			c.mu.Lock()
			defer c.mu.Unlock()
			return c.closing
		}
		pads := NewPads(clock)
		service, tv := &fakePadLink{}, &fakePadLink{}
		pads.AttachService(service)
		pads.ServiceMessage(service, padsServiceMessage{Type: "device", Device: 2, Name: "Pad", Standard: true}, nil)
		held := opened(t, pads.OpenScreen(tv, "lan", true, ""))
		phone := opened(t, pads.OpenPad(&fakePadLink{}, "lan", "192.168.1.20", held.code, nil, ""))
		if screen {
			message, ok := padMessage(c, contract, data, &padsScreenMessage{})
			if code := closing(); ok == (code != 0) || code != want {
				t.Fatalf("%s: read %v, closed with %d; Node closes with %d", data, ok, code, want)
			}
			if !ok {
				return
			}
			m := *message
			name := func(text string) bool { length := len(utf16.Encode([]rune(text))); return length >= 1 && length <= 24 }
			labels := len(m.Labels) <= padPlaces
			for _, label := range m.Labels {
				labels = labels && place(label.Place) && name(label.Name) && color.MatchString(label.Color)
			}
			places := len(m.Places) <= padPlaces
			for _, item := range m.Places {
				places = places && place(item)
			}
			if !map[string]bool{
				"claim":   m.Place == nil || place(*m.Place),
				"release": place(m.Slot),
				"rumble":  place(m.Slot) && m.Duration >= 0 && m.Duration <= 5000 && m.Strong >= 0 && m.Strong <= 1 && m.Weak >= 0 && m.Weak <= 1,
				"show":    len(m.Link) <= 256 && link.MatchString(m.Link),
				"move":    place(m.From) && place(m.To),
				"labels":  labels,
				"local":   places,
			}[m.Type] {
				t.Fatalf("%s: read past its limits as %+v", data, m)
			}
			pads.ScreenMessage(held, tv, m)
		} else {
			message, ok := padMessage(c, contract, data, &struct {
				Place int `json:"place"`
			}{})
			if code := closing(); ok == (code != 0) || code != want {
				t.Fatalf("%s: read %v, closed with %d; Node closes with %d", data, ok, code, want)
			}
			if !ok {
				return
			}
			if !place(message.Place) {
				t.Fatalf("%s: place %d", data, message.Place)
			}
			pads.PadMessage(phone, message.Place)
		}
		for at, controller := range held.slots {
			if controller != nil && (controller.place != at || controller.on != held) {
				t.Fatalf("%s: place %d holds a controller of place %d", data, at, controller.place)
			}
		}
	})
}
