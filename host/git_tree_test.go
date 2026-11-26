package main

import (
	"encoding/base64"
	"encoding/json"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"zirbel/contracts"
)

// A tree a game can't be is read as what it is, its problems said as the Node
// host says them (test/git-store.test.ts holds Node to the same cases).

func entry(path, mode string) treeEntry {
	kind := "blob"
	if mode == "160000" {
		kind = "commit"
	}
	return treeEntry{mode: mode, kind: kind, oid: (path + strings.Repeat("0", 40))[:40], size: 1, path: path}
}

func readEntries(t *testing.T, entries []treeEntry, files map[string]string) (Content, []string) {
	t.Helper()
	content, problems, err := readTree(entries, treeSource{
		bytes: func(oids []string) (map[string][]byte, error) {
			found := map[string][]byte{}
			for _, item := range entries {
				if text, ok := files[item.path]; ok {
					found[item.oid] = []byte(text)
				}
			}
			return found, nil
		},
		sha256: func(entries []treeEntry) (map[string]string, error) {
			hashes := map[string]string{}
			for _, item := range entries {
				hashes[item.oid] = strings.Repeat("a", 64)
			}
			return hashes, nil
		},
		assets: func([]foundAsset) ([]string, error) { return nil, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	return content, problems
}

func TestATreeIsReadUnderTheRulesEveryHostApplies(t *testing.T) {
	problem := func(entries []treeEntry, files map[string]string) string {
		_, problems := readEntries(t, entries, files)
		if len(problems) == 0 {
			return ""
		}
		return problems[0]
	}
	many := []treeEntry{}
	for i := 0; i <= treeEntries; i++ {
		many = append(many, entry("f"+strconv.Itoa(i)+".txt", "100644"))
	}
	for want, got := range map[string]string{
		"It holds links or submodules, which a game can’t: link.js.": problem([]treeEntry{entry("index.html", "100644"), entry("link.js", "120000")}, nil),
		"It holds links or submodules, which a game can’t: lib.":     problem([]treeEntry{entry("index.html", "100644"), entry("lib", "160000")}, nil),
		"It holds more than 4000 files, more than a game can.":       problem(many, nil),
		"index.html must be UTF-8 text.":                             problem([]treeEntry{entry("index.html", "100644")}, map[string]string{"index.html": "\xff\xfe"}),
		"index.html must hold the game’s page, at most 400,000 characters.": problem([]treeEntry{entry("index.html", "100644")},
			map[string]string{"index.html": "  "}),
		".zirbel/game.json gives more than 4 players to a game without net.": problem([]treeEntry{entry("index.html", "100644"),
			entry(gameJSON, "100644")}, map[string]string{"index.html": "<p>", gameJSON: `{"maxPlayers":8}`}),
		".zirbel/game.json is not one Zirbel reads.": problem([]treeEntry{entry("index.html", "100644"), entry(gameJSON, "100644")},
			map[string]string{"index.html": "<p>", gameJSON: `{"maxPlayers":2,"other":1}`}),
		".zirbel/scene.json is not a scene Zirbel reads.": problem([]treeEntry{entry(sceneJSON, "100644")}, map[string]string{sceneJSON: "{}"}),
		"The bytes of these assets are missing: A.": problem([]treeEntry{entry(assetsJSON, "100644")}, map[string]string{assetsJSON: `[{"id":"a",` +
			`"name":"A","author":"A","source":"https://example.org/a","license":"CC0-1.0","credit":"","hash":"` + strings.Repeat("b", 64) +
			`","media":"image/png"}]`}),
	} {
		if got != want {
			t.Errorf("said %q, want %q", got, want)
		}
	}
	// What isn't the game's stays out of it; the game is index.html and its files, its page read as TextDecoder does.
	content, problems := readEntries(t, []treeEntry{entry("index.html", "100644"), entry("README.md", "100644"),
		entry(".github/ci.yml", "100644"), entry("src/main.js", "100755")}, map[string]string{"index.html": "\uFEFF <p>x</p> "})
	if len(problems) > 0 || content.Game == nil || content.Game.HTML != "<p>x</p>" || content.Game.MaxPlayers != 1 ||
		len(content.Game.Files) != 1 || content.Game.Files["src/main.js"] != strings.Repeat("a", 64) || content.Scene != nil {
		t.Errorf("the game: %+v %v", content.Game, problems)
	}
	// Players: zirbel.json describes a net game, and .zirbel/game.json the rest.
	manifest := `{"players":{"max":20},"multiplayer":{"adapter":"net/a.mjs"}}`
	content, _ = readEntries(t, []treeEntry{entry("index.html", "100644"), entry("zirbel.json", "100644"), entry("net/a.mjs", "100644"),
		entry(gameJSON, "100644")}, map[string]string{"index.html": "<p>", "zirbel.json": manifest, gameJSON: `{"maxPlayers":3,"registerObjects":true}`})
	if game := content.Game; game == nil || game.MaxPlayers != 16 || !game.Net || game.Adapter != "net/a.mjs" || game.RegisterObjects == nil || !*game.RegisterObjects {
		t.Errorf("a net game: %+v", game)
	}
}

func TestContentIsWrittenOverABaseTreeTouchingOnlyWhatTheHostManages(t *testing.T) {
	store, err := NewProjects(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	script, err := store.storeAsset([]byte("x"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := store.storeAsset([]byte(`{"players":{"max":4}}`))
	if err != nil {
		t.Fatal(err)
	}
	base := []treeEntry{entry("index.html", "100644"), entry("README.md", "100644"), entry("old.js", "100644"),
		entry(gameJSON, "100644"), entry(assetDirectory+strings.Repeat("c", 64)+".png", "100644")}
	stream := newFastImport()
	next := Content{Game: &Game{HTML: "<p>", MaxPlayers: 4, Net: true, Files: map[string]string{"a.js": script, "zirbel.json": manifest}},
		Assets: []Asset{}}
	changes, hashes, err := treeChanges(base, noHash, next, store.readAsset, stream)
	if err != nil {
		t.Fatal(err)
	}
	done := map[string]string{}
	for _, change := range changes {
		done[change.path] = change.op
	}
	want := map[string]string{"index.html": "M", "old.js": "D", "a.js": "M", "zirbel.json": "M", gameJSON: "D",
		assetDirectory + strings.Repeat("c", 64) + ".png": "D"}
	if len(done) != len(want) || len(hashes) != 2 {
		t.Fatalf("changes %v, hashes %v", done, hashes)
	}
	for path, op := range want {
		if done[path] != op {
			t.Errorf("%s: %q, want %q", path, done[path], op)
		}
	}
	// A game for three that shares state keeps that in .zirbel/game.json; one zirbel.json describes doesn't.
	if own := ownGameFields(&Game{HTML: "x", MaxPlayers: 3}, nil, false); own == nil || own.MaxPlayers != 3 || own.Net {
		t.Errorf("a game for three: %+v", own)
	}
	described, _ := base64.StdEncoding.DecodeString(base64.StdEncoding.EncodeToString([]byte(`{"players":{"max":4}}`)))
	if own := ownGameFields(&Game{HTML: "x", MaxPlayers: 4, Net: true, Files: map[string]string{"zirbel.json": manifest}}, described, true); own != nil {
		t.Errorf("a described game: %+v", own)
	}
}

func TestACommitReadsAsARevision(t *testing.T) {
	parent := strings.Repeat("1", 40)
	meta := revisionMeta(commitInfo{id: strings.Repeat("2", 40), parents: []string{parent}, author: " <Ada> ", time: 1_800_000_000,
		message: "  " + strings.Repeat("é", 130) + "\n\nZirbel-Restored-From: " + parent + "\r\n"})
	if meta.Label != strings.Repeat("é", 120) || meta.Author != "Ada" || meta.RestoredFrom != parent || *meta.Parent != parent ||
		meta.Date != "2027-01-15T08:00:00.000Z" {
		t.Errorf("revision: %+v", meta)
	}
	if empty := revisionMeta(commitInfo{id: parent, message: "\n"}); empty.Label != "Untitled revision" || empty.Parent != nil || empty.Author != "Unknown" {
		t.Errorf("an empty commit: %+v", empty)
	}
}

// A game file's path, from a push, a folder import or an MCP write, as
// isGameFilePath reads it: the Node host's gameFilePath (the game document
// contract's file names) to the letter, and a path it takes stays inside the
// game's folder, at most eight deep, hidden nowhere, with a type it serves.
func FuzzGameFilePath(f *testing.F) {
	for _, file := range []string{"index.html", "assets/sprite.png", "a/b/c/d/e/f/g/h.js", "a/b/c/d/e/f/g/h/i.js", ".git/config.json", "a/.hidden.js",
		"../x.js", "a//b.js", "/abs.js", "a\\b.js", "x.exe", "x.JS", "_x.mjs", strings.Repeat("a", 237) + ".js", "a/./b.css"} {
		f.Add(file)
	}
	f.Fuzz(func(t *testing.T, file string) {
		taken := isGameFilePath(file)
		if utf8.ValidString(file) {
			document, _ := json.Marshal(map[string]any{"html": "<p>", "files": map[string]string{file: strings.Repeat("0", 64)}})
			value, err := contracts.Decode(document)
			if err != nil {
				t.Fatal(err)
			}
			if node := contracts.Validate("game-document", value) == nil; node != taken {
				t.Fatalf("%q: taken %v, by Node's contract %v", file, taken, node)
			}
		}
		if isGamePath(file) != (taken || file == "index.html") {
			t.Fatalf("%q: a game's path %v", file, isGamePath(file))
		}
		if !taken {
			return
		}
		segments := strings.Split(file, "/")
		extension := file[strings.LastIndexByte(file, '.')+1:]
		if len(file) > 240 || len(segments) > 8 || !filepath.IsLocal(file) || path.Clean(file) != file ||
			gameFileTypes[extension] == "" || gameFileType(file) != gameFileTypes[extension] {
			t.Fatalf("%q was taken", file)
		}
		for _, segment := range segments {
			if segment == "" || segment[0] == '.' || strings.Trim(segment, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-") != "" {
				t.Fatalf("%q was taken, with the part %q", file, segment)
			}
		}
	})
}
