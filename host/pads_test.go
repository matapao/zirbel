package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"slices"
	"testing"
	"time"
)

// The pads' routing over fake sockets, with its clock in hand: what the
// contract test (test/pads.contract.test.ts) can't wait for, a screen's 15 s,
// a phone's place kept 60 s, a claim's 30 s, and the limits.

type fakePadLink struct {
	texts  []map[string]any
	frames [][]byte
	closed int
}

func (f *fakePadLink) text(message any) {
	data, _ := json.Marshal(message)
	var value map[string]any
	_ = json.Unmarshal(data, &value)
	f.texts = append(f.texts, value)
}
func (f *fakePadLink) binary(frame []byte) { f.frames = append(f.frames, frame) }
func (f *fakePadLink) close(code int) {
	if f.closed == 0 {
		f.closed = code
	}
}
func (f *fakePadLink) last(kind string) map[string]any {
	for _, text := range slices.Backward(f.texts) {
		if text["type"] == kind {
			return text
		}
	}
	return nil
}

func padFrame(pressed uint32) []byte {
	return append(binary.LittleEndian.AppendUint32([]byte{0, 1, 17, 0}, pressed), make([]byte, 17)...)
}

// listed is a screen's last list of its controllers.
func (f *fakePadLink) listed() []any {
	list, _ := f.last("pads")["pads"].([]any)
	return list
}

// opened is what a test opened, which must be there.
func opened[T any](t *testing.T, value *T) *T {
	t.Helper()
	if value == nil {
		t.Fatal("refused")
	}
	return value
}

func padClock() (*time.Time, func() time.Time) {
	now := time.Unix(1_000_000, 0)
	return &now, func() time.Time { return now }
}

func TestValidPadFrames(t *testing.T) {
	cases := map[string]struct {
		frame []byte
		valid bool
	}{
		"empty pad":           {[]byte{7, 0, 0, 0, 0, 0, 0, 0}, true},
		"standard":            {padFrame(5), true},
		"largest":             {append([]byte{0, 0, 32, 8, 255, 255, 255, 255}, make([]byte, 48)...), true},
		"short":               {[]byte{0, 1, 0, 0, 0, 0, 0}, false},
		"slot past 7":         {[]byte{8, 0, 0, 0, 0, 0, 0, 0}, false},
		"other flags":         {[]byte{0, 2, 0, 0, 0, 0, 0, 0}, false},
		"33 buttons":          {[]byte{0, 0, 33, 0, 0, 0, 0, 0}, false},
		"9 axes":              {[]byte{0, 0, 0, 9, 0, 0, 0, 0}, false},
		"long":                {[]byte{0, 0, 1, 0, 0, 0, 0, 0, 255, 0}, false},
		"cut":                 {[]byte{0, 0, 0, 1, 0, 0, 0, 0, 0}, false},
		"pressed past last":   {[]byte{0, 0, 1, 0, 2, 0, 0, 0, 0}, false},
		"axis past its range": {[]byte{0, 0, 0, 1, 0, 0, 0, 0, 0x00, 0x80}, false},
	}
	for name, item := range cases {
		if validPad(item.frame) != item.valid {
			t.Errorf("%s: valid %v", name, !item.valid)
		}
	}
}

func TestPadsKeepAScreenFifteenSecondsAndAPhonesPlaceAMinute(t *testing.T) {
	now, clock := padClock()
	pads := NewPads(clock)
	tv := &fakePadLink{}
	screen := opened(t, pads.OpenScreen(tv, "lan", false, ""))
	phone, other := &fakePadLink{}, &fakePadLink{}
	pads.OpenPad(phone, "lan", "192.168.1.20", screen.code, nil, "")
	dropped := opened(t, pads.OpenPad(other, "lan", "192.168.1.20", screen.code, nil, ""))
	pads.PadGone(dropped)
	*now = now.Add(padResume - time.Second)
	pads.Sweep()
	if back := opened(t, pads.OpenPad(&fakePadLink{}, "lan", "192.168.1.20", screen.code, nil, dropped.resume)); back.place != 1 {
		t.Fatalf("its place back within the minute: %d", back.place)
	}
	late := opened(t, pads.OpenPad(&fakePadLink{}, "lan", "192.168.1.20", screen.code, nil, ""))
	pads.PadGone(late)
	*now = now.Add(padResume)
	pads.Sweep()
	if again := opened(t, pads.OpenPad(&fakePadLink{}, "lan", "192.168.1.20", screen.code, nil, late.resume)); again.resume == late.resume {
		t.Fatal("a place kept past its minute")
	}
	// The screen's socket drops; 15 s later it ends, and its phones hear it.
	pads.ScreenGone(screen, tv, 1006)
	*now = now.Add(padsResume - time.Second)
	pads.Sweep()
	if phone.closed != 0 {
		t.Fatal("ended before its 15 s")
	}
	*now = now.Add(time.Second)
	pads.Sweep()
	if phone.closed != padsDone || phone.texts[len(phone.texts)-1]["type"] != "closed" {
		t.Fatalf("its phone: %d %v", phone.closed, phone.texts)
	}
	if opened(t, pads.OpenScreen(&fakePadLink{}, "lan", false, screen.resume)).code == screen.code {
		t.Fatal("an ended screen resumed")
	}
}

func TestPadsClaimsLastThirtySeconds(t *testing.T) {
	now, clock := padClock()
	pads := NewPads(clock)
	service := &fakePadLink{}
	pads.AttachService(service)
	pads.ServiceMessage(service, padsServiceMessage{Type: "device", Device: 3, Name: "Pad", Standard: true}, nil)
	laptop := &fakePadLink{}
	screen := opened(t, pads.OpenScreen(laptop, "lan", false, ""))
	pads.ScreenMessage(screen, laptop, padsScreenMessage{Type: "claim"})
	*now = now.Add(padsClaimTime)
	pads.Sweep()
	pads.ServiceInput(service, 3, padFrame(1))
	if len(laptop.listed()) != 0 {
		t.Fatal("an old claim took a gamepad")
	}
	place := 2
	pads.ScreenMessage(screen, laptop, padsScreenMessage{Type: "claim", Place: &place})
	pads.ServiceInput(service, 3, padFrame(0))
	pads.ServiceInput(service, 3, padFrame(2))
	if len(laptop.listed()) != 0 {
		t.Fatal("a claim of a place taken without A")
	}
	pads.ServiceInput(service, 3, padFrame(3))
	listed := laptop.listed()
	if item, _ := listed[0].(map[string]any); len(listed) != 1 || item["place"] != 2.0 || laptop.frames[len(laptop.frames)-1][0] != 2 {
		t.Fatalf("the claimed place: %v", listed)
	}
	if !pads.ToService(map[string]any{"type": "scan", "on": true}) || service.last("scan") == nil {
		t.Fatal("the service hears the host")
	}
	pads.ServiceGone(service)
	if pads.ToService(map[string]any{"type": "scan"}) || len(laptop.listed()) != 0 {
		t.Fatal("its gamepads go with the service")
	}
}

func TestPadsLimits(t *testing.T) {
	now, clock := padClock()
	pads := NewPads(clock)
	for range padsScreens {
		if pads.OpenScreen(&fakePadLink{}, "lan", false, "") == nil {
			t.Fatal("a listener holds 64 screens")
		}
	}
	refused := &fakePadLink{}
	if pads.OpenScreen(refused, "lan", false, "") != nil || refused.closed != padsFull {
		t.Fatal("a 65th screen")
	}
	tv := &fakePadLink{}
	screen := opened(t, pads.OpenScreen(tv, "local", false, ""))
	phone := opened(t, pads.OpenPad(&fakePadLink{}, "local", "127.0.0.1", screen.code, nil, ""))
	for range 130 {
		pads.PadFrame(phone, padFrame(0))
	}
	if len(tv.frames) != padsPerSecond {
		t.Fatalf("%d frames in a second", len(tv.frames))
	}
	wrong := "ZZZZ"
	if screen.code == wrong {
		wrong = "YYYY"
	}
	for i := range wrongSessionCodes {
		link := &fakePadLink{}
		if pads.OpenPad(link, "local", "::ffff:192.168.1.30", []string{"nope", wrong}[i%2], nil, "") != nil || link.closed != padsUnknown {
			t.Fatal("a wrong code")
		}
	}
	blocked := &fakePadLink{}
	if pads.OpenPad(blocked, "local", "192.168.1.30", screen.code, nil, ""); blocked.closed != padsTries {
		t.Fatalf("too many wrong codes: %d", blocked.closed)
	}
	*now = now.Add(time.Minute)
	if pads.OpenPad(&fakePadLink{}, "local", "192.168.1.30", screen.code, nil, "") == nil {
		t.Fatal("after the minute")
	}
}

// A pad's frame as decodePad and encodePad in packages/sdk/pads.ts read and
// write it: validPad takes exactly the frames that decode, which keep the
// limits and encode again to the same bytes; a phone's goes to its screen with
// its slot made the phone's place, and any other closes the phone.
func FuzzPadFrame(f *testing.F) {
	for _, frame := range [][]byte{padFrame(5), {7, 0, 0, 0, 0, 0, 0, 0}, append([]byte{0, 0, 32, 8, 255, 255, 255, 255}, make([]byte, 48)...),
		{3, 1, 2, 2, 3, 0, 0, 0, 128, 255, 0xff, 0x7f, 0x01, 0x80}, {0, 1, 0, 0, 0, 0, 0}, {8, 0, 0, 0, 0, 0, 0, 0}, {0, 2, 0, 0, 0, 0, 0, 0},
		{0, 0, 33, 0, 0, 0, 0, 0}, {0, 0, 0, 9, 0, 0, 0, 0}, {0, 0, 1, 0, 2, 0, 0, 0, 0}, {0, 0, 0, 1, 0, 0, 0, 0, 0x00, 0x80}} {
		f.Add(frame, uint8(5))
	}
	_, clock := padClock()
	f.Fuzz(func(t *testing.T, frame []byte, place uint8) {
		state, valid := decodedPad(frame), validPad(frame)
		if valid != (state != nil) {
			t.Fatalf("% x: valid %v, decodePad reads %+v", frame, valid, state)
		}
		if valid {
			buttons, axes, pressed := int(frame[2]), int(frame[3]), binary.LittleEndian.Uint32(frame[4:])
			if frame[0] >= padPlaces || frame[1] > padStandardBit || buttons > 32 || axes > 8 || len(frame) != 8+buttons+2*axes ||
				len(frame) > padMaxFrame || buttons < 32 && pressed>>buttons != 0 {
				t.Fatalf("% x: valid past the limits", frame)
			}
			for i := range axes {
				if binary.LittleEndian.Uint16(frame[8+buttons+2*i:]) == 0x8000 {
					t.Fatalf("% x: valid with an axis of -32768", frame)
				}
			}
			if again := encodedPad(*state); !bytes.Equal(again, frame) {
				t.Fatalf("% x decodes to %+v, which encodes to % x", frame, *state, again)
			}
		}
		pads := NewPads(clock)
		tv, link := &fakePadLink{}, &fakePadLink{}
		screen := opened(t, pads.OpenScreen(tv, "lan", false, ""))
		asked := int(place % padPlaces)
		phone := opened(t, pads.OpenPad(link, "lan", "192.168.1.20", screen.code, &asked, ""))
		sent := append([]byte(nil), frame...)
		pads.PadFrame(phone, sent)
		clear(sent) // what the screen has is its own copy
		switch {
		case !valid && (len(tv.frames) != 0 || link.closed != padsUnsupported || screen.slots[asked] != nil):
			t.Fatalf("% x: not a frame, yet %d went on, the phone closed with %d", frame, len(tv.frames), link.closed)
		case valid && (len(tv.frames) != 1 || link.closed != 0):
			t.Fatalf("% x: %d frames went on, the phone closed with %d", frame, len(tv.frames), link.closed)
		case valid && (!bytes.Equal(tv.frames[0], append([]byte{byte(asked)}, frame[1:]...)) || !validPad(tv.frames[0])):
			t.Fatalf("% x from place %d went on as % x", frame, asked, tv.frames[0])
		}
	})
}

// padState is a pad's state as decodePad gives it.
type padState struct {
	slot     byte
	standard bool
	pressed  []bool
	values   []float64
	axes     []float64
}

// decodedPad is decodePad in packages/sdk/pads.ts, with JavaScript's doubles.
func decodedPad(frame []byte) *padState {
	if len(frame) < 8 {
		return nil
	}
	slot, flags, count, axisCount := frame[0], frame[1], int(frame[2]), int(frame[3])
	if slot >= 8 || flags&^1 != 0 || count > 32 || axisCount > 8 || len(frame) != 8+count+2*axisCount {
		return nil
	}
	pressed := binary.LittleEndian.Uint32(frame[4:])
	if count < 32 && pressed>>count != 0 {
		return nil
	}
	state := &padState{slot: slot, standard: flags&1 != 0}
	for index := range axisCount {
		axis := int16(binary.LittleEndian.Uint16(frame[8+count+2*index:])) // #nosec G115 -- a signed axis, as sent
		if axis < -32767 {
			return nil
		}
		state.axes = append(state.axes, float64(axis)/32767)
	}
	for index, value := range frame[8 : 8+count] {
		state.pressed = append(state.pressed, pressed>>index&1 == 1)
		state.values = append(state.values, float64(value)/255)
	}
	return state
}

// encodedPad is encodePad, with JavaScript's Math.round (half up).
func encodedPad(state padState) []byte {
	round := func(value float64) float64 {
		whole := math.Floor(value)
		if value-whole >= 0.5 {
			whole++
		}
		return whole
	}
	flags := byte(0)
	if state.standard {
		flags = 1
	}
	frame := []byte{state.slot, flags, byte(len(state.values)), byte(len(state.axes)), 0, 0, 0, 0} // #nosec G115 -- at most 32 and 8
	pressed := uint32(0)
	for index, value := range state.values {
		if state.pressed[index] {
			pressed |= 1 << index
		}
		frame = append(frame, byte(round(min(1, max(0, value))*255)))
	}
	binary.LittleEndian.PutUint32(frame[4:], pressed)
	for _, axis := range state.axes {
		frame = binary.LittleEndian.AppendUint16(frame, uint16(int16(round(min(1, max(-1, axis))*32767)))) // #nosec G115 -- -32767 to 32767
	}
	return frame
}
