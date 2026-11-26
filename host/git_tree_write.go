package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
)

// Content written over a base tree, mirroring treeChanges in
// packages/core/git-tree.ts: the host changes only what it manages
// (index.html, every game path, and .zirbel/), each file when its bytes
// change, and writes its JSON files as JSON.stringify(value, null, 2) writes
// them, so both hosts write the same trees (git.contract compares them).

// ownGameFields is what .zirbel/game.json holds for a game: the fields its
// zirbel.json doesn't set, where they aren't the defaults; nil for none.
func ownGameFields(game *Game, manifest []byte, present bool) *ownGame {
	players, _ := describedGame(base64.StdEncoding.EncodeToString(manifest), present, game.Files)
	own := ownGame{RegisterObjects: game.RegisterObjects}
	if players <= 1 {
		if game.MaxPlayers != 1 {
			own.MaxPlayers = game.MaxPlayers
		}
		own.Net = game.Net
	}
	if own == (ownGame{}) {
		return nil
	}
	return &own
}

// jsonFile is a JSON file as Zirbel writes one: JSON.stringify(value, null, 2) and a line break.
func jsonFile(value any) ([]byte, error) {
	data, err := jsJSON(value)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, data, "", "  "); err != nil {
		return nil, err
	}
	out.WriteByte('\n')
	return out.Bytes(), nil
}

// treeChanges are the changes that make a base tree hold this content: the
// host's own paths only (index.html, the game's paths and .zirbel/), each
// written when its bytes change. read: a file's bytes by its SHA-256. It also
// gives the new blobs' SHA-256s.
func treeChanges(base []treeEntry, sha256 func(oid string) string, next Content, read func(hash string) ([]byte, error),
	stream *fastImport) ([]treeChange, [][2]string, error) {
	at := entriesAt(base)
	changes, hashes := []treeChange{}, [][2]string{}
	write := func(path string, data []byte, hash string) {
		oid := blobID(data)
		if hash != "" {
			hashes = append(hashes, [2]string{oid, hash})
		}
		if entry, ok := at[path]; ok && regular(entry) && entry.oid == oid {
			return
		}
		changes = append(changes, treeChange{op: "M", mode: "100644", blob: stream.blob(data), path: path})
	}
	remove := func(path string) {
		if _, ok := at[path]; ok {
			changes = append(changes, treeChange{op: "D", path: path})
		}
	}
	writeJSON := func(path string, value any) error {
		data, err := jsonFile(value)
		if err == nil {
			write(path, data, "")
		}
		return err
	}
	if game := next.Game; game != nil {
		write("index.html", []byte(game.HTML), "")
		for _, entry := range base {
			if _, kept := game.Files[entry.path]; entry.path != "index.html" && isGamePath(entry.path) && !kept {
				remove(entry.path)
			}
		}
		for _, path := range sortedKeys(game.Files) {
			hash := game.Files[path]
			if entry, ok := at[path]; ok && regular(entry) && sha256(entry.oid) == hash {
				continue
			}
			data, err := read(hash)
			if err != nil {
				return nil, nil, err
			}
			write(path, data, hash)
		}
		manifest, present := []byte(nil), false
		if hash, ok := game.Files["zirbel.json"]; ok {
			data, err := read(hash)
			if err != nil {
				return nil, nil, err
			}
			manifest, present = data, true
		}
		if own := ownGameFields(game, manifest, present); own != nil {
			if err := writeJSON(gameJSON, own); err != nil {
				return nil, nil, err
			}
		} else {
			remove(gameJSON)
		}
	}
	if next.Scene != nil {
		if err := writeJSON(sceneJSON, next.Scene); err != nil {
			return nil, nil, err
		}
	} else {
		remove(sceneJSON)
	}
	wanted := map[string]bool{}
	for _, item := range next.Assets {
		wanted[assetPath(item)] = true
	}
	for _, entry := range base {
		if strings.HasPrefix(entry.path, assetDirectory) && !wanted[entry.path] {
			remove(entry.path)
		}
	}
	written := map[string]bool{}
	for _, item := range next.Assets {
		path := assetPath(item)
		if _, kept := at[path]; !written[path] && !kept {
			written[path] = true
			data, err := read(item.Hash)
			if err != nil {
				return nil, nil, err
			}
			write(path, data, "")
		}
	}
	if len(next.Assets) > 0 {
		if err := writeJSON(assetsJSON, next.Assets); err != nil {
			return nil, nil, err
		}
	} else {
		remove(assetsJSON)
	}
	return changes, hashes, nil
}
