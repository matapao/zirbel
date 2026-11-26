package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// As test/game-folder.test.ts checks it for the Node host: any game's
// zirbel.json may give the inputs of the standard gamepad layout keyboard
// codes (controls.keys); anything but an object of known inputs and codes, at
// least one, leaves the game without keys; its controls.players give each place
// its own keys, name and colour. Its page carries them, sorted,
// ahead of game-sdk.
func TestAGameNamesItsKeysInZirbelJSON(t *testing.T) {
	store, err := NewProjects(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	game := func(manifest string) *Game {
		t.Helper()
		files := map[string]string{"index.html": encoded("<canvas></canvas>"), "zirbel.json": encoded(manifest)}
		data, _ := json.Marshal(map[string]any{"files": files})
		project, err := store.ImportGameFolder(data, ownerIdent)
		if err != nil {
			t.Fatal(err)
		}
		revision, err := head(project, "main")
		if err != nil || revision.Game == nil {
			t.Fatal("no game", err)
		}
		return revision.Game
	}
	keys := func(game *Game) string {
		if game.Controls == nil {
			return ""
		}
		data, _ := json.Marshal(game.Controls)
		return string(data)
	}
	if got := game(`{"controls":{"keys":{"start":"Enter","a":"Space","up":"ArrowUp","b":"ShiftLeft","home":"Escape"}}}`); keys(got) !=
		`{"keys":{"a":"Space","b":"ShiftLeft","home":"Escape","start":"Enter","up":"ArrowUp"}}` || got.Net || got.MaxPlayers != 1 {
		t.Errorf("a game for one: %+v %s", got, keys(got))
	}
	if got := game(`{"players":{"max":3},"controls":{"keys":{"a":"KeyJ"}}}`); keys(got) != `{"keys":{"a":"KeyJ"}}` || !got.Net {
		t.Errorf("a net game: %+v %s", got, keys(got))
	}
	// JSON.parse keeps the last of duplicate keys.
	if got := game(`{"controls":{"keys":{"a":"Space","a":"Digit1"}}}`); keys(got) != `{"keys":{"a":"Digit1"}}` {
		t.Errorf("duplicate inputs: %s", keys(got))
	}
	for _, controls := range []string{
		`{"keys":{"a":"Space","jump":"KeyW"}}`, `{"keys":{"a":"Space bar"}}`, `{"keys":{"a":32}}`, `{"keys":{}}`, `{"keys":["Space"]}`,
		`{"keys":"Space"}`, `"keys"`, `null`, `{"keys":{"a":"` + strings.Repeat("A", 25) + `"}}`, `{"keys":{"a":""}}`,
		`{"keys":{"__proto__":"Space"}}`, `{"keys":{"A":"Space"}}`,
	} {
		if got := game(`{"controls":` + controls + `}`); got.Controls != nil {
			t.Errorf("%s: %s", controls, keys(got))
		}
	}
	if got := game(`not json`); got.Controls != nil {
		t.Errorf("not JSON: %s", keys(got))
	}

	// Each place's own keys, name and colour, in that order, other fields aside; the list only where all of it is right.
	players := `[{"color":"#d03030","keys":{"up":"KeyW","a":"Space"},"name":"Red car","wheels":4},{},{"name":"Blue car"}]`
	if got := game(`{"controls":{"keys":{"a":"KeyJ"},"players":` + players + `}}`); keys(got) != `{"keys":{"a":"KeyJ"},"players":`+
		`[{"keys":{"a":"Space","up":"KeyW"},"name":"Red car","color":"#d03030"},{},{"name":"Blue car"}]}` {
		t.Errorf("players: %s", keys(got))
	}
	for _, wrong := range []string{`[]`, `[{},{},{},{},{},{},{},{},{}]`, `[{"name":""}]`, `[{"name":"` + strings.Repeat("n", 25) + `"}]`,
		`[{"color":"red"}]`, `[{"color":"#12345"}]`, `[{"keys":{}}]`, `[{"keys":{"a":"Space bar"}}]`, `[null]`, `["Red car"]`,
		`{"name":"Red car"}`} {
		if got := game(`{"controls":{"keys":{"a":"KeyJ"},"players":` + wrong + `}}`); keys(got) != `{"keys":{"a":"KeyJ"}}` {
			t.Errorf("%s: %s", wrong, keys(got))
		}
	}
	// A name's length as JavaScript counts it, in UTF-16 code units.
	if got := game(`{"controls":{"players":[{"name":"` + strings.Repeat("🚗", 12) + `"}]}}`); got.Controls == nil {
		t.Error("twelve cars are 24 code units")
	}
	if got := game(`{"controls":{"players":[{"name":"` + strings.Repeat("🚗", 13) + `"}]}}`); got.Controls != nil {
		t.Errorf("thirteen cars: %s", keys(got))
	}

	release := &Release{Game: game(`{"controls":{"keys":{"start":"Enter","left":"ArrowLeft"},"players":[{"name":"Ada"}]}}`)}
	_, page := gamePage(release, "http://h:8/runtime/r/", "'self'", "http://h:8/game/r/key/")
	if want := `<script type="application/json" id="zirbel-controls">{"keys":{"left":"ArrowLeft","start":"Enter"},"players":[{"name":"Ada"}]}` +
		`</script><script crossorigin="anonymous" src="http://h:8/runtime/r/game-sdk.js"></script>`; !strings.Contains(page, want) {
		t.Errorf("the page has no controls ahead of game-sdk:\n%s", page)
	}
	release.Game.Controls = nil
	if _, page := gamePage(release, "http://h:8/runtime/r/", "'self'", "http://h:8/game/r/key/"); strings.Contains(page, "zirbel-controls") {
		t.Errorf("a game without controls has them:\n%s", page)
	}
}
