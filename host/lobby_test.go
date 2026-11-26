package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// storedRelease writes a release of game for up to players into the store: a
// multiplayer one with shared state, or a one-player one.
func storedRelease(t *testing.T, releases *Releases, id, game, title string, players int, play bool) *Release {
	t.Helper()
	content := `{"html":"<canvas></canvas>","maxPlayers":` + strconv.Itoa(players) + `}`
	var simulation any
	capabilities := []string{}
	if players > 1 {
		simulation, capabilities = "shared-state-v1", []string{"multiplayer"}
	}
	document := map[string]any{
		"manifest": map[string]any{
			"format": 1, "releaseId": id, "gameId": game, "sourceRevision": "s1", "title": title, "sdk": "1.0.0",
			"protocol": 1, "client": "player.html", "simulation": simulation, "players": map[string]int{"min": 1, "max": players},
			"capabilities": capabilities, "permissions": map[string]bool{"play": play, "download": false, "remix": false},
			"assets": []any{}, "credits": []any{}, "files": map[string]string{"player.js": digest([]byte("ok"))},
		},
		"game": json.RawMessage(content), "sceneHash": digest([]byte(content)),
		"files": map[string]string{"player.js": base64.StdEncoding.EncodeToString([]byte("ok"))}, "assets": map[string]string{},
	}
	data, _ := jsJSON(document)
	release, err := ParseRelease(data)
	if err != nil {
		t.Fatal(err)
	}
	path, _ := releases.path(id)
	if err := atomicWrite(path, release.canonical); err != nil {
		t.Fatal(err)
	}
	return release
}

// testLobby is a lobby over a fresh data directory, with a clock the test turns.
func testLobby(t *testing.T) (*Lobby, *Rooms, *time.Time) {
	t.Helper()
	root := t.TempDir()
	releases, err := NewReleases(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	rooms := NewRooms()
	t.Cleanup(rooms.Dispose)
	lobby, err := NewLobby(root, rooms, releases)
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Now()
	lobby.codes.now = func() time.Time { return clock }
	return lobby, rooms, &clock
}

func TestSessionCodesAreShortUnambiguousAndReadAsTyped(t *testing.T) {
	for range 200 {
		code := randomSessionCode()
		if len(code) != 4 || strings.ContainsAny(code, "01OI") || sessionCode(code) != code {
			t.Fatalf("code %q", code)
		}
	}
	for _, typed := range [][2]string{{"kq7m", "KQ7M"}, {"KQ-7M", "KQ7M"}, {" k q-7 m ", "KQ7M"}, {"kq7", ""}, {"kq7mm", ""},
		{"KQ0M", ""}, {"KQIM", ""}, {"KQOM", ""}, {"KQ1M", ""}, {"", ""}, {"KQ_7M", ""}, {"kq\v7m", ""}, {"kq7\u017f", ""}, {"\tk\nq\f7\rm", "KQ7M"}} {
		if got := sessionCode(typed[0]); got != typed[1] {
			t.Errorf("sessionCode(%q) = %q, want %q", typed[0], got, typed[1])
		}
	}
	if len(sessionAlphabet) != 32 {
		t.Fatal("the alphabet must divide a byte evenly")
	}
	rooms := &Rooms{rooms: map[string]*Room{}}
	for i := range 20 {
		rooms.rooms[strconv.Itoa(i)] = &Room{Code: rooms.freeCode()}
	}
	codes := map[string]bool{}
	for _, room := range rooms.rooms {
		codes[room.Code] = true
	}
	if len(codes) != 20 {
		t.Fatal("two open rooms got the same code")
	}
}

func TestTheLobbyOffersOneReleasePerGameAndKeepsTheList(t *testing.T) {
	lobby, rooms, _ := testLobby(t)
	storedRelease(t, lobby.releases, "first", "g1", "Garden", 2, true)
	storedRelease(t, lobby.releases, "second", "g1", "Garden", 2, true)
	storedRelease(t, lobby.releases, "other", "g2", "Tiles", 1, true)
	storedRelease(t, lobby.releases, "closed", "g3", "Private", 2, false)
	offer := func(id string, on bool, want ...string) {
		t.Helper()
		list, err := lobby.Offer(id, on)
		if err != nil || !slices.Equal(list, append([]string{}, want...)) {
			t.Fatalf("offer %s %v: %v %v, want %v", id, on, list, err, want)
		}
	}
	offer("first", true, "first")
	offer("other", true, "first", "other")
	// Another release of the same game takes its place.
	offer("second", true, "other", "second")
	offer("second", true, "other", "second")
	if _, err := lobby.Offer("missing", true); statusOf(err) != http.StatusNotFound {
		t.Fatalf("a missing release: %v", err)
	}
	if _, err := lobby.Offer("closed", true); statusOf(err) != http.StatusForbidden {
		t.Fatalf("a release without play: %v", err)
	}
	offer("first", false, "other", "second")
	offer("other", false, "second")
	offer("other", true, "second", "other")
	data, err := os.ReadFile(lobby.file)
	if err != nil || string(data) != `{"version":1,"offered":["second","other"]}` {
		t.Fatalf("lobby.json: %s %v", data, err)
	}
	again, err := NewLobby(filepath.Dir(lobby.file), rooms, lobby.releases)
	if err != nil || !slices.Equal(again.Offered(), []string{"second", "other"}) {
		t.Fatalf("read back: %v %v", again, err)
	}
	for _, broken := range []string{`[]`, `{"offered":[]}`, `{"version":2,"offered":[]}`, `{"version":1,"offered":null}`, `{"version":1,"offered":["Bad ID"]}`,
		`{"version":1,"offered":["a","a"]}`, `{"version":1,"offered":[],"x":1}`, `{"offered":"none"}`, `{`} {
		if err := os.WriteFile(lobby.file, []byte(broken), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := NewLobby(filepath.Dir(lobby.file), rooms, lobby.releases); !errors.Is(err, errLobbyUnreadable) {
			t.Errorf("%s was read as a lobby", broken)
		}
	}
}

func TestTheLobbyStartsSessionsAndSeatsGuestsByCode(t *testing.T) {
	lobby, rooms, clock := testLobby(t)
	storedRelease(t, lobby.releases, "shared", "g1", "zebra Garden", 2, true)
	storedRelease(t, lobby.releases, "alone", "g2", "Apple Walk", 1, true)
	storedRelease(t, lobby.releases, "hidden", "g3", "Hidden", 2, true)
	for _, id := range []string{"shared", "alone"} {
		if _, err := lobby.Offer(id, true); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := lobby.Start("hidden", "Ada", "lan", "10.0.0.2"); statusOf(err) != http.StatusNotFound {
		t.Fatalf("a game that isn't offered: %v", err)
	}
	room, ticket, err := lobby.Start("shared", "Ada", "lan", "10.0.0.2")
	if err != nil || room.Code == "" || room.Solo || room.Access != "lan" {
		t.Fatalf("a multiplayer session: %+v %v", room, err)
	}
	peer := &recorder{}
	if room.Connect(hello{Credential: ticket, ReleaseID: "shared"}, peer) == "" {
		t.Fatalf("the starter's seat: %s", peer.messages)
	}
	solo, soloTicket, err := lobby.Start("alone", "Bo", "lan", "10.0.0.3")
	if err != nil || solo.Code != "" || !solo.Solo || soloTicket == "" {
		t.Fatalf("a one-player session: %+v %v", solo, err)
	}

	state := lobby.State("lan", "")
	if len(state.Games) != 2 || state.Games[0].Title != "Apple Walk" || state.Games[0].Multiplayer || !state.Games[1].Multiplayer ||
		state.Games[1].Players != (playerRange{1, 2}) {
		t.Fatalf("games %+v", state.Games)
	}
	if len(state.Sessions) != 1 || state.Sessions[0] != (lobbySession{room.Session, "zebra Garden", 1, 2, isoTime(room.Started)}) {
		t.Fatalf("sessions %+v", state.Sessions)
	}
	if listed, _ := json.Marshal(state); strings.Contains(string(listed), room.Code) || strings.Contains(string(listed), "Ada") {
		t.Fatalf("the lobby told a code or a name: %s", listed)
	}
	if len(lobby.State("local", "").Sessions) != 0 {
		t.Fatal("a LAN session was listed on the loopback listener")
	}

	// The code joins in any case, with a dash, even once the room's invitation has expired.
	room.mu.Lock()
	room.InviteExpires = time.Now().Add(-time.Minute)
	room.mu.Unlock()
	typed := strings.ToLower(room.Code[:2]) + "-" + room.Code[2:]
	joined, second, err := lobby.Join(typed, "Cy", "lan", "10.0.0.4")
	if err != nil || joined != room {
		t.Fatalf("join %q: %v", typed, err)
	}
	if _, _, err := lobby.Join(room.Code, "Cy", "local", "10.0.0.4"); statusOf(err) != http.StatusNotFound {
		t.Fatalf("a LAN session joined from the loopback listener: %v", err)
	}
	// The players' seats are taken or held, so the next guest watches.
	_, third, err := lobby.Join(room.Code, "Di", "lan", "10.0.0.4")
	if err != nil {
		t.Fatal(err)
	}
	room.Connect(hello{Credential: second, ReleaseID: "shared"}, &recorder{})
	watcher := &recorder{}
	room.Connect(hello{Credential: third, ReleaseID: "shared"}, watcher)
	if !strings.Contains(string(watcher.messages[0]), `"role":"spectator"`) {
		t.Fatalf("the third guest: %s", watcher.messages[0])
	}
	if lobby.State("lan", "").Sessions[0].Players != 2 {
		t.Fatal("the session does not count its players")
	}
	// Three more spectators beside the one watching fill the room.
	for range 3 {
		if _, _, err := lobby.Join(room.Code, "Ev", "lan", "10.0.0.9"); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := lobby.Join(room.Code, "Fy", "lan", "10.0.0.9"); statusOf(err) != http.StatusConflict {
		t.Fatalf("a full session: %v", err)
	}

	// Ten wrong codes in a minute, then the address waits out that minute.
	for i := range wrongSessionCodes {
		if _, _, err := lobby.Join("ZZZZ", "Gu", "lan", "10.0.0.5"); statusOf(err) != http.StatusNotFound {
			t.Fatalf("wrong code %d: %v", i+1, err)
		}
	}
	if _, _, err := lobby.Join(room.Code, "Gu", "lan", "10.0.0.5"); statusOf(err) != http.StatusTooManyRequests {
		t.Fatalf("the eleventh try: %v", err)
	}
	if _, _, err := lobby.Join("ZZZZ", "Gu", "lan", "10.0.0.6"); statusOf(err) != http.StatusNotFound {
		t.Fatalf("another address: %v", err)
	}
	*clock = clock.Add(time.Minute)
	if _, _, err := lobby.Join("ZZZZ", "Gu", "lan", "10.0.0.5"); statusOf(err) != http.StatusNotFound {
		t.Fatalf("a minute later: %v", err)
	}

	// The owner ends a session with the room; its code goes with it.
	rooms.Close(room.ID)
	if _, _, err := lobby.Join(room.Code, "Ha", "lan", "10.0.0.7"); statusOf(err) != http.StatusNotFound {
		t.Fatalf("an ended session: %v", err)
	}
}

func TestLobbySessionsHaveLimits(t *testing.T) {
	lobby, rooms, _ := testLobby(t)
	storedRelease(t, lobby.releases, "shared", "g1", "Garden", 2, true)
	if _, err := lobby.Offer("shared", true); err != nil {
		t.Fatal(err)
	}
	for i := range sessionsPerGuest {
		if _, _, err := lobby.Start("shared", "Ada", "lan", "10.0.0.2"); err != nil {
			t.Fatalf("session %d: %v", i+1, err)
		}
	}
	if _, _, err := lobby.Start("shared", "Ada", "lan", "10.0.0.2"); statusOf(err) != http.StatusTooManyRequests {
		t.Fatalf("a fourth from one address: %v", err)
	}
	// The host's own loopback is its owner's: held to the host's limit alone.
	for i := sessionsPerGuest; i < lobbySessions; i++ {
		if _, _, err := lobby.Start("shared", "Bo", "local", "127.0.0.1"); err != nil {
			t.Fatalf("session %d: %v", i+1, err)
		}
	}
	for _, from := range []string{"10.0.2.1", "127.0.0.1"} {
		if _, _, err := lobby.Start("shared", "Cy", "lan", from); statusOf(err) != http.StatusTooManyRequests ||
			err.Error() != "The lobby is full. Join a session, or try again when one ends." {
			t.Fatalf("the seventeenth from %s: %v", from, err)
		}
	}
	if !isLoopbackAddress("::1") || !isLoopbackAddress("127.4.5.6") || !isLoopbackAddress(plainAddress("::ffff:127.0.0.1")) ||
		isLoopbackAddress("10.0.0.2") || isLoopbackAddress("::ffff:10.0.0.2") {
		t.Fatal("loopback is not read as Node reads it")
	}
	// The owner's own rooms are not lobby sessions.
	release, err := lobby.releases.Read("shared")
	if err != nil {
		t.Fatal(err)
	}
	owned, err := rooms.Open(release, false, "lan", false)
	if err != nil || owned.Code == "" {
		t.Fatalf("the owner's LAN room: %+v %v", owned, err)
	}
	if local, err := rooms.Open(release, false, "local", false); err != nil || local.Code != "" {
		t.Fatalf("the owner's local room: %+v %v", local, err)
	}
	// A session nobody plays ends after the idle limit, though its invitation is still valid.
	session := rooms.Sessions("lan")[1] // the newest is the owner's
	for _, room := range []*Room{session, owned} {
		room.mu.Lock()
		room.activity = time.Now().Add(-idleLimit - time.Second)
		room.mu.Unlock()
	}
	if session.step() || !owned.step() {
		t.Fatal("an idle session stayed open, or the owner's room closed")
	}
}
