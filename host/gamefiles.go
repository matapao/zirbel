package main

import (
	"encoding/base64"
	"net/http"
	"path"
	"sort"
	"strings"
	"unicode/utf8"
)

// Games imported as a built folder, mirroring packages/core/game-files.ts:
// index.html becomes the game document, and every other file is stored by its
// content hash and listed in the document's files.

// gameFileTypes mirrors GAME_FILE_TYPES in packages/sdk/game.ts.
var gameFileTypes = map[string]string{
	"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
	"css": "text/css; charset=utf-8", "json": "application/json; charset=utf-8", "map": "application/json; charset=utf-8",
	"txt": "text/plain; charset=utf-8", "csv": "text/csv; charset=utf-8", "wasm": "application/wasm",
	"glb": "model/gltf-binary", "gltf": "model/gltf+json", "bin": "application/octet-stream", "ktx2": "image/ktx2",
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif", "avif": "image/avif",
	"svg": "image/svg+xml", "ico": "image/x-icon",
	"woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf", "otf": "font/otf",
	"mp3": "audio/mpeg", "ogg": "audio/ogg", "opus": "audio/ogg", "wav": "audio/wav", "m4a": "audio/mp4", "aac": "audio/aac",
	"flac": "audio/flac", "mp4": "video/mp4", "webm": "video/webm",
}

// maxGameFiles mirrors MAX_GAME_FILES: files besides index.html.
const maxGameFiles = 1000

func gameFileType(name string) string {
	if kind, ok := gameFileTypes[strings.TrimPrefix(path.Ext(name), ".")]; ok {
		return kind
	}
	return "application/octet-stream"
}

// gameFileHashes mirrors gameFileHashes: every file the built games list, once each.
func gameFileHashes(games ...*Game) []string {
	seen := map[string]bool{}
	hashes := []string{}
	for _, game := range games {
		if game == nil {
			continue
		}
		for _, name := range sortedKeys(game.Files) {
			if hash := game.Files[name]; !seen[hash] {
				seen[hash] = true
				hashes = append(hashes, hash)
			}
		}
	}
	return hashes
}

func sortedKeys(files map[string]string) []string {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// gameFileBytes mirrors gameFileBytes: a built game's file carried as base64,
// which must match its hash.
func gameFileBytes(hash string, encoded map[string]string) ([]byte, error) {
	data, ok := encoded[hash]
	if !ok {
		return nil, fail(http.StatusUnprocessableEntity, "A game file is missing.")
	}
	bytes, err := base64.StdEncoding.DecodeString(data)
	if err != nil || digest(bytes) != hash {
		return nil, fail(http.StatusUnprocessableEntity, "A game file does not match its hash.")
	}
	return bytes, nil
}

// ImportGameFolder mirrors importGameFolder in packages/core/game-files.ts.
func (s *Projects) ImportGameFolder(data []byte) (*Project, error) {
	var input struct {
		Title *string           `json:"title"`
		Files map[string]string `json:"files"`
	}
	if err := decodeContract("game-folder", data, &input); err != nil {
		return nil, err
	}
	if _, ok := input.Files["index.html"]; !ok {
		return nil, fail(http.StatusUnprocessableEntity, "A game folder needs an index.html at its top.")
	}
	if len(input.Files) > maxGameFiles+1 {
		return nil, fail(http.StatusRequestEntityTooLarge, "A game folder holds up to 1000 files besides index.html.")
	}
	decoded := make(map[string][]byte, len(input.Files))
	for name, encoded := range input.Files {
		bytes, err := base64.StdEncoding.DecodeString(encoded)
		if len(encoded)%4 != 0 || err != nil {
			return nil, fail(http.StatusBadRequest, "files · Invalid base64")
		}
		decoded[name] = bytes
	}
	if !utf8.Valid(decoded["index.html"]) {
		return nil, fail(http.StatusUnprocessableEntity, "index.html must be UTF-8 text.")
	}
	html, err := trimmed("game.html", string(decoded["index.html"]), 400_000)
	if err != nil {
		return nil, err
	}
	title := "Imported game"
	if input.Title != nil {
		title = *input.Title
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	stored := map[string]string{}
	for _, name := range sortedKeys(input.Files) {
		if name == "index.html" {
			continue
		}
		if stored[name], err = s.storeAsset(decoded[name]); err != nil {
			return nil, err
		}
	}
	return s.createRevision(title, initialRevision{game: &Game{HTML: html, MaxPlayers: 1, Files: stored}, label: "Imported game folder"})
}
