package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"zirbel/contracts"
	"zirbel/host/webfiles"
)

func TestBoundedJSONMatchesTheSDK(t *testing.T) {
	cases := map[string]bool{
		`{"x":1,"y":[1,2,3]}`:                    true,
		`"` + strings.Repeat("a", 2048) + `"`:    true,
		`"` + strings.Repeat("a", 2049) + `"`:    false,
		`"` + strings.Repeat("😀", 1024) + `"`:    true, // 2048 UTF-16 units
		`"` + strings.Repeat("😀", 1025) + `"`:    false,
		`{"` + strings.Repeat("k", 129) + `":1}`: false,
		`1e400`:                                  false,
		`[[[[[[[[[1]]]]]]]]]`:                    false, // depth 9
		`[[[[[[[[1]]]]]]]]`:                      true,
		`[` + strings.Repeat("0,", 255) + `0]`:   false, // 257 nodes
		`[` + strings.Repeat("0,", 254) + `0]`:   true,
	}
	for input, want := range cases {
		value, err := contracts.Decode([]byte(input))
		if err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		remaining := 256
		if got := boundedJSON(value, 0, &remaining); got != want {
			t.Errorf("boundedJSON(%.40s) = %v, want %v", input, got, want)
		}
	}
}

func TestSharedStateKeepsKeyOrderAndBounds(t *testing.T) {
	state := &sharedState{states: map[string]json.RawMessage{}}
	if rejection := state.apply("b", json.RawMessage(`{ "z": 1, "a": [1, 2] }`)); rejection != "" {
		t.Fatal(rejection)
	}
	state.apply("a", json.RawMessage(`true`))
	data, _ := json.Marshal(state.snapshot())
	if string(data) != `{"b":{"z":1,"a":[1,2]},"a":true}` {
		t.Fatalf("snapshot = %s", data)
	}
	if state.apply("a", json.RawMessage(`"`+strings.Repeat("x", 2048)+`","`)) == "" {
		t.Fatal("invalid JSON was accepted")
	}
	big := `{` + strings.Repeat(`"k":"`+strings.Repeat("x", 100)+`",`, 40) + `"e":1}`
	if state.apply("a", json.RawMessage(big)) == "" {
		t.Fatal("a state over 4096 characters was accepted")
	}
	state.remove("b")
	data, _ = json.Marshal(state.snapshot())
	if string(data) != `{"a":true}` {
		t.Fatalf("after remove = %s", data)
	}
}

func TestTessellateTurnsWinsAndBot(t *testing.T) {
	game := newTessellate(false)
	game.add("a")
	game.add("b")
	moves := []struct {
		seat string
		cell int
		want string
	}{{"b", 0, "Wait for your turn."}, {"a", 0, ""}, {"b", 0, "That tile is occupied."}, {"b", 3, ""}, {"a", 1, ""}, {"b", 4, ""}, {"a", 2, ""}}
	for _, move := range moves {
		action, _ := json.Marshal(map[string]any{"type": "place", "cell": move.cell})
		if got := game.apply(move.seat, action); got != move.want {
			t.Fatalf("%s at %d: %q, want %q", move.seat, move.cell, got, move.want)
		}
	}
	if game.winner == nil || *game.winner != "a" || game.turn != nil {
		t.Fatalf("winner %v turn %v", game.winner, game.turn)
	}
	if got := game.apply("a", json.RawMessage(`{"type":"reset"}`)); got != "" || game.winner != nil || *game.turn != "a" {
		t.Fatalf("reset: %q", got)
	}
	if got := game.apply("a", json.RawMessage(`{"type":"place","cell":9}`)); got != "Choose an open tile." {
		t.Fatalf("out of range: %q", got)
	}

	solo := newTessellate(true)
	solo.add("a")
	solo.apply("a", json.RawMessage(`{"type":"place","cell":0}`))
	if solo.board[4] == nil || *solo.board[4] != "bot" || *solo.turn != "a" {
		t.Fatal("the bot did not answer in the centre")
	}
}

func TestMosslightMovesAndCollects(t *testing.T) {
	game := newMosslight(&Scene{Objects: []SceneObject{
		{ID: "spawn", Kind: "spawn", X: 100, Y: 100},
		{ID: "gem", Kind: "crystal", X: 120, Y: 100},
	}})
	game.add("a")
	if got := game.apply("a", json.RawMessage(`{"type":"move","x":2,"y":0}`)); got == "" {
		t.Fatal("an out-of-range vector was accepted")
	}
	if got := game.apply("a", json.RawMessage(`{"type":"move","x":1,"y":0,"z":0}`)); got == "" {
		t.Fatal("an extra field was accepted")
	}
	if got := game.apply("a", json.RawMessage(`{"type":"move","x":1,"y":0}`)); got != "" {
		t.Fatal(got)
	}
	for i := 0; i < 5; i++ {
		game.tick(0.05)
	}
	if len(game.collected) != 1 || game.explorers[0].Score != 1 {
		t.Fatalf("collected %v", game.collected)
	}
	game.suspend("a")
	if game.tick(0.05) {
		t.Fatal("a suspended explorer kept moving")
	}
}

func fakeRelease(t *testing.T) (*Release, map[string]*webfiles.File) {
	t.Helper()
	runtime := map[string]*webfiles.File{"player.js": {Bytes: []byte("ok"), Hash: digest([]byte("ok"))}}
	game := `{"html":"<canvas></canvas>","maxPlayers":2}`
	document := map[string]any{
		"manifest": map[string]any{
			"format": 1, "releaseId": "r1", "gameId": "g1", "sourceRevision": "s1", "title": "Test", "sdk": "1.0.0",
			"protocol": 1, "client": "player.html", "simulation": "shared-state-v1", "players": map[string]int{"min": 1, "max": 2},
			"capabilities": []string{"multiplayer"}, "permissions": map[string]bool{"play": true, "download": true, "remix": true},
			"assets": []any{}, "credits": []any{}, "files": map[string]string{"player.js": digest([]byte("ok"))},
		},
		"game": json.RawMessage(game), "sceneHash": digest([]byte(game)),
		"files": map[string]string{"player.js": base64.StdEncoding.EncodeToString([]byte("ok"))}, "assets": map[string]string{},
	}
	// Encode like JSON.stringify: Go's default HTML escaping would change the hashed bytes.
	data, _ := jsJSON(document)
	release, err := ParseRelease(data)
	if err != nil {
		t.Fatal(err)
	}
	return release, runtime
}

func TestVerifyChecksContentRuntimeAndCapabilities(t *testing.T) {
	release, runtime := fakeRelease(t)
	if err := Verify(release, runtime); err != nil {
		t.Fatal(err)
	}
	tampered := *release
	tampered.gameRaw = json.RawMessage(`{"html":"<p>x</p>","maxPlayers":2}`)
	if err := Verify(&tampered, runtime); err == nil || !strings.Contains(err.Error(), "hash") {
		t.Fatalf("tampered content: %v", err)
	}
	other := map[string]*webfiles.File{"player.js": {Hash: digest([]byte("other"))}}
	if err := Verify(release, other); err == nil || !strings.Contains(err.Error(), "verified build") {
		t.Fatalf("other runtime: %v", err)
	}
	solo := *release
	solo.Game = &Game{HTML: "x", MaxPlayers: 1}
	if err := Verify(&solo, runtime); err == nil || !strings.Contains(err.Error(), "capabilities") {
		t.Fatalf("capabilities: %v", err)
	}
	if _, err := ParseRelease([]byte(`{"manifest":{}}`)); err == nil {
		t.Fatal("an invalid release parsed")
	}
}

type recorder struct {
	messages [][]byte
	closed   int
}

func (r *recorder) Send(message []byte) { r.messages = append(r.messages, message) }
func (r *recorder) Close(code int)      { r.closed = code }

func TestRoomSeatsTicketsAndResume(t *testing.T) {
	release, _ := fakeRelease(t)
	rooms := NewRooms()
	defer rooms.Dispose()
	room, err := rooms.Create(release, "local")
	if err != nil {
		t.Fatal(err)
	}
	first, err := room.Reserve(room.Invite, "Ada", "player")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := room.Reserve(room.Invite, "Bo", "player"); err != nil {
		t.Fatal(err)
	}
	if _, err := room.Reserve(room.Invite, "Cy", "player"); err == nil {
		t.Fatal("a third player seat was reserved")
	}
	if _, err := room.Reserve("wrong", "Cy", "spectator"); err == nil {
		t.Fatal("a wrong invite was accepted")
	}
	peer := &recorder{}
	seat := room.Connect(hello{Credential: first, ReleaseID: "r1"}, peer)
	if seat == "" || !strings.Contains(string(peer.messages[0]), `"type":"welcome"`) {
		t.Fatalf("connect: %s", peer.messages)
	}
	var welcome struct{ Resume string }
	_ = json.Unmarshal(peer.messages[0], &welcome)
	if room.Connect(hello{Credential: first, ReleaseID: "r1"}, &recorder{}) != "" {
		t.Fatal("a used ticket was accepted twice")
	}
	replacement := &recorder{}
	if room.Connect(hello{Credential: welcome.Resume, ReleaseID: "r1"}, replacement) != seat || peer.closed != 4001 {
		t.Fatal("resume did not replace the old connection")
	}
	room.Message(seat, peer, clientMessage{Type: "action", Sequence: 1, Action: json.RawMessage(`1`)})
	if strings.Contains(string(replacement.messages[len(replacement.messages)-1]), `"state":{"`) {
		t.Fatal("a replaced connection could still act")
	}
	room.Disconnected(seat, replacement)
	if !room.MayView(welcome.Resume) {
		t.Fatal("a disconnected seat lost its resume credential during the grace period")
	}
}

func TestOpeningAtTheRoomLimitReplacesOneIdlePlaytest(t *testing.T) {
	release, _ := fakeRelease(t)
	rooms := NewRooms()
	defer rooms.Dispose()
	for i := 0; i < maxRooms; i++ {
		if _, err := rooms.Open(release, true, "local", false); err != nil {
			t.Fatal(err)
		}
	}
	// Each concurrent open must evict one idle playtest and add one room.
	var opening sync.WaitGroup
	for i := 0; i < 16; i++ {
		opening.Go(func() { _, _ = rooms.Open(release, true, "local", false) })
	}
	opening.Wait()
	if open := len(rooms.list()); open != maxRooms {
		t.Fatalf("%d rooms are open at a limit of %d", open, maxRooms)
	}
}

func TestAnAssetIsWrittenOnlyUnderItsHash(t *testing.T) {
	root := t.TempDir()
	store, err := NewProjects(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../escape", "", strings.Repeat("A", 64), strings.Repeat("a", 63)} {
		if err := store.writeAsset(name, []byte("x")); err == nil {
			t.Fatalf("an asset named %q was written", name)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "escape")); !os.IsNotExist(err) {
		t.Fatalf("a file was written outside the assets: %v", err)
	}
	hash, err := store.storeAsset([]byte("asset"))
	if err != nil {
		t.Fatal(err)
	}
	if data, err := store.readAsset(hash); err != nil || string(data) != "asset" {
		t.Fatalf("the stored asset reads back as %q: %v", data, err)
	}
}

func TestClaimDirectoryIsExclusiveAndRecoversItsOwnStalePID(t *testing.T) {
	root := t.TempDir()
	parent := owner{PID: os.Getppid(), Boot: newID()}
	first, err := claimDirectory(root, parent)
	if err != nil || !first.owner {
		t.Fatalf("first claim: %v", err)
	}
	if second, err := claimDirectory(root, owner{PID: os.Getppid(), Boot: newID()}); err != nil || second.owner {
		t.Fatal("a live owner was displaced")
	}
	first.release()
	stale := owner{PID: os.Getpid(), Boot: newID()}
	data, _ := json.Marshal(stale)
	_ = os.WriteFile(filepath.Join(root, "service.json"), data, 0o600)
	restarted, err := claimDirectory(root, owner{PID: os.Getpid(), Boot: newID()})
	if err != nil || !restarted.owner {
		t.Fatalf("a claim with this PID was not treated as stale: %v", err)
	}
	restarted.release()
	if _, err := os.Stat(filepath.Join(root, "service.json")); !os.IsNotExist(err) {
		t.Fatal("release left the claim behind")
	}
}

func FuzzParseRelease(f *testing.F) {
	f.Add([]byte(`{"manifest":{},"sceneHash":"","files":{},"assets":{}}`))
	f.Add([]byte(`[]`))
	f.Fuzz(func(t *testing.T, data []byte) {
		release, err := ParseRelease(data)
		if err == nil && release == nil {
			t.Fatal("nil release without an error")
		}
	})
}

func FuzzClientMessage(f *testing.F) {
	f.Add([]byte(`{"type":"action","sequence":1,"action":{"x":1}}`))
	f.Add([]byte(`{"type":"hello","version":1,"credential":"aaaaaaaaaaaaaaaaaaaa","releaseId":"r1"}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		value, err := contracts.Decode(data)
		if err != nil {
			return
		}
		if contracts.Validate("client-message", value) != nil {
			return
		}
		var message clientMessage
		if err := json.Unmarshal(data, &message); err != nil {
			t.Fatalf("a valid message did not decode: %v", err)
		}
		if message.Type == "action" {
			compactState(message.Action)
		}
	})
}

func TestReviewRegressions(t *testing.T) {
	if got := scriptJSON(map[string]string{"a": "</script><script>alert(1)</script>"}); strings.Contains(got, "<") {
		t.Fatalf("scriptJSON left a raw <: %s", got)
	}

	game := newMosslight(&Scene{})
	game.add("a")
	if game.apply("a", json.RawMessage(`{"type":"move","x":null,"y":null}`)) == "" {
		t.Fatal("null movement was accepted")
	}
	tiles := newTessellate(false)
	tiles.add("a")
	tiles.add("b")
	if tiles.apply("a", json.RawMessage(`{"type":"place","cell":null}`)) == "" {
		t.Fatal("a null cell was accepted")
	}
	if got := tiles.apply("a", json.RawMessage(`{"type":"place","cell":4.0}`)); got != "" {
		t.Fatalf("an integral float cell was refused: %q", got)
	}

	release, _ := fakeRelease(t)
	rooms := NewRooms()
	defer rooms.Dispose()
	room, err := rooms.Create(release, "local")
	if err != nil {
		t.Fatal(err)
	}
	ticket, _ := room.Reserve(room.Invite, "Ada", "player")
	peer := &recorder{}
	seat := room.Connect(hello{Credential: ticket, ReleaseID: "r1"}, peer)
	var message clientMessage
	if err := json.Unmarshal([]byte(`{"type":"action","sequence":2.0,"action":{"x":1}}`), &message); err != nil {
		t.Fatal(err)
	}
	room.Message(seat, peer, message)
	if last := string(peer.messages[len(peer.messages)-1]); strings.Contains(last, "stale-action") {
		t.Fatalf("sequence 2.0 was treated as stale: %s", last)
	}

	queued := &socketPeer{out: make(chan outgoing, 1024), drop: func() {}}
	for i := 0; i < 6; i++ {
		queued.Send(make([]byte, 50_000))
	}
	if !queued.closed.Load() {
		t.Fatal("a client holding over 256 KB was kept")
	}
}

func TestImportNeverOverwritesAnUnreadableRelease(t *testing.T) {
	root := t.TempDir()
	releases, err := NewReleases(root, map[string]*webfiles.File{})
	if err != nil {
		t.Fatal(err)
	}
	release, runtime := fakeRelease(t)
	releases.runtime = runtime
	source := filepath.Join(root, "in.json")
	_ = os.WriteFile(source, release.canonical, 0o600)
	stored := filepath.Join(root, "releases", "r1.json")
	_ = os.WriteFile(stored, []byte(`{"broken":true}`), 0o600)
	if err := releases.Import(source); err == nil {
		t.Fatal("import replaced a stored release it could not read")
	}
	if data, _ := os.ReadFile(stored); string(data) != `{"broken":true}` { //nolint:gosec // a test file in t.TempDir()
		t.Fatal("the stored release was overwritten")
	}
}

func TestListenersAreIPv4Only(t *testing.T) {
	runtime := map[string]*webfiles.File{"player.html": {Bytes: []byte("<head></head>")}}
	rooms := NewRooms()
	defer rooms.Dispose()
	listener, err := Listen(t.Context(), rooms, runtime, "0.0.0.0", 0, listenerConfig{lan: true})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if conn, err := (&net.Dialer{}).DialContext(context.Background(), "tcp6", net.JoinHostPort("::1", strconv.Itoa(listener.port))); err == nil {
		_ = conn.Close()
		t.Fatal("the LAN listener accepted IPv6")
	}
}

func TestConcurrentSharingStartsOneLANListener(t *testing.T) {
	runtime := map[string]*webfiles.File{"player.html": {Bytes: []byte("<head></head>")}}
	rooms := NewRooms()
	defer rooms.Dispose()
	local, err := Listen(t.Context(), rooms, runtime, "127.0.0.1", 0, listenerConfig{})
	if err != nil {
		t.Fatal(err)
	}
	players := &Players{rooms: rooms, runtime: runtime, local: local}
	defer players.Close()
	started := make([]*Listener, 8)
	var starting sync.WaitGroup
	for i := range started {
		starting.Go(func() { started[i], _ = players.StartLAN(t.Context()) })
	}
	starting.Wait()
	for _, listener := range started {
		if listener == nil || listener != started[0] {
			t.Fatal("concurrent requests did not share one LAN listener")
		}
	}
}

func TestClaimRecoversFromACrashedClaimAndAStaleRecovery(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "service.json")
	_ = os.WriteFile(file, nil, 0o600)
	first, err := claimDirectory(root, owner{PID: os.Getppid(), Boot: newID()})
	if err != nil || !first.owner {
		t.Fatalf("an empty claim was not treated as stale: %v", err)
	}
	first.release()
	dead := owner{PID: 1 << 22, Boot: newID()}
	data, _ := json.Marshal(dead)
	_ = os.WriteFile(file, data, 0o600)
	recovery := filepath.Join(root, "recover-"+dead.Boot+".json")
	_ = os.WriteFile(recovery, nil, 0o600)
	old := time.Now().Add(-time.Minute)
	_ = os.Chtimes(recovery, old, old)
	second, err := claimDirectory(root, owner{PID: os.Getppid(), Boot: newID()})
	if err != nil || !second.owner {
		t.Fatalf("a stale recovery file blocked the claim: %v", err)
	}
	second.release()
}

func TestBroadcastEncodesOneValidSnapshotPerSeat(t *testing.T) {
	release, _ := fakeRelease(t)
	rooms := NewRooms()
	defer rooms.Dispose()
	room, err := rooms.Create(release, "local")
	if err != nil {
		t.Fatal(err)
	}
	peers := []*recorder{{}, {}}
	for i, peer := range peers {
		ticket, _ := room.Reserve(room.Invite, "P"+strconv.Itoa(i), "player")
		room.Connect(hello{Credential: ticket, ReleaseID: "r1"}, peer)
	}
	last := peers[0].messages[len(peers[0].messages)-1]
	var snapshot struct {
		Type  string
		Tick  int64
		Ack   int64
		Seats []SeatInfo
		State map[string]any
	}
	if err := json.Unmarshal(last, &snapshot); err != nil || snapshot.Type != "snapshot" || len(snapshot.Seats) != 2 || snapshot.State == nil {
		t.Fatalf("snapshot %s: %v", last, err)
	}
	value, err := contracts.Decode(last)
	if err != nil || contracts.Validate("server-message", value) != nil {
		t.Fatalf("the snapshot breaks the server-message contract: %s", last)
	}
}
