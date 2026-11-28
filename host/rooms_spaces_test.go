package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A page's proof as a net game's room info reads it, as the info route in
// packages/server/player-listener.ts and Rooms.proven in
// packages/core/rooms.ts read it: the Authorization header less a leading
// "Bearer ", asked of the kernel only when it is a proof as the kernel makes
// one (/^[A-Za-z0-9_-]{16,100}$/), else naming no member. Here no kernel
// runs: a proof it would be asked about is 503, anything else no member.
func FuzzSpaceProof(f *testing.F) {
	for _, header := range []string{"Bearer AAAAAAAAAAAAAAAAAAAAAA", "Bearer short", "bearer AAAAAAAAAAAAAAAAAAAAAA",
		"AAAAAAAAAAAAAAAAAAAAAA", "Bearer  AAAAAAAAAAAAAAAAAAAAAA", "Bearer AAAAAAAAAAAAAAAAAAAAAA\n", "Bearer AAAAAAAA.AAAAAAAAAAAAAA",
		"Bearer " + strings.Repeat("a", 100), "Bearer " + strings.Repeat("_", 101), "Bearer Bearer AAAAAAAAAAAAAAAA",
		"Bearer AAAAAAAAAAAAAAAAAAAAAé", "Bearer 0123456789ab", ""} {
		f.Add(header)
	}
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
	rooms := &Rooms{kernel: &Spaces{}}
	room := &Room{space: &roomSpace{ID: "0123456789ab", Invite: "AAAAAAAAAAAAAAAAAAAAAA"}}
	f.Fuzz(func(t *testing.T, header string) {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/rooms/"+room.space.ID+"/info", http.NoBody)
		r.Header.Set("Authorization", header)
		proof := bearer(r)
		if want, _ := strings.CutPrefix(header, "Bearer "); proof != want {
			t.Fatalf("%q: proof %q; Node reads %q", header, proof, want)
		}
		formed := len(proof) >= 16 && len(proof) <= 100 && strings.Trim(proof, alphabet) == ""
		proven, err := rooms.Proven(room, proof)
		if proven {
			t.Fatalf("%q: proven with no kernel", proof)
		}
		unavailable, asked := errors.AsType[*HTTPError](err)
		if asked && unavailable.Status != http.StatusServiceUnavailable || asked != formed || !asked && err != nil {
			t.Fatalf("%q: a proof as the kernel makes one %v, asked of it %v (%v)", proof, formed, asked, err)
		}
		// A room without a space has no members to prove.
		if proven, err := rooms.Proven(&Room{}, proof); proven || err != nil {
			t.Fatalf("%q: proven %v in a room without a space (%v)", proof, proven, err)
		}
	})
}
