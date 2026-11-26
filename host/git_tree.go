package main

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"zirbel/contracts"
)

// A revision's tree, mirroring packages/core/git-tree.ts: the game's folder as
// a client sees it after git clone (index.html and its files at the top, and
// the game's own zirbel.json), with the host's own files under .zirbel/ (the
// document's own fields, an older project's scene, imported assets), and
// anything else kept as it is. readTree reads one into a revision's content
// under the rules every host applies; treeChanges writes content over a base
// tree, touching only what the host manages. docs/git-store.md is the design.

// Content is a revision's content: an older project's scene, the game, and the
// imported assets, in the order the Node host writes them.
type Content struct {
	Scene  *Scene  `json:"scene,omitempty"`
	Game   *Game   `json:"game,omitempty"`
	Assets []Asset `json:"assets"`
}

// treeEntries is how many entries a tree may hold before it is plainly not a game.
const treeEntries = 4 * maxGameFiles

const (
	gameJSON       = ".zirbel/game.json"
	sceneJSON      = ".zirbel/scene.json"
	assetsJSON     = ".zirbel/assets.json"
	assetDirectory = ".zirbel/assets/"
)

var (
	assetExtensions = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
	// gameFilePattern is gameFilePath in packages/sdk/game.ts: relative, at most 8 deep, no segment starting with a
	// dot, and an extension from the table.
	gameFilePattern = regexp.MustCompile(`^(?:[A-Za-z0-9_][A-Za-z0-9._-]*/){0,7}[A-Za-z0-9_][A-Za-z0-9._-]*\.(?:` +
		strings.Join(sortedKeys(gameFileTypes), "|") + `)$`)
	restoredTrailer = regexp.MustCompile(`^Zirbel-Restored-From: ([0-9a-f]{40})$`)
)

func assetPath(asset Asset) string {
	return assetDirectory + asset.Hash + "." + assetExtensions[asset.Media]
}

func isGameFilePath(path string) bool { return len(path) <= 240 && gameFilePattern.MatchString(path) }

// isGamePath: index.html and every path a game file can have are the game's.
func isGamePath(path string) bool { return path == "index.html" || isGameFilePath(path) }

func regular(entry treeEntry) bool {
	return entry.kind == "blob" && (entry.mode == "100644" || entry.mode == "100755")
}

// entriesAt are a tree's entries by their paths.
func entriesAt(entries []treeEntry) map[string]treeEntry {
	at := make(map[string]treeEntry, len(entries))
	for _, item := range entries {
		at[item.path] = item
	}
	return at
}

func listedPaths(paths []string) string {
	if len(paths) > 8 {
		return strings.Join(paths[:8], ", ") + ", …"
	}
	return strings.Join(paths, ", ")
}

// treeSource is what reading a tree needs besides its entries: some blobs'
// bytes, the SHA-256 of the game files' blobs, and the imported assets' bytes
// checked (and kept, where the host keeps them): the problems found.
type treeSource struct {
	bytes  func(oids []string) (map[string][]byte, error)
	sha256 func(entries []treeEntry) (map[string]string, error)
	assets func(found []foundAsset) ([]string, error)
}

// foundAsset is an asset assets.json lists, and the entry its bytes are at.
type foundAsset struct {
	asset Asset
	entry treeEntry
}

// utf8Text is bytes as TextDecoder reads them, fatal on bad UTF-8 and without a byte order mark.
func utf8Text(data []byte) (string, bool) {
	if !utf8.Valid(data) {
		return "", false
	}
	return strings.TrimPrefix(string(data), "\uFEFF"), true
}

// parsedJSON reads a JSON file of the tree as JSON.parse would, and checks it against a contract.
func parsedJSON(data []byte, contract string, out any) bool {
	text, ok := utf8Text(data)
	if !ok {
		return false
	}
	value, err := contracts.Decode([]byte(text))
	return err == nil && contracts.Validate(contract, value) == nil && contracts.Unmarshal(value, out) == nil
}

// ownGame is what .zirbel/game.json holds: the game document's own fields,
// for what the game's zirbel.json doesn't say.
type ownGame struct {
	MaxPlayers      int   `json:"maxPlayers,omitempty"`
	Net             bool  `json:"net,omitempty"`
	RegisterObjects *bool `json:"registerObjects,omitempty"`
}

// parsedOwn reads .zirbel/game.json: a strict object of maxPlayers (an integer
// from 1 to 16), net (true) and registerObjects (a boolean), each optional.
func parsedOwn(data []byte) (ownGame, bool) {
	own := ownGame{}
	text, ok := utf8Text(data)
	if !ok {
		return own, false
	}
	value, err := contracts.Decode([]byte(text))
	fields, isObject := value.(map[string]any)
	if err != nil || !isObject {
		return own, false
	}
	for key, raw := range fields {
		switch key {
		case "maxPlayers":
			number, isNumber := raw.(json.Number)
			players, err := strconv.ParseFloat(string(number), 64)
			if !isNumber || err != nil || players < 1 || players > netPlayersMax || players != math.Trunc(players) {
				return own, false
			}
			own.MaxPlayers = int(players)
		case "net":
			if raw != true {
				return own, false
			}
			own.Net = true
		case "registerObjects":
			flag, isBool := raw.(bool)
			if !isBool {
				return own, false
			}
			own.RegisterObjects = &flag
		default:
			return own, false
		}
	}
	return own, true
}

// readTree reads a tree's content, and its problems: hard ones (too many
// entries, links or submodules, too large) leave it without content; a part
// that can't be read is left out. A push, import or update is refused for any
// problem.
func readTree(entries []treeEntry, source treeSource) (Content, []string, error) {
	content := Content{Assets: []Asset{}}
	if len(entries) > treeEntries {
		return content, []string{"It holds more than " + strconv.Itoa(treeEntries) + " files, more than a game can."}, nil
	}
	odd := []string{}
	var total int64
	for _, entry := range entries {
		if entry.kind != "blob" || entry.mode == "120000" {
			odd = append(odd, entry.path)
		}
		total += entry.size
	}
	if len(odd) > 0 {
		return content, []string{"It holds links or submodules, which a game can’t: " + listedPaths(odd) + "."}, nil
	}
	if total > PortableFileLimit {
		return content, []string{"It is larger than " + strconv.Itoa(PortableFileLimit/1_000_000) + " MB."}, nil
	}
	at := entriesAt(entries)
	small := []string{}
	for _, path := range []string{"index.html", "zirbel.json", gameJSON, sceneJSON, assetsJSON} {
		if entry, ok := at[path]; ok && regular(entry) {
			small = append(small, entry.oid)
		}
	}
	data, err := source.bytes(small)
	if err != nil {
		return content, nil, err
	}
	of := func(path string) ([]byte, bool) {
		if entry, ok := at[path]; ok && regular(entry) {
			found, ok := data[entry.oid]
			return found, ok
		}
		return nil, false
	}
	problems := []string{}
	if index, ok := at["index.html"]; ok && regular(index) {
		game, problem, err := readGame(entries, index, of, source)
		if err != nil {
			return content, nil, err
		}
		if problem != "" {
			problems = append(problems, problem)
		}
		content.Game = game
	}
	if file, ok := of(sceneJSON); ok {
		var scene Scene
		if parsedJSON(file, "scene", &scene) && normalizeScene(&scene) == nil {
			content.Scene = &scene
		} else {
			problems = append(problems, sceneJSON+" is not a scene Zirbel reads.")
		}
	}
	if file, ok := of(assetsJSON); ok {
		problem, list, err := readAssets(file, at, source)
		if err != nil {
			return content, nil, err
		}
		problems = append(problems, problem...)
		if list != nil {
			content.Assets = list
		}
	}
	return content, problems, nil
}

// readAssets reads .zirbel/assets.json and checks each asset's bytes: the
// problems found, or the assets.
func readAssets(file []byte, at map[string]treeEntry, source treeSource) ([]string, []Asset, error) {
	var list []Asset
	unique := map[string]bool{}
	valid := parsedJSON(file, "asset-list", &list)
	for i := range list {
		normalizeSource(&list[i])
		valid = valid && !unique[list[i].ID]
		unique[list[i].ID] = true
	}
	if !valid {
		return []string{assetsJSON + " is not a list of assets Zirbel reads."}, nil, nil
	}
	found, missing := []foundAsset{}, []string{}
	for _, item := range list {
		if entry, ok := at[assetPath(item)]; ok && regular(entry) {
			found = append(found, foundAsset{item, entry})
		} else {
			missing = append(missing, item.Name)
		}
	}
	if len(missing) > 0 {
		return []string{"The bytes of these assets are missing: " + listedPaths(missing) + "."}, nil, nil
	}
	wrong, err := source.assets(found)
	if err != nil || len(wrong) > 0 {
		return wrong, nil, err
	}
	if list == nil {
		list = []Asset{}
	}
	return nil, list, nil
}

// readGame reads the game a tree's index.html is the page of: the game, or the problem it has.
func readGame(entries []treeEntry, index treeEntry, of func(string) ([]byte, bool), source treeSource) (*Game, string, error) {
	page, _ := of("index.html")
	text, ok := utf8Text(page)
	if !ok {
		return nil, "index.html must be UTF-8 text.", nil
	}
	html, ok := pageHTML(text)
	if !ok {
		return nil, "index.html must hold the game’s page, at most 400,000 characters.", nil
	}
	files := []treeEntry{}
	paths := map[string]string{}
	size := index.size
	for _, entry := range entries {
		if entry.path != "index.html" && regular(entry) && isGameFilePath(entry.path) {
			files = append(files, entry)
			paths[entry.path] = entry.oid
			size += entry.size
		}
	}
	if len(files) > maxGameFiles {
		return nil, "A game holds up to " + strconv.Itoa(maxGameFiles) + " files besides index.html.", nil
	}
	if size > gameBytes {
		return nil, "The game is larger than a game can be (" + strconv.Itoa(gameBytes/1_000_000) + " MB).", nil
	}
	own := ownGame{}
	if file, ok := of(gameJSON); ok {
		if own, ok = parsedOwn(file); !ok {
			return nil, gameJSON + " is not one Zirbel reads.", nil
		}
	}
	manifest, present := []byte(nil), false
	if _, listed := paths["zirbel.json"]; listed {
		manifest, present = of("zirbel.json")
	}
	encoded := base64.StdEncoding.EncodeToString(manifest)
	players, adapter := describedGame(encoded, present, paths)
	net := players > 1
	if !net {
		players, net, adapter = max(own.MaxPlayers, 1), own.Net, ""
	}
	if players > sharedPlayers && !net {
		return nil, gameJSON + " gives more than " + strconv.Itoa(sharedPlayers) + " players to a game without net.", nil
	}
	hashes, err := source.sha256(files)
	if err != nil {
		return nil, "", err
	}
	game := &Game{HTML: html, MaxPlayers: players, Net: net, Adapter: adapter, Controls: describedControls(encoded, present),
		RegisterObjects: own.RegisterObjects}
	if len(files) > 0 {
		game.Files = map[string]string{}
		for _, entry := range files {
			if game.Files[entry.path] = hashes[entry.oid]; !hashPattern.MatchString(hashes[entry.oid]) {
				return nil, "The game’s files could not be read.", nil
			}
		}
	}
	return game, "", nil
}

// pageHTML is a game's page as gameDocument reads its html: trimmed, 1 to 400,000 characters.
func pageHTML(text string) (string, bool) {
	html := contracts.Trim(text)
	return html, html != "" && (len(html) <= 400_000 || utf8.RuneCountInString(html) <= 400_000)
}

// revisionMeta is a commit as history lists it.
func revisionMeta(info commitInfo) Revision {
	first, _, _ := strings.Cut(info.message, "\n")
	label := contracts.Trim(codePoints(contracts.Trim(first), 120))
	if label == "" {
		label = "Untitled revision"
	}
	revision := Revision{ID: info.id, Label: label, Date: time.Unix(info.time, 0).UTC().Format("2006-01-02T15:04:05.000Z"),
		Author: identName(info.author)}
	if len(info.parents) > 0 {
		parent := info.parents[0]
		revision.Parent = &parent
	}
	// JavaScript's /^…$/m: a line ends at \n, \r, U+2028 or U+2029.
	for _, line := range strings.FieldsFunc(info.message, func(r rune) bool { return r == '\n' || r == '\r' || r == 0x2028 || r == 0x2029 }) {
		if match := restoredTrailer.FindStringSubmatch(line); match != nil {
			revision.RestoredFrom = match[1]
			break
		}
	}
	return revision
}
