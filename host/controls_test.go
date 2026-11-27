package main

import (
	"encoding/base64"
	"encoding/json"
	"maps"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"

	"zirbel/contracts"
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

// A game's controls as checkedControls in packages/sdk/controls.ts reads
// zirbel.json's: known inputs with key codes, 1 to 8 players whose keys, name
// (1 to 24 UTF-16 code units) and colour are right where given, each part kept
// only where all of it is right; what is kept reads again as it is.
func FuzzDescribedControls(f *testing.F) {
	for _, controls := range []string{`{"keys":{"a":"Space","start":"Enter"}}`, `{"keys":{"a":"Space","jump":"KeyW"}}`, `{"keys":{}}`,
		`{"keys":{"a":"Space","a":"Space bar"}}`, `{"keys":{"__proto__":"Space"}}`, `{"keys":{"a":null}}`, `{"players":[{}]}`,
		`{"players":[{"name":"Red car","color":"#d03030","keys":{"up":"KeyW"},"wheels":4},{"name":"` + strings.Repeat("\U0001F697", 12) + `"}]}`,
		`{"players":[{"name":"\ud800"}]}`, `{"players":[{"name":null}]}`, `{"players":[{"keys":null}]}`, `{"players":[{},{},{},{},{},{},{},{},{}]}`,
		`{"keys":{"a":"KeyJ"},"players":[{"color":"#12345"}]}`, `{"keys":{"a":"KeyJ"},"players":[]}`, `[]`, `null`} {
		f.Add([]byte(`{"controls":`+controls+`}`), true)
	}
	f.Add([]byte(`{"controls":{"keys":{"a":"Space"}}}`), false)
	f.Add([]byte(`{"controls":{"players":[{"name":"`+strings.Repeat("\xe2\x82", 13)+`"}]}}`), true)
	f.Add([]byte("\xef\xbb\xbf{\"controls\":{\"keys\":{\"a\":\"Space\"}}}"), true)
	inputs := slices.Collect(maps.Keys(controlInputs))
	f.Fuzz(func(t *testing.T, manifest []byte, present bool) {
		encoded := base64.StdEncoding.EncodeToString(manifest)
		got := describedControls(encoded, present)
		if again := describedControls(encoded, present); !reflect.DeepEqual(again, got) {
			t.Fatal("read twice, it reads otherwise")
		}
		if got == nil {
			if want := nodeControls(manifest); present && len(encoded) <= manifestBase64 && utf8.Valid(manifest) && want != nil {
				t.Fatalf("%s: no controls; Node reads %+v", manifest, *want)
			}
			return
		}
		if !present || len(encoded) > manifestBase64 || got.Keys == nil && got.Players == nil {
			t.Fatalf("%s: controls %+v", manifest, *got)
		}
		keys := func(keys map[string]string) bool {
			for input, key := range keys {
				if !slices.Contains(inputs, input) || !nodeKeyCode.MatchString(key) {
					return false
				}
			}
			return keys == nil || len(keys) > 0
		}
		right := keys(got.Keys) && (got.Players == nil || len(got.Players) >= 1 && len(got.Players) <= maxPlaces)
		for _, player := range got.Players {
			length := len(utf16.Encode([]rune(player.Name)))
			right = right && keys(player.Keys) && length <= placeName && (player.Color == "" || nodePlaceColor.MatchString(player.Color))
		}
		if !right {
			t.Fatalf("%s: controls past their limits: %+v", manifest, *got)
		}
		// What is kept reads again as it is.
		data, err := json.Marshal(map[string]any{"controls": got})
		if err != nil {
			t.Fatal(err)
		}
		if again := describedControls(base64.StdEncoding.EncodeToString(data), true); !reflect.DeepEqual(again, got) {
			t.Fatalf("%s reads again as %+v", data, again)
		}
		// Node reads zirbel.json's bytes as UTF-8 with U+FFFD for each maximal
		// bad sequence, and Go's JSON for each bad byte: a name's length then differs.
		if want := nodeControls(manifest); utf8.Valid(manifest) && (want == nil || !reflect.DeepEqual(*want, *got)) {
			t.Fatalf("%s: controls %+v; Node reads %+v", manifest, *got, want)
		}
	})
}

// nodeControls is checkedControls(JSON.parse(manifest).controls).
func nodeControls(manifest []byte) *Controls {
	value, err := contracts.Decode(manifest) // as JSON.parse reads it: the last of duplicate keys
	if err != nil {
		return nil
	}
	described, _ := value.(map[string]any)
	controls, isObject := described["controls"].(map[string]any)
	if !isObject {
		return nil
	}
	checkedKeys := func(value any) map[string]string {
		object, _ := value.(map[string]any)
		if len(object) == 0 {
			return nil
		}
		keys := map[string]string{}
		for input, code := range object {
			text, isText := code.(string)
			if !slices.Contains(nodeInputs, input) || !isText || !nodeKeyCode.MatchString(text) {
				return nil
			}
			keys[input] = text
		}
		return keys
	}
	checked := Controls{Keys: checkedKeys(controls["keys"])}
	if list, _ := controls["players"].([]any); len(list) >= 1 && len(list) <= 8 {
		checked.Players = []ControlPlayer{}
		for _, item := range list {
			object, isObject := item.(map[string]any)
			name, hasName := object["name"]
			color, hasColor := object["color"]
			keys, hasKeys := object["keys"]
			text, isText := name.(string)
			colour, isColour := color.(string)
			length := len(utf16.Encode([]rune(text)))
			if !isObject || hasName && (!isText || length < 1 || length > 24) || hasColor && (!isColour || !nodePlaceColor.MatchString(colour)) ||
				hasKeys && checkedKeys(keys) == nil {
				checked.Players = nil
				break
			}
			checked.Players = append(checked.Players, ControlPlayer{Keys: checkedKeys(keys), Name: text, Color: colour})
		}
	}
	if checked.Keys == nil && checked.Players == nil {
		return nil
	}
	return &checked
}

// CONTROL_INPUTS, KEY_CODE and PLACE_COLOR.
var (
	nodeInputs     = []string{"a", "b", "x", "y", "lb", "rb", "lt", "rt", "select", "start", "ls", "rs", "up", "down", "left", "right", "home"}
	nodeKeyCode    = regexp.MustCompile(`^[A-Za-z0-9]{1,24}$`)
	nodePlaceColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)
