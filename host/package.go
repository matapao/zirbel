package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
)

// Editor-side release operations, mirroring packages/core/releases.ts.

type credit struct {
	Name    string `json:"name"`
	Credit  string `json:"credit"`
	License string `json:"license"`
}

// manifestOut is the manifest in the key order Releases.package writes.
type manifestOut struct {
	Format         int               `json:"format"`
	ReleaseID      string            `json:"releaseId"`
	GameID         string            `json:"gameId"`
	SourceRevision string            `json:"sourceRevision"`
	Title          string            `json:"title"`
	Template       string            `json:"template,omitempty"`
	SDK            string            `json:"sdk"`
	Protocol       int               `json:"protocol"`
	Client         string            `json:"client"`
	Simulation     *string           `json:"simulation"`
	Players        playerRange       `json:"players"`
	Capabilities   []string          `json:"capabilities"`
	Permissions    Permissions       `json:"permissions"`
	Assets         []Asset           `json:"assets"`
	Credits        []credit          `json:"credits"`
	Files          map[string]string `json:"files"`
}

type packaged struct {
	Manifest  manifestOut       `json:"manifest"`
	Game      *Game             `json:"game,omitempty"`
	Scene     *Scene            `json:"scene,omitempty"`
	SceneHash string            `json:"sceneHash"`
	Files     map[string]string `json:"files"`
	Assets    map[string]string `json:"assets"`
}

// Editor holds what release packaging needs beyond the headless host.
type Editor struct {
	projects *Projects
	releases *Releases
	once     sync.Once
	files    map[string]string // runtime files as base64, built on first use
	hashes   map[string]string
}

func (e *Editor) runtimeFiles() (map[string]string, map[string]string) {
	e.once.Do(func() {
		e.files, e.hashes = map[string]string{}, map[string]string{}
		for name, file := range e.releases.runtime {
			e.files[name] = base64.StdEncoding.EncodeToString(file.Bytes)
			e.hashes[name] = file.Hash
		}
	})
	return e.files, e.hashes
}

// source reads, under the store lock, what a release is built from: the
// project, and its branch head or a staged proposal on that head. A
// baseRevision pins the head the caller saw.
func (e *Editor) source(projectID, branch, baseRevision string, draft bool, proposalID string) (*Project, *Revision, error) {
	e.projects.mu.Lock()
	defer e.projects.mu.Unlock()
	p, err := e.projects.read(projectID)
	if err != nil {
		return nil, nil, err
	}
	base, err := head(p, branch)
	if baseRevision != "" {
		base, err = assertCurrent(p, branch, baseRevision)
	}
	if err != nil {
		return nil, nil, err
	}
	revision := *base
	if proposalID != "" {
		proposal, err := e.projects.getProposal(projectID, proposalID)
		if err != nil {
			return nil, nil, err
		}
		preview, err := previewOn(p, proposal)
		if err != nil {
			return nil, nil, err
		}
		if !draft || proposal.Branch != branch {
			return nil, nil, fail(http.StatusConflict, "This proposal cannot be played on that branch.")
		}
		revision.Game, revision.Scene, revision.Assets = preview.Game, preview.Scene, preview.Assets
	}
	return p, &revision, nil
}

// Package builds a release from a branch head, or from a staged proposal for a
// draft playtest. Published releases are stored; drafts stay in memory.
func (e *Editor) Package(projectID, branch, baseRevision string, permissions Permissions, publish, draft bool, proposalID string) (*Release, error) {
	if publish && draft {
		return nil, fail(http.StatusBadRequest, "A draft playtest is private to this host.")
	}
	p, revision, err := e.source(projectID, branch, baseRevision, draft, proposalID)
	if err != nil {
		return nil, err
	}
	settings, err := runtimeSettings(p.Template, revision.Game)
	if err != nil {
		return nil, err
	}
	credits := []credit{
		{p.Title, "Project creator", "Original project content"},
		{"Three.js", "Three.js authors", "MIT"},
		{"Zod", "Zod authors", "MIT"},
	}
	for _, asset := range revision.Assets {
		credits = append(credits, credit{asset.Name, asset.Author + " · " + asset.Credit + " · " + asset.Source, asset.License})
	}
	files, hashes := e.runtimeFiles()
	capabilities := []string{}
	if settings.capabilities != "" {
		capabilities = strings.Split(settings.capabilities, ",")
	}
	content, _ := jsJSON(revision.Game)
	if revision.Game == nil {
		content, _ = jsJSON(revision.Scene)
	}
	release := packaged{
		Manifest: manifestOut{Format: 1, ReleaseID: newID(), GameID: p.ID, SourceRevision: revision.ID, Title: p.Title,
			Template: p.Template, SDK: "1.0.0", Protocol: protocolVersion, Client: "player.html", Simulation: settings.simulation,
			Players: playerRange{1, settings.max}, Capabilities: capabilities, Permissions: permissions,
			Assets: revision.Assets, Credits: credits, Files: hashes},
		Game: revision.Game, Scene: revision.Scene, SceneHash: digest(content), Files: files, Assets: map[string]string{},
	}
	delivered := revision.Assets
	if !draft {
		if delivered, err = deliveryAssets(revision.Assets); err != nil {
			return nil, err
		}
	}
	data, err := jsJSON(release)
	if err != nil {
		return nil, err
	}
	if release.Assets, err = e.projects.withAssetFiles(len(data), delivered); err != nil {
		return nil, err
	}
	if len(release.Assets) > 0 { // without assets the release is already encoded
		if data, err = jsJSON(release); err != nil {
			return nil, err
		}
	}
	parsed, err := ParseRelease(data)
	if err != nil {
		return nil, err
	}
	if publish {
		path, err := e.releases.path(parsed.Manifest.ReleaseID)
		if err != nil {
			return nil, err
		}
		if err := atomicWrite(path, parsed.canonical); err != nil {
			return nil, err
		}
	}
	return parsed, nil
}

// List returns every stored release manifest.
func (e *Editor) ListReleases() ([]json.RawMessage, error) {
	entries, err := os.ReadDir(e.releases.dir)
	if err != nil {
		return nil, err
	}
	list := []json.RawMessage{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		release, err := e.releases.Read(strings.TrimSuffix(entry.Name(), ".json"))
		if err != nil {
			return nil, err
		}
		list = append(list, release.ManifestRaw)
	}
	return list, nil
}

func (e *Editor) Remix(releaseID string) (*Project, error) {
	release, err := e.releases.Read(releaseID)
	if err != nil {
		return nil, err
	}
	if !release.Manifest.Permissions.Remix {
		return nil, fail(http.StatusForbidden, "The creator has disabled remixing.")
	}
	assets, err := deliveryAssets(release.Manifest.Assets)
	if err != nil {
		return nil, err
	}
	e.projects.mu.Lock()
	defer e.projects.mu.Unlock()
	for _, asset := range assets {
		data, err := decodeAsset(asset, release.Assets[asset.Hash])
		if err != nil {
			return nil, err
		}
		if err := e.projects.writeAsset(asset.Hash, data); err != nil {
			return nil, err
		}
	}
	return e.projects.createRevision(truncateUTF16(release.Manifest.Title+" remix", 80), initialRevision{
		label: "Remixed release", template: release.Manifest.Template, game: release.Game, scene: release.Scene,
		assets: release.Manifest.Assets, upstream: releaseID})
}

// ImportData imports a release sent to the editor API.
func (r *Releases) ImportData(data []byte) (*Release, error) {
	release, err := ParseRelease(data)
	if err != nil {
		return nil, err
	}
	if err := Verify(release, r.runtime); err != nil {
		return nil, err
	}
	return r.store(release)
}
