package contracts

import (
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"
)

// A document checked against any contract, as Validate checks it: the same
// answer every time and for the document written out and read again, a
// failure said as "path · message", and a document it takes one that fills a
// value as JavaScript reads it.
func FuzzValidate(f *testing.F) {
	once.Do(load)
	if loadErr != nil {
		f.Fatal(loadErr)
	}
	names := slices.Sorted(maps.Keys(compiled))
	invite := strings.Repeat("a", 32)
	for _, seed := range []struct{ name, document string }{{"client-message", `{"type":"resync"}`},
		{"client-message", `{"type":"action","sequence":2.0,"action":[{"x":null}]}`},
		{"reserve", `{"invite":"` + invite + `","name":" \u00a0Ana ","role":"player"}`}, {"lobby-join", `{"code":"ab-2c","name":"Bo"}`},
		{"import-git", `{"url":"https://example.org/x.git","ref":"main"}`}, {"server-message", `{"type":"snapshot","tick":1,"ack":0,"seats":[],"state":{"a":[1]}}`},
		{"asset-upload", `{"name":"Dot","author":"Me","source":" https://exa\tmple.com/a.png ","license":"CC0-1.0","credit":"","media":"image/png","data":"","baseRevision":"r1"}`},
		{"scene", `{"id":"main","background":"#000000","objects":[]}`}, {"grant", `{}`}} {
		f.Add(seed.name, []byte(seed.document))
	}
	f.Fuzz(func(t *testing.T, name string, data []byte) {
		if compiled[name] == nil {
			name = names[len(name)%len(names)]
		}
		value, err := Decode(data)
		if err != nil {
			return
		}
		first, again := Validate(name, value), Validate(name, value)
		written, _ := json.Marshal(value)
		read, _ := Decode(written)
		if rewritten := Validate(name, read); !sameError(first, again) || !sameError(first, rewritten) {
			t.Fatalf("%s: %s, %v, then %v", name, data, first, rewritten)
		}
		if failed := (*failure)(nil); errors.As(first, &failed) {
			if failed.message == "" || (len(failed.path) > 0 && first.Error() != strings.Join(failed.path, ".")+" · "+failed.message) {
				t.Fatalf("%s: %s failed as %q", name, data, first.Error())
			}
			return
		}
		var out any
		if err := Unmarshal(value, &out); finite(value) && (first != nil || err != nil) {
			t.Fatalf("%s: %s: %v, %v", name, data, first, err)
		}
	})
}

func sameError(a, b error) bool {
	return (a == nil) == (b == nil) && (a == nil || a.Error() == b.Error())
}
