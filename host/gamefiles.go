package main

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"zirbel/contracts"
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
	"obj": "model/obj", "mtl": "model/mtl", "fbx": "application/octet-stream", "hdr": "image/vnd.radiance", "exr": "image/x-exr",
	// Shaders, and a game's own source: plain text, which a browser never runs.
	"glsl": "text/plain; charset=utf-8", "vert": "text/plain; charset=utf-8", "frag": "text/plain; charset=utf-8",
	"ts": "text/plain; charset=utf-8", "tsx": "text/plain; charset=utf-8", "jsx": "text/plain; charset=utf-8",
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif", "avif": "image/avif",
	"svg": "image/svg+xml", "ico": "image/x-icon",
	"woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf", "otf": "font/otf",
	"mp3": "audio/mpeg", "ogg": "audio/ogg", "opus": "audio/ogg", "wav": "audio/wav", "m4a": "audio/mp4", "aac": "audio/aac",
	"flac": "audio/flac", "mp4": "video/mp4", "webm": "video/webm",
}

// maxGameFiles mirrors MAX_GAME_FILES: files besides index.html.
const maxGameFiles = 1000

// sharedPlayers and netPlayersMax mirror SHARED_PLAYERS and NET_PLAYERS in
// packages/sdk/game.ts: the most players of a game sharing state, and of a game
// with its own netcode (net), which plays over the relay (relay.go) and
// releases with netSimulation.
const (
	sharedPlayers = 4
	netPlayersMax = 16
	netSimulation = "net-v2"
)

func isNet(simulation *string) bool { return simulation != nil && *simulation == netSimulation }

// withinPlayers is gameDocument's refinement: more than 4 players only with net.
func withinPlayers(game *Game) error {
	if game.MaxPlayers > sharedPlayers && !game.Net {
		return fail(http.StatusBadRequest, "game.maxPlayers · A game for more than 4 players needs net.")
	}
	return nil
}

// manifestBase64 is the longest zirbel.json netPlayers reads: 64 KB as base64.
const manifestBase64 = (65_536 + 2) / 3 * 4

// netPlayers mirrors netPlayers in packages/core/game-files.ts. A built folder
// can carry zirbel.json, the earlier Zirbel's description of a game: an integer
// players.max above 1 there says the game brings its own netcode, for up to 16
// players. Anything else (missing, too long, not JSON, not an integer) leaves a
// game for one.
func netPlayers(encoded string, present bool) int {
	if !present || len(encoded) > manifestBase64 {
		return 1
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return 1
	}
	// Decode keeps the last of duplicate keys, as JSON.parse does.
	parsed, err := contracts.Decode(data)
	if err != nil {
		return 1
	}
	manifest, _ := parsed.(map[string]any)
	players, _ := manifest["players"].(map[string]any)
	number, ok := players["max"].(json.Number)
	if !ok {
		return 1
	}
	// JSON.parse reads every number as a double: 3.0 is 3, and 1e400 is Infinity.
	max, err := strconv.ParseFloat(string(number), 64)
	if err != nil || math.IsInf(max, 0) || max != math.Trunc(max) || max <= 1 {
		return 1
	}
	return int(math.Min(max, netPlayersMax))
}

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
	manifest, described := input.Files["zirbel.json"]
	players := netPlayers(manifest, described)
	game := &Game{HTML: html, MaxPlayers: players, Net: players > 1, Files: stored}
	return s.createRevision(title, initialRevision{game: game, label: "Imported game folder"})
}
