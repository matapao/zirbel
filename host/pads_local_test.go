package main

import (
	"bytes"
	"encoding/json"
	"net"
	"testing"
	"unicode/utf8"

	"zirbel/contracts"
)

// A payload on the box's local socket as serve in packages/server/pads-socket.ts
// reads it: 1, a gamepad's number and its pad state (which goes to the screen
// that gamepad is on, at its place), or 0 and a JSON message of pads-service as
// TextDecoder gives it (UTF-8 only, without a byte order mark in front);
// anything else ends the connection. The service's view is kept as it came.
func FuzzPadsService(f *testing.F) {
	for _, payload := range [][]byte{append([]byte{1, 0}, padFrame(1)...), append([]byte{1, 5}, padFrame(1)...), {1, 0, 0, 2, 0, 0, 0, 0, 0, 0},
		append([]byte{1, 0}, make([]byte, padMaxFrame+1)...), []byte("\x00{\"type\":\"device\",\"device\":3,\"name\":\"Pad\",\"standard\":false,\"uid\":\"usb-1\"}"),
		[]byte("\x00{\"type\":\"gone\",\"device\":0}"), []byte("\x00{\"type\":\"gone\",\"device\":16}"), []byte("\x00{\"type\":\"controllers\",\"pads\":[]}"),
		[]byte("\x00\xef\xbb\xbf{\"type\":\"controllers\"}"), []byte("\x00\xef\xbb\xbf\xef\xbb\xbf{\"type\":\"controllers\"}"),
		[]byte("\x00{\"type\":\"controllers\",\"name\":\"\xff\"}"), []byte("\x00 {\"type\":\"gone\",\"device\":1} "), []byte("\x00"), {2, 0}, {1}} {
		f.Add(payload)
	}
	_, clock := padClock()
	f.Fuzz(func(t *testing.T, payload []byte) {
		if len(payload) == 0 {
			return // a frame of no length ends the connection before its payload
		}
		pads := NewPads(clock)
		near, far := net.Pipe()
		defer func() { _ = far.Close() }()
		c := &serviceConn{conn: near, out: make(chan []byte, 256), done: make(chan struct{})}
		defer c.close(padsDone)
		pads.AttachService(c)
		tv := &fakePadLink{}
		screen := opened(t, pads.OpenScreen(tv, "lan", true, ""))
		if !servicePayload(pads, c, append([]byte{0}, `{"type":"device","device":0,"name":"Pad","standard":true}`...)) || screen.slots[0] == nil {
			t.Fatal("the box's gamepad has no place")
		}
		frames := len(tv.frames)
		want, view := false, false
		text := bytes.TrimPrefix(payload[1:], []byte("\xef\xbb\xbf"))
		switch {
		case payload[0] == 1 && len(payload) >= 2 && len(payload) <= 2+padMaxFrame:
			want = decodedPad(payload[2:]) != nil
		case payload[0] == 0 && utf8.Valid(payload[1:]) && json.Valid(text):
			value, err := contracts.Decode(text)
			want = err == nil && contracts.Validate("pads-service", value) == nil
			message, _ := value.(map[string]any)
			view = want && message["type"] == "controllers"
		}
		if got := servicePayload(pads, c, payload); got != want {
			t.Fatalf("%q: read %v; Node reads %v", payload, got, want)
		}
		forwarded := len(tv.frames) - frames
		if payload[0] == 1 && want && payload[1] == 0 {
			if forwarded != 1 || !bytes.Equal(tv.frames[len(tv.frames)-1], append([]byte{0}, payload[3:]...)) {
				t.Fatalf("%q: the screen has % x", payload, tv.frames[frames:])
			}
		} else if forwarded != 0 {
			t.Fatalf("%q: %d frames went to the screen", payload, forwarded)
		}
		if kept := pads.Controllers(); (kept != nil) != view || view && !bytes.Equal(kept, text) {
			t.Fatalf("%q: the view is kept as %q", payload, kept)
		}
	})
}
