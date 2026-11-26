package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// A built folder's zirbel.json, as describedGame reads it: a game for one, or
// with its own netcode for 2 to 16 players, its adapter one of the folder's
// .js or .mjs files, and players.max as JSON.parse reads it.
func FuzzDescribedGame(f *testing.F) {
	for _, manifest := range []string{`{"players":{"max":4},"multiplayer":{"adapter":"net/adapter.js"}}`, `{"players":{"max":3.0}}`,
		`{"players":{"max":1e400}}`, `{"players":{"max":99},"multiplayer":{"adapter":"style.css"}}`, `{"players":{"max":"4"}}`,
		`{"players":{"max":2},"players":{"max":1}}`, `{"PLAYERS":{"max":5}}`, `{"players":{"max":2.5}}`, `[]`, `{"players":{"max":-0}}`} {
		f.Add([]byte(manifest), true)
	}
	f.Add([]byte(`{"players":{"max":4}}`), false)
	files := map[string]string{"net/adapter.js": "a", "game.mjs": "b", "style.css": "c"}
	f.Fuzz(func(t *testing.T, manifest []byte, present bool) {
		encoded := base64.StdEncoding.EncodeToString(manifest)
		count, adapter := describedGame(encoded, present, files)
		if again, same := describedGame(encoded, present, files); again != count || same != adapter {
			t.Fatal("read twice, it reads otherwise")
		}
		_, listed := files[adapter]
		if count < 1 || count > netPlayersMax || (count == 1 && adapter != "") ||
			(adapter != "" && (!listed || !strings.HasSuffix(adapter, ".js") && !strings.HasSuffix(adapter, ".mjs"))) {
			t.Fatalf("%s: %d players, adapter %q", manifest, count, adapter)
		}
		if !present || len(encoded) > manifestBase64 {
			if count != 1 {
				t.Fatalf("%s, not there or too long, made a game for %d", manifest, count)
			}
			return
		}
		// players.max as JSON.parse reads it: keys as they are, the last of duplicate ones, a double, Infinity past one.
		decoder := json.NewDecoder(bytes.NewReader(manifest))
		decoder.UseNumber()
		var described map[string]any
		if decoder.Decode(&described) != nil || decoder.InputOffset() != int64(len(bytes.TrimRight(manifest, " \t\r\n"))) {
			return
		}
		want := 1
		players, _ := described["players"].(map[string]any)
		if number, ok := players["max"].(json.Number); ok {
			if limit, err := number.Float64(); err == nil && limit == math.Trunc(limit) && limit > 1 {
				want = int(math.Min(limit, netPlayersMax))
			}
		}
		if count != want {
			t.Fatalf("%s: %d players, JSON.parse reads %d", manifest, count, want)
		}
	})
}
