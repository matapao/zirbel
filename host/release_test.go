package main

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"path/filepath"
	"regexp"
	"testing"

	"zirbel/contracts"
)

var hexHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

// A release file from outside (zirbel-host --import, the editor's import), as
// ParseRelease and Verify check it: what they refuse is the client's mistake,
// and what they take keeps every limit, names a file in the releases folder,
// reads back the same from the bytes the host stores, and matches its hashes.
func FuzzReleaseImport(f *testing.F) {
	release, runtime := fakeReleaseJSON()
	f.Add(release)
	scene := `{"id":"main","background":"#000000","objects":[{"id":"a","kind":"rock","name":"A","x":1,"y":1,"size":10,"color":"#000000"}]}`
	f.Add(bytes.Replace(bytes.Replace(release, []byte(`"game":{"html":"<canvas></canvas>","maxPlayers":2}`), []byte(`"scene":`+scene), 1),
		[]byte(digest([]byte(`{"html":"<canvas></canvas>","maxPlayers":2}`))), []byte(digest([]byte(scene))), 1))
	f.Add(bytes.Replace(release, []byte(`"releaseId":"r1"`), []byte(`"releaseId":"r1","RELEASEID":"../r2"`), 1))
	f.Add(bytes.Replace(release, []byte(`"maxPlayers":2}`), []byte(`"maxPlayers":8,"net":true,"adapter":"net.js","files":{"net.js":"`+digest(nil)+`"}}`), 1))
	f.Add([]byte(`{"manifest":{},"sceneHash":"","files":{},"assets":{}}`))
	f.Add([]byte(`[]`))
	dir := f.TempDir()
	f.Fuzz(func(t *testing.T, data []byte) {
		release, err := ParseRelease(data)
		if err != nil {
			if status(err) != http.StatusBadRequest {
				t.Fatalf("refused with %v, not a 400", err)
			}
			return
		}
		m := release.Manifest
		if !idPattern.MatchString(m.ReleaseID) || m.Players.Min < 1 || m.Players.Min > m.Players.Max || m.Players.Max > netPlayersMax ||
			(m.Players.Max > sharedPlayers && !isNet(m.Simulation)) {
			t.Fatalf("a manifest past the limits: %+v", m)
		}
		if game := release.Game; game != nil {
			_, page := game.Files["index.html"]
			_, adapter := game.Files[game.Adapter]
			if page || len(game.Files) > maxGameFiles || game.MaxPlayers < 1 || (game.MaxPlayers > sharedPlayers && !game.Net) ||
				(game.Adapter != "" && (!game.Net || !adapter)) || contracts.Trim(game.HTML) == "" {
				t.Fatalf("a game past the limits: %+v", game)
			}
			for path, hash := range game.Files {
				if !isGameFilePath(path) || !hexHash.MatchString(hash) {
					t.Fatalf("the game file %q (%q)", path, hash)
				}
			}
		}
		if release.Scene != nil {
			seen := map[string]bool{}
			for _, object := range release.Scene.Objects {
				if seen[object.ID] {
					t.Fatalf("the scene has object %q twice", object.ID)
				}
				seen[object.ID] = true
			}
		}
		if path, err := (&Releases{dir: dir}).path(m.ReleaseID); err != nil || filepath.Dir(path) != dir {
			t.Fatalf("release %q is stored at %q (%v)", m.ReleaseID, path, err)
		}
		again, err := ParseRelease(release.canonical)
		if err != nil || !bytes.Equal(again.canonical, release.canonical) || !sameRelease(again, release) {
			t.Fatalf("the stored bytes read back differently: %v", err)
		}
		if err := Verify(release, runtime); err != nil {
			if code := status(err); code != http.StatusBadRequest && code != http.StatusUnprocessableEntity {
				t.Fatalf("refused with %v, not a 400 or 422", err)
			}
			return
		}
		content := release.gameRaw
		if len(content) == 0 {
			content = release.SceneRaw
		}
		if digest(content) != release.sceneHash {
			t.Fatal("verified with content that doesn't match its hash")
		}
		for name, file := range runtime {
			decoded, err := base64.StdEncoding.DecodeString(release.files[name])
			if err != nil || digest(decoded) != file.Hash || m.Files[name] != file.Hash {
				t.Fatalf("verified with another runtime's %s", name)
			}
		}
		for _, asset := range m.Assets {
			if _, ok := release.Assets[asset.Hash]; !ok {
				t.Fatalf("verified without the asset %s", asset.Hash)
			}
		}
	})
}
