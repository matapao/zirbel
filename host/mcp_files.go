package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"unicode/utf8"

	"zirbel/contracts"
)

// The game's files over the project MCP endpoint, mirroring
// packages/server/mcp-files.ts: read_file reads one by its path, and
// write_files stages a revision that writes or removes some of them. Files
// arrive only with their bytes, so a grant can't reach another project's files
// by their hashes.

// gameBytes mirrors GAME_BYTES in packages/server/turn-folder.ts: what a
// game's folder may hold in all, as 48 MB of base64 carries.
const gameBytes = PortableFileLimit * 3 / 4

type readFileArgs struct {
	Path     string  `json:"path"`
	Branch   *string `json:"branch"`
	Revision *string `json:"revision"`
}

// gameFileContents is a file as read_file returns it: UTF-8 text as text,
// anything else as base64.
type gameFileContents struct {
	Revision string  `json:"revision"`
	Path     string  `json:"path"`
	Size     int     `json:"size"`
	Base64   *string `json:"base64,omitempty"`
	Text     *string `json:"text,omitempty"`
}

type fileChange struct {
	Path   string  `json:"path"`
	Text   *string `json:"text"`
	Base64 *string `json:"base64"`
	Remove bool    `json:"remove"`
}

type writeFilesArgs struct {
	Branch       *string      `json:"branch"`
	BaseRevision string       `json:"baseRevision"`
	Label        string       `json:"label"`
	Files        []fileChange `json:"files"`
}

// toolArgs decodes a tool's arguments against its contract; none are {}.
func toolArgs(contract string, raw json.RawMessage, out any) error {
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage("{}")
	}
	return decodeContract(contract, raw, out)
}

func branchOrMain(branch *string) string {
	if branch == nil {
		return "main"
	}
	return *branch
}

func (m *MCP) readFile(g *grant, raw json.RawMessage) (any, error) {
	var args readFileArgs
	if err := toolArgs("mcp-read-file", raw, &args); err != nil {
		return nil, err
	}
	return m.projects.ReadGameFile(g.ProjectID, args.Path, branchOrMain(args.Branch), args.Revision)
}

func (m *MCP) writeFiles(g *grant, raw json.RawMessage) (any, error) {
	var args writeFilesArgs
	if err := toolArgs("mcp-write-files", raw, &args); err != nil {
		return nil, err
	}
	return m.projects.StageFiles(g.ProjectID, &args, grantAuthor(g.ID))
}

// ReadGameFile is one file of a revision's game: the branch head's, or the
// revision's when one is named.
func (s *Projects) ReadGameFile(projectID, path, branch string, revision *string) (*gameFileContents, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	var source *Revision
	if revision == nil {
		source, err = head(p, branch)
	} else {
		source, err = s.revision(projectID, *revision)
	}
	if err != nil {
		return nil, err
	}
	if source.Game == nil {
		return nil, fail(http.StatusNotFound, "This revision has no game.")
	}
	var data []byte
	if path == "index.html" {
		data = []byte(source.Game.HTML)
	} else {
		hash, ok := source.Game.Files[path]
		if !ok {
			return nil, fail(http.StatusNotFound, "The game has no file at "+path+".")
		}
		if data, err = s.readAsset(hash); err != nil {
			return nil, err
		}
	}
	// The text is the file's bytes exactly, a byte order mark included.
	result := &gameFileContents{Revision: source.ID, Path: path, Size: len(data)}
	if utf8.Valid(data) {
		text := string(data)
		result.Text = &text
	} else {
		encoded := base64.StdEncoding.EncodeToString(data)
		result.Base64 = &encoded
	}
	return result, nil
}

// changeBytes is what a change writes: its text as UTF-8, or its base64.
func changeBytes(change fileChange) ([]byte, error) {
	switch {
	case change.Text != nil:
		return []byte(*change.Text), nil
	case change.Base64 != nil:
		data, err := base64.StdEncoding.DecodeString(*change.Base64)
		if err != nil {
			return nil, fail(http.StatusBadRequest, "files · Invalid base64")
		}
		return data, nil
	}
	return nil, fail(http.StatusBadRequest, "Invalid arguments.")
}

// pageText is index.html as an import reads it: UTF-8, without a byte order
// mark or the white space around it, at most 400,000 characters.
func pageText(data []byte) (string, error) {
	if !utf8.Valid(data) {
		return "", fail(http.StatusUnprocessableEntity, "index.html must be UTF-8 text.")
	}
	text := contracts.Trim(string(data))
	if text == "" || (len(text) > 400_000 && utf8.RuneCountInString(text) > 400_000) {
		return "", fail(http.StatusUnprocessableEntity, "index.html must hold the game’s page, at most 400,000 characters.")
	}
	return text, nil
}

// StageFiles stages the branch head's game with these files written or
// removed, and the rest as they are.
func (s *Projects) StageFiles(projectID string, args *writeFilesArgs, author ident) (*proposalResult, error) {
	label, err := trimmed("label", args.Label, 120)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, change := range args.Files {
		if seen[change.Path] {
			return nil, fail(http.StatusBadRequest, "Name each file once: "+change.Path+".")
		}
		seen[change.Path] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	branch := branchOrMain(args.Branch)
	base, err := assertCurrent(p, branch, args.BaseRevision)
	if err != nil {
		return nil, err
	}
	game := &Game{MaxPlayers: 1}
	hasPage, kept := false, map[string]string{}
	if base.Game != nil {
		game.HTML, game.MaxPlayers, game.Net, game.Adapter, game.Controls, game.RegisterObjects, hasPage = base.Game.HTML, base.Game.MaxPlayers,
			base.Game.Net, base.Game.Adapter, base.Game.Controls, base.Game.RegisterObjects, true
		for name, hash := range base.Game.Files {
			kept[name] = hash
		}
	}
	written := map[string][]byte{}
	for _, change := range args.Files {
		if change.Remove {
			if change.Path == "index.html" {
				return nil, fail(http.StatusUnprocessableEntity, "A game keeps its index.html: write it instead.")
			}
			if _, ok := kept[change.Path]; !ok {
				return nil, fail(http.StatusNotFound, "The game has no file at "+change.Path+".")
			}
			delete(kept, change.Path)
			continue
		}
		data, err := changeBytes(change)
		if err != nil {
			return nil, err
		}
		if change.Path == "index.html" {
			if game.HTML, err = pageText(data); err != nil {
				return nil, err
			}
			hasPage = true
			continue
		}
		delete(kept, change.Path)
		written[change.Path] = data
	}
	if !hasPage {
		return nil, fail(http.StatusUnprocessableEntity, "This project has no game yet: write its index.html too.")
	}
	count := len(kept) + len(written)
	if base.Game != nil && len(base.Game.Files) > 0 && count == 0 {
		return nil, fail(http.StatusUnprocessableEntity, "A game imported as a folder keeps at least one file beside index.html.")
	}
	if count > maxGameFiles {
		return nil, fail(http.StatusRequestEntityTooLarge, "A game folder holds up to 1000 files besides index.html.")
	}
	size := len(game.HTML)
	for _, hash := range kept {
		info, err := os.Stat(filepath.Join(s.root, "assets", hash))
		if err != nil {
			return nil, fail(http.StatusUnprocessableEntity, "An asset file is missing.")
		}
		size += int(info.Size())
	}
	for _, data := range written {
		size += len(data)
	}
	if size > gameBytes {
		return nil, fail(http.StatusRequestEntityTooLarge, "The game would be larger than a game can be ("+strconv.Itoa(gameBytes/1_000_000)+" MB).")
	}
	for name, data := range written {
		if kept[name], err = s.storeAsset(data); err != nil {
			return nil, err
		}
	}
	// zirbel.json says how many play and names the adapter and the controls, as in an imported folder: read again from the
	// files the game ends with whenever it, or the adapter it names, changes.
	if _, adapterKept := kept[game.Adapter]; seen["zirbel.json"] || (game.Adapter != "" && (seen[game.Adapter] || !adapterKept)) {
		manifest, present := "", false
		if hash, ok := kept["zirbel.json"]; ok {
			data, err := s.readAsset(hash)
			if err != nil {
				return nil, fail(http.StatusUnprocessableEntity, "An asset file is missing.")
			}
			manifest, present = base64.StdEncoding.EncodeToString(data), true
		}
		game.MaxPlayers, game.Adapter = describedGame(manifest, present, kept)
		game.Net, game.Controls = game.MaxPlayers > 1, describedControls(manifest, present)
	}
	if count > 0 || (base.Game != nil && base.Game.Files != nil) {
		game.Files = kept
	}
	return s.submit(p, &Proposal{BaseRevision: args.BaseRevision, Branch: branch, Label: label,
		Operations: []Operation{{Op: "writeGame", Game: game}}}, author)
}
