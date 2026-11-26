package main

import (
	"encoding/base64"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
)

// writeAsset stores asset bytes under a hash the caller has already verified, and that is a hash, as readAsset
// checks too.
func (s *Projects) writeAsset(hash string, data []byte) error {
	if !hashPattern.MatchString(hash) {
		return fail(http.StatusBadRequest, "Invalid asset hash.")
	}
	return atomicWrite(filepath.Join(s.root, "assets", hash), data)
}

// storeAsset keeps bytes by their SHA-256, once: a file there already holds them.
func (s *Projects) storeAsset(data []byte) (string, error) {
	hash := digest(data)
	if s.hasAsset(hash) {
		return hash, nil
	}
	return hash, s.writeAsset(hash, data)
}

var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (s *Projects) readAsset(hash string) ([]byte, error) {
	if !hashPattern.MatchString(hash) {
		return nil, fail(http.StatusBadRequest, "Invalid asset hash.")
	}
	data, err := os.ReadFile(filepath.Join(s.root, "assets", hash)) // #nosec G304 -- hash matched hashPattern above
	if errors.Is(err, os.ErrNotExist) {
		return nil, fail(http.StatusUnprocessableEntity, "An asset file is missing.")
	}
	return data, err
}
func verifyAssetBytes(asset Asset, data []byte) error {
	if digest(data) != asset.Hash || !mediaMatches(asset.Media, data) {
		return fail(http.StatusUnprocessableEntity, "The asset bytes do not match "+asset.Name+".")
	}
	return nil
}

// decodeAsset decodes an asset carried as base64 and verifies its bytes.
func decodeAsset(asset Asset, encoded string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fail(http.StatusUnprocessableEntity, "The asset bytes do not match "+asset.Name+".")
	}
	return data, verifyAssetBytes(asset, data)
}

// UploadAsset stores an imported image and stages it as a proposal.
func (s *Projects) UploadAsset(projectID string, data []byte, author ident) (*proposalResult, error) {
	var input struct {
		Asset
		Data         string `json:"data"`
		Branch       string `json:"branch"`
		BaseRevision string `json:"baseRevision"`
	}
	if err := decodeContract("asset-upload", data, &input); err != nil {
		return nil, err
	}
	if input.Branch == "" {
		input.Branch = "main"
	}
	file, err := base64.StdEncoding.DecodeString(input.Data)
	if err != nil || !mediaMatches(input.Media, file) {
		return nil, fail(http.StatusBadRequest, "The asset does not match its media type.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	if _, err := assertCurrent(p, input.Branch, input.BaseRevision); err != nil {
		return nil, err
	}
	hash, err := s.storeAsset(file)
	if err != nil {
		return nil, err
	}
	asset := input.Asset
	asset.ID, asset.Hash = newID(), hash
	normalizeSource(&asset)
	return s.submit(p, &Proposal{Branch: input.Branch, BaseRevision: input.BaseRevision,
		Label: truncateUTF16("Import "+asset.Name, 120), Operations: []Operation{{Op: "addAsset", Asset: &asset}}}, author)
}

// withAssetFiles mirrors Projects.withAssetFiles: the package must stay under
// the shared 48 MB limit, counted as the JSON it will become. It needs no
// lock: asset files are named by their hash, written atomically and never removed.
//
// Built games' files (gameFiles, by hash) travel in the same map.
func (s *Projects) withAssetFiles(metadataSize int, assets []Asset, gameFiles []string) (map[string]string, error) {
	remaining := PortableFileLimit - metadataSize
	if remaining < 0 {
		return nil, fail(http.StatusRequestEntityTooLarge, "This package exceeds the 48 MB file limit.")
	}
	files := map[string]string{}
	for _, asset := range assets {
		data, err := s.readAsset(asset.Hash)
		if err != nil {
			return nil, err
		}
		if err := verifyAssetBytes(asset, data); err != nil {
			return nil, err
		}
		if _, done := files[asset.Hash]; done {
			continue
		}
		extra := 0
		if len(files) > 0 {
			extra = 1
		}
		remaining -= 4*int(math.Ceil(float64(len(data))/3)) + len(asset.Hash) + 5 + extra
		if remaining < 0 {
			return nil, fail(http.StatusRequestEntityTooLarge, "This package exceeds the 48 MB file limit.")
		}
		files[asset.Hash] = base64.StdEncoding.EncodeToString(data)
	}
	for _, hash := range gameFiles {
		if _, done := files[hash]; done {
			continue
		}
		data, err := s.readAsset(hash)
		if err != nil {
			return nil, err
		}
		if digest(data) != hash {
			return nil, fail(http.StatusUnprocessableEntity, "A game file does not match its hash.")
		}
		extra := 0
		if len(files) > 0 {
			extra = 1
		}
		remaining -= 4*int(math.Ceil(float64(len(data))/3)) + len(hash) + 5 + extra
		if remaining < 0 {
			return nil, fail(http.StatusRequestEntityTooLarge, "This package exceeds the 48 MB file limit.")
		}
		files[hash] = base64.StdEncoding.EncodeToString(data)
	}
	return files, nil
}
func revisionGames(revisions []Revision) []*Game {
	games := make([]*Game, 0, len(revisions))
	for i := range revisions {
		games = append(games, revisions[i].Game)
	}
	return games
}
func revisionAssets(revisions []Revision) []Asset {
	all := []Asset{}
	for _, revision := range revisions {
		all = append(all, revision.Assets...)
	}
	return all
}

type projectBundle struct {
	Project *Project          `json:"project"`
	Assets  map[string]string `json:"assets"`
}

// exportedProject is a bundle's project in the key order exportBundle writes it.
type exportedProject struct {
	Version     int               `json:"version"`
	ID          string            `json:"id"`
	Title       string            `json:"title"`
	Template    string            `json:"template,omitempty"`
	Branches    map[string]string `json:"branches"`
	Upstream    string            `json:"upstream,omitempty"`
	Imported    bool              `json:"imported,omitempty"`
	Revisions   []Revision        `json:"revisions"`
	Notes       []Note            `json:"notes"`
	Attachments []Attachment      `json:"attachments"`
}
type exportedBundle struct {
	Project exportedProject   `json:"project"`
	Assets  map[string]string `json:"assets"`
}

// exportRevisions is every revision the branches reach, in full, oldest first,
// as exportBundle in packages/core/bundles.ts writes them.
func (s *Projects) exportRevisions(p *Project) ([]Revision, error) {
	repo := s.repository(p.ID)
	listed, err := logCommits(repo, branchHeads(p.Branches), 0)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	revisions := []Revision{}
	for _, commit := range slices.Backward(listed) {
		revision := revisionMeta(commit)
		content, err := s.history.content(repo, revision.ID)
		if err != nil {
			return nil, err
		}
		// A bundle's history has one root: a second root of an imported history follows the revision before it.
		if revision.Parent == nil || !ids[*revision.Parent] {
			revision.Parent = nil
			if len(revisions) > 0 {
				last := revisions[len(revisions)-1].ID
				revision.Parent = &last
			}
		}
		if !ids[revision.RestoredFrom] {
			revision.RestoredFrom = ""
		}
		revision.Scene, revision.Game, revision.Assets = content.Scene, content.Game, content.Assets
		revisions = append(revisions, revision)
		ids[revision.ID] = true
	}
	return revisions, nil
}

// exportable is a project and every revision its branches reach, read under the store's lock.
func (s *Projects) exportable(projectID string) (*Project, []Revision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.read(projectID)
	if err != nil {
		return nil, nil, err
	}
	revisions, err := s.exportRevisions(p)
	if err != nil {
		return nil, nil, err
	}
	return p, revisions, nil
}

func (s *Projects) Export(projectID string) ([]byte, error) {
	p, revisions, err := s.exportable(projectID)
	if err != nil {
		return nil, err
	}
	assets, err := deliveryAssets(revisionAssets(revisions))
	if err != nil {
		return nil, err
	}
	bundle := exportedBundle{exportedProject{p.Version, p.ID, p.Title, p.Template, p.Branches, p.Upstream, p.Imported, revisions,
		[]Note{}, []Attachment{}}, map[string]string{}}
	data, err := jsJSON(bundle)
	if err != nil {
		return nil, err
	}
	files, err := s.withAssetFiles(len(data), assets, gameFileHashes(revisionGames(revisions)...))
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return data, nil // the bundle without assets is already the whole export
	}
	bundle.Assets = files
	return jsJSON(bundle)
}

// Import makes a new project from a bundle, its revisions as commits by who asked.
func (s *Projects) Import(data []byte, author ident) (*Project, error) {
	var bundle projectBundle
	if err := decodeContract("project-bundle", data, &bundle); err != nil {
		return nil, err
	}
	source := bundle.Project
	if source == nil {
		return nil, fail(http.StatusBadRequest, "Invalid project-bundle.")
	}
	if err := normalizeProject(source); err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	for _, revision := range source.Revisions {
		if source.Template != "" && revision.Scene == nil && revision.Game == nil {
			return nil, fail(http.StatusUnprocessableEntity, "The imported legacy revision is missing its scene.")
		}
		validParent := revision.Parent == nil
		if len(ids) > 0 {
			validParent = revision.Parent != nil && ids[*revision.Parent]
		}
		if ids[revision.ID] || !validParent || (revision.RestoredFrom != "" && !ids[revision.RestoredFrom]) {
			return nil, fail(http.StatusBadRequest, "Revision history is invalid.")
		}
		ids[revision.ID] = true
	}
	if _, ok := source.Branches["main"]; !ok {
		return nil, fail(http.StatusBadRequest, "The imported branches have invalid revisions.")
	}
	for _, id := range source.Branches {
		if !ids[id] {
			return nil, fail(http.StatusBadRequest, "The imported branches have invalid revisions.")
		}
	}
	assets, err := deliveryAssets(revisionAssets(source.Revisions))
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{}
	for _, item := range assets {
		encoded, ok := bundle.Assets[item.Hash]
		if !ok {
			return nil, fail(http.StatusUnprocessableEntity, "An asset file is missing.")
		}
		decoded, err := decodeAsset(item, encoded)
		if err != nil {
			return nil, err
		}
		files[item.Hash] = decoded
	}
	for _, hash := range gameFileHashes(revisionGames(source.Revisions)...) {
		decoded, err := gameFileBytes(hash, bundle.Assets)
		if err != nil {
			return nil, err
		}
		files[hash] = decoded
	}
	if len(bundle.Assets) != len(files) {
		return nil, fail(http.StatusUnprocessableEntity, "The package contains undeclared assets.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for hash, file := range files {
		if err := s.writeAsset(hash, file); err != nil {
			return nil, err
		}
	}
	return s.createRepository(func(repo string) ([][2]string, error) {
		commits, hashes, err := writeRevisions(repo, source.Revisions, s.readAsset, &author, false)
		if err != nil {
			return nil, err
		}
		updates, err := branchUpdates(source.Branches, commits)
		if err == nil {
			_, err = updateRefs(repo, updates)
		}
		return hashes, err
	}, projectMeta{title: source.Title, template: source.Template, upstream: source.Upstream, imported: true}, newID())
}
