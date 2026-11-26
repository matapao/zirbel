package main

import (
	"encoding/json"
	"strings"
	"testing"

	"zirbel/host/webfiles"
)

// As test/game-folder.test.ts checks it for the Node host: a net game's
// zirbel.json names its adapter, one of its .js or .mjs files; anything else
// leaves the game without one, and a game for one never has one.
func TestANetGameNamesItsAdapterInZirbelJSON(t *testing.T) {
	store, err := NewProjects(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	importWith := func(manifest string) *Project {
		t.Helper()
		files := map[string]string{"index.html": encoded("<!doctype html><canvas></canvas>"), "net/adapter.js": encoded("export {}"),
			"net/adapter.mjs": encoded("export {}"), "models/hero.glb": encoded("glTF"), "zirbel.json": encoded(manifest)}
		data, _ := json.Marshal(map[string]any{"files": files})
		project, err := store.ImportGameFolder(data)
		if err != nil {
			t.Fatal(err)
		}
		return project
	}
	game := func(manifest string) *Game {
		t.Helper()
		revision, err := head(importWith(manifest), "main")
		if err != nil || revision.Game == nil {
			t.Fatal("no game", err)
		}
		return revision.Game
	}
	for _, adapter := range []string{"net/adapter.js", "net/adapter.mjs"} {
		if got := game(`{"players":{"max":4},"multiplayer":{"adapter":"` + adapter + `"}}`); got.Adapter != adapter || !got.Net {
			t.Errorf("%s: %+v", adapter, got)
		}
	}
	for _, multiplayer := range []string{
		`{"adapter":"net/missing.js"}`, `{"adapter":"models/hero.glb"}`, `{"adapter":"./net/adapter.js"}`, `{"adapter":"index.html"}`,
		`{"adapter":"net/adapter.js/"}`, `{"adapter":7}`, `{"adapter":["net/adapter.js"]}`, `"net/adapter.js"`, `null`,
		// JSON.parse keeps the last of duplicate keys.
		`{"adapter":"net/adapter.js","adapter":"net/missing.js"}`,
	} {
		if got := game(`{"players":{"max":4},"multiplayer":` + multiplayer + `}`); got.Adapter != "" || !got.Net {
			t.Errorf("%s: %+v", multiplayer, got)
		}
	}
	if got := game(`{"players":{"max":1},"multiplayer":{"adapter":"net/adapter.js"}}`); got.Adapter != "" || got.Net {
		t.Errorf("a game for one: %+v", got)
	}

	// Its release writes it in gameDocument's order and verifies; its page loads it last, and is otherwise the page without it.
	runtime := map[string]*webfiles.File{"player.js": {Bytes: []byte("ok"), Hash: digest([]byte("ok"))}}
	editor := &Editor{projects: store, releases: &Releases{runtime: runtime}}
	project := importWith(`{"players":{"max":4},"multiplayer":{"adapter":"net/adapter.js"}}`)
	release, err := editor.Package(project.ID, "main", "", Permissions{true, true, true}, false, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(release.gameRaw), `"net":true,"adapter":"net/adapter.js","files"`) {
		t.Fatalf("the game is not written in gameDocument's order: %s", release.gameRaw)
	}
	if err := Verify(release, runtime); err != nil {
		t.Fatal(err)
	}
	base := "http://h:8/game/@r/key/"
	policy, page := gamePage(release, "http://h:8/runtime/r/", "'self'", base)
	release.Game.Adapter = ""
	plainPolicy, plain := gamePage(release, "http://h:8/runtime/r/", "'self'", base)
	if page != plain+`<script type="module" src="`+base+`net/adapter.js"></script>` || policy != plainPolicy {
		t.Errorf("the adapter's page:\n%s\nwithout it:\n%s", page, plain)
	}

	// A proposal can't name one, and a release or project bundle can name only one of its game's files.
	revision, err := head(project, "main")
	if err != nil || revision == nil {
		t.Fatal("no revision", err)
	}
	if _, err := store.Submit(project.ID, []byte(`{"baseRevision":"`+revision.ID+`","branch":"main","label":"Adapter",`+
		`"operations":[{"op":"writeGame","game":{"html":"x","maxPlayers":4,"net":true,"adapter":"net/adapter.js"}}]}`), nil); err == nil {
		t.Error("a proposal named an adapter")
	}
	var document map[string]any
	if err := json.Unmarshal(netRelease(t, 4).canonical, &document); err != nil {
		t.Fatal(err)
	}
	for _, game := range []string{
		`{"html":"x","maxPlayers":4,"net":true,"adapter":"a.js"}`,
		`{"html":"x","maxPlayers":4,"adapter":"a.js","files":{"a.js":"` + digest(nil) + `"}}`,
	} {
		document["game"] = json.RawMessage(game)
		data, _ := jsJSON(document)
		if _, err := ParseRelease(data); err == nil || !strings.Contains(err.Error(), "game.adapter") {
			t.Errorf("%s: %v", game, err)
		}
	}
	bundle, err := store.Export(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Import([]byte(strings.Replace(string(bundle), `"adapter":"net/adapter.js"`, `"adapter":"net/gone.js"`, 1))); err == nil ||
		!strings.Contains(err.Error(), "game.adapter") {
		t.Errorf("a bundle whose adapter is not among its files: %v", err)
	}
}
