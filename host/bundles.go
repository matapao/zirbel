package main

import (
	"encoding/base64"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

// writeAsset stores asset bytes under a hash the caller has already verified.
func (s *Projects) writeAsset(hash string, data []byte) error {
	return atomicWrite(filepath.Join(s.root, "assets", hash), data)
}
func (s *Projects) storeAsset(data []byte) (string, error) {
	hash := digest(data)
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
func (s *Projects) UploadAsset(projectID string, data []byte) (*proposalResult, error) {
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
		Label: truncateUTF16("Import "+asset.Name, 120), Operations: []Operation{{Op: "addAsset", Asset: &asset}}})
}

// withAssetFiles mirrors Projects.withAssetFiles: the package must stay under
// the shared 48 MB limit, counted as the JSON it will become. It needs no
// lock: asset files are named by their hash, written atomically and never removed.
func (s *Projects) withAssetFiles(metadataSize int, assets []Asset) (map[string]string, error) {
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
	return files, nil
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

func (s *Projects) Export(projectID string) ([]byte, error) {
	p, err := s.Read(projectID)
	if err != nil {
		return nil, err
	}
	p.Notes, p.Attachments = []Note{}, []Attachment{}
	assets, err := deliveryAssets(revisionAssets(p.Revisions))
	if err != nil {
		return nil, err
	}
	data, err := jsJSON(projectBundle{p, map[string]string{}})
	if err != nil {
		return nil, err
	}
	files, err := s.withAssetFiles(len(data), assets)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return data, nil // the bundle without assets is already the whole export
	}
	return jsJSON(projectBundle{p, files})
}
func (s *Projects) Import(data []byte) (*Project, error) {
	var bundle projectBundle
	if err := decodeContract("project-bundle", data, &bundle); err != nil {
		return nil, err
	}
	source := bundle.Project
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
	source.ID, source.Notes, source.Attachments, source.Imported = newID(), []Note{}, []Attachment{}, true
	return s.save(source)
}
