package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"zirbel/host/webfiles"
)

func encoded(text string) string { return base64.StdEncoding.EncodeToString([]byte(text)) }

// As test/game-folder.test.ts checks it for the Node host: a built folder whose
// zirbel.json is for several players imports as a net game for up to 16, and
// releases as net-v2; anything else leaves a game for one.
func TestABuiltFolderForSeveralPlayersImportsAsANetGame(t *testing.T) {
	store, err := NewProjects(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	importWith := func(manifest *string) *Project {
		t.Helper()
		files := map[string]string{"index.html": encoded("<!doctype html><canvas></canvas>")}
		if manifest != nil {
			files["zirbel.json"] = encoded(*manifest)
		}
		data, _ := json.Marshal(map[string]any{"title": "Derby", "files": files})
		project, err := store.ImportGameFolder(data, ownerIdent)
		if err != nil {
			t.Fatal(err)
		}
		return project
	}
	game := func(manifest *string) *Game {
		t.Helper()
		revision, err := head(importWith(manifest), "main")
		if err != nil || revision.Game == nil {
			t.Fatal("no game", err)
		}
		return revision.Game
	}
	text := func(value string) *string { return &value }
	for manifest, players := range map[string]int{
		`{"id":"derby","players":{"min":1,"max":24}}`: 16, `{"players":{"max":3.0}}`: 3, `{"players":{"max":1e1}}`: 10,
		`{"players":{"max":2}}`: 2,
	} {
		if got := game(text(manifest)); got.MaxPlayers != players || !got.Net || got.Files["zirbel.json"] == "" {
			t.Errorf("%s: %d players, net %v", manifest, got.MaxPlayers, got.Net)
		}
	}
	for _, manifest := range []string{
		`{"players":{"max":1}}`, `{"players":{"max":2.5}}`, `{"players":{"max":"8"}}`, `{"players":null}`, `7`, `null`,
		`{"players":`, `{"players":{"max":1e400}}`, `{"players":{"max":-3}}`, `[{"players":{"max":3}}]`,
		// JSON.parse keeps the last of duplicate keys.
		`{"players":{"max":3},"players":{"min":1}}`, `{"players":{"max":3,"max":1}}`,
		`{"players":{"max":3},"pad":"` + strings.Repeat("x", 70_000) + `"}`,
	} {
		if got := game(text(manifest)); got.MaxPlayers != 1 || got.Net {
			t.Errorf("%.60s: %d players, net %v", manifest, got.MaxPlayers, got.Net)
		}
	}
	if got := game(nil); got.MaxPlayers != 1 || got.Net {
		t.Errorf("without zirbel.json: %+v", got)
	}

	// Its release: net-v2, players up to maxPlayers, multiplayer; and it verifies.
	runtime := map[string]*webfiles.File{"player.js": {Bytes: []byte("ok"), Hash: digest([]byte("ok"))}}
	editor := &Editor{projects: store, releases: &Releases{runtime: runtime}}
	project := importWith(text(`{"players":{"max":8}}`))
	release, err := editor.Package(project.ID, "main", "", Permissions{true, true, true}, false, false, "")
	if err != nil {
		t.Fatal(err)
	}
	m := release.Manifest
	if !isNet(m.Simulation) || m.Players != (playerRange{1, 8}) || strings.Join(m.Capabilities, ",") != "multiplayer" {
		t.Fatalf("manifest %+v", m)
	}
	if err := Verify(release, runtime); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(release.gameRaw), `"maxPlayers":8,"net":true,"files"`) {
		t.Fatalf("the game is not written in gameDocument's order: %s", release.gameRaw)
	}

	// More than four players only with net: a proposal can't drop it and keep them.
	propose := func(project *Project, game string) error {
		revision, _ := head(project, "main")
		_, err := store.Submit(project.ID, []byte(`{"baseRevision":"`+revision.ID+`","branch":"main","label":"Edit",`+
			`"operations":[{"op":"writeGame","game":`+game+`}]}`), ownerIdent, nil)
		return err
	}
	if err := propose(project, `{"html":"<canvas></canvas>","maxPlayers":8}`); err == nil || !strings.Contains(err.Error(), "needs net") {
		t.Fatalf("eight players without net: %v", err)
	}
	document, err := store.CreateGame("Document", &Game{HTML: "<canvas></canvas>", MaxPlayers: 1}, ownerIdent)
	if err != nil {
		t.Fatal(err)
	}
	if err := propose(document, `{"html":"<canvas></canvas>","maxPlayers":8,"net":true}`); err != nil {
		t.Fatal(err)
	}
	for _, game := range []string{`{"html":"x","maxPlayers":17,"net":true}`, `{"html":"x","maxPlayers":2,"net":false}`, `{"html":"x","maxPlayers":5}`} {
		if err := propose(document, game); err == nil {
			t.Errorf("%s was accepted", game)
		}
	}
}

// A release for more than four players needs net, in its manifest and its game.
func TestAReleaseForMoreThanFourPlayersNeedsNet(t *testing.T) {
	release := netRelease(t, 8)
	if !release.Game.Net || release.Game.MaxPlayers != 8 {
		t.Fatalf("game %+v", release.Game)
	}
	var document map[string]any
	if err := json.Unmarshal(release.canonical, &document); err != nil {
		t.Fatal(err)
	}
	manifest, _ := document["manifest"].(map[string]any)
	manifest["simulation"] = "shared-state-v1"
	data, _ := jsJSON(document)
	if _, err := ParseRelease(data); err == nil || !strings.Contains(err.Error(), "manifest.players.max · A release for more than 4 players needs net.") {
		t.Fatalf("shared state for eight: %v", err)
	}
	manifest["simulation"] = "net-v2"
	document["game"] = map[string]any{"html": "<canvas></canvas>", "maxPlayers": 8}
	data, _ = jsJSON(document)
	if _, err := ParseRelease(data); err == nil || !strings.Contains(err.Error(), "game.maxPlayers · A game for more than 4 players needs net.") {
		t.Fatalf("a game for eight without net: %v", err)
	}
}

// netRelease is a net game's release for this many players.
func netRelease(t *testing.T, players int) *Release {
	t.Helper()
	game := `{"html":"<canvas></canvas>","maxPlayers":` + strconv.Itoa(players) + `,"net":true}`
	document := map[string]any{
		"manifest": map[string]any{
			"format": 1, "releaseId": "n1", "gameId": "g1", "sourceRevision": "s1", "title": "Net", "sdk": "1.0.0",
			"protocol": 1, "client": "player.html", "simulation": "net-v2", "players": map[string]int{"min": 1, "max": players},
			"capabilities": []string{"multiplayer"}, "permissions": map[string]bool{"play": true, "download": true, "remix": true},
			"assets": []any{}, "credits": []any{}, "files": map[string]string{"player.js": digest([]byte("ok"))},
		},
		"game": json.RawMessage(game), "sceneHash": digest([]byte(game)),
		"files": map[string]string{"player.js": base64.StdEncoding.EncodeToString([]byte("ok"))}, "assets": map[string]string{},
	}
	data, _ := jsJSON(document)
	release, err := ParseRelease(data)
	if err != nil {
		t.Fatal(err)
	}
	return release
}

// A net-v2 release's page may import the spaces kernel's modules and reach its
// socket on its own listener; every other page keeps its policy byte for byte.
func TestANetGameMayImportTheKernelsModulesAndReachItsSocket(t *testing.T) {
	plain, _ := gamePage(&Release{Game: &Game{HTML: "<canvas></canvas>", MaxPlayers: 2}}, "http://h:8/runtime/r/", "'self'", "http://h:8/game/r/key/")
	for base, want := range map[string][2]string{
		"http://h:8/game/r/key/":      {"http://h:8/.skalet/net.js http://h:8/.skalet/spaces.js", "ws://h:8/.skalet/spaces"},
		"https://box.local/game/r/k/": {"https://box.local/.skalet/net.js https://box.local/.skalet/spaces.js", "wss://box.local/.skalet/spaces"},
	} {
		release := netRelease(t, 3)
		policy, _ := gamePage(release, "http://h:8/runtime/r/", "'self'", base)
		directives := strings.Split(policy, "; ")
		if !strings.HasSuffix(directives[2], "three/addons/ "+want[0]) || !strings.HasSuffix(directives[7], "data: blob: "+want[1]) {
			t.Errorf("%s: %s", base, policy)
		}
		if base == "http://h:8/game/r/key/" {
			if stripped := strings.Replace(strings.Replace(policy, " "+want[0], "", 1), " "+want[1], "", 1); stripped != plain {
				t.Errorf("the net policy differs beyond its entries:\n%s\n%s", stripped, plain)
			}
		}
	}
}

// A net game's document is at /game/<room>/<key>/, as every other game's.
func TestANetGameIsWhereEveryGameIs(t *testing.T) {
	net := newRoom(netRelease(t, 3), false, "local", false)
	if got := gamePath(net); got != "/game/"+net.ID+"/"+net.DocumentKey+"/" {
		t.Errorf("net game: %s", got)
	}
}

// Without a spaces kernel, /.skalet/* answers that multiplayer isn't
// available, and nothing serves the relay or the earlier client any more.
func TestWithoutAKernelSpacesAreUnavailableAndTheRelayIsGone(t *testing.T) {
	listener := &Listener{rooms: NewRooms(), port: 80, config: listenerConfig{spaces: &Spaces{}}}
	t.Cleanup(listener.rooms.Dispose)
	for path, status := range map[string]int{"/.skalet/net.js": http.StatusServiceUnavailable, "/.skalet/spaces": http.StatusServiceUnavailable,
		"/zirbel-net.js": http.StatusNotFound, "/zirbel-net/SKILL.md": http.StatusNotFound, "/mp": http.StatusNotFound} {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil)
		request.Host, request.RemoteAddr = "localhost", "127.0.0.1:5000"
		response := httptest.NewRecorder()
		listener.ServeHTTP(response, request)
		if response.Code != status {
			t.Errorf("%s: %d %s", path, response.Code, response.Body.String())
		}
	}
}
