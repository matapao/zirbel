package main

import (
	"encoding/binary"
	"encoding/json"
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
	for i := len(f.texts) - 1; i >= 0; i-- {
		if f.texts[i]["type"] == kind {
			return f.texts[i]
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
