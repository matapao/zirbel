package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"zirbel/contracts"
)

// The project store, mirroring packages/core/projects.ts. A project is its
// metadata (projects/<id>.json: title, notes, attachments, where it came from)
// and a bare git repository (git/<id>.git) whose commits are its revisions and
// whose branches are its branches. Every save is a commit: a proposal is one on
// refs/zirbel/proposals/<id> until it is applied (proposals.go), and applying
// moves the branch to it, compare-and-swap. The git store in AGENTS.md is the design.

// validContract decodes JSON and validates it against a contract.
func validContract(name string, data []byte) (any, error) {
	value, err := contracts.Decode(data)
	if err != nil {
		return nil, fail(http.StatusBadRequest, "Invalid JSON.")
	}
	if err := contracts.Validate(name, value); err != nil {
		return nil, fail(http.StatusBadRequest, err.Error())
	}
	return value, nil
}

// checkContract validates JSON against a contract.
func checkContract(name string, data []byte) error {
	_, err := validContract(name, data)
	return err
}

// decodeContract validates JSON against a contract and fills out from the
// value it validated, so duplicate keys and numbers read as in Node.
func decodeContract(name string, data []byte, out any) error {
	value, err := validContract(name, data)
	if err != nil {
		return err
	}
	if err := contracts.Unmarshal(value, out); err != nil {
		return fail(http.StatusBadRequest, "Invalid "+name+".")
	}
	return nil
}
func safeID(id string) error {
	if !idPattern.MatchString(id) {
		return fail(http.StatusBadRequest, "Invalid ID.")
	}
	return nil
}

// revision finds a revision of the project's history by ID.
func (p *Project) revision(id string) *Revision {
	for i := range p.Revisions {
		if p.Revisions[i].ID == id {
			return &p.Revisions[i]
		}
	}
	return nil
}

// head is a branch's head, which a project lists with its content.
func head(p *Project, branch string) (*Revision, error) {
	if id, ok := p.Branches[branch]; ok {
		if revision := p.revision(id); revision != nil && revision.Assets != nil {
			return revision, nil
		}
	}
	return nil, fail(http.StatusNotFound, "Branch does not exist.")
}
func assertCurrent(p *Project, branch, base string) (*Revision, error) {
	current, err := head(p, branch)
	if err != nil {
		return nil, err
	}
	if current.ID != base {
		return nil, errBranchChanged
	}
	return current, nil
}

var errBranchChanged = fail(http.StatusConflict, "The branch has changed. Request a new proposal against its current revision.")

// storedProject is projects/<id>.json: what of a project isn't its game's
// content. Its branches and revisions are its repository's.
type storedProject struct {
	Version     int          `json:"version"`
	ID          string       `json:"id"`
	Title       string       `json:"title"`
	Template    string       `json:"template,omitempty"`
	Notes       []Note       `json:"notes"`
	Attachments []Attachment `json:"attachments"`
	Upstream    string       `json:"upstream,omitempty"`
	Imported    bool         `json:"imported,omitempty"`
	Source      *gitSource   `json:"source,omitempty"`
}

// projectMeta is what a new project's file starts with besides its id.
type projectMeta struct {
	title, template, upstream string
	imported                  bool
	source                    *gitSource
}

// Projects is the project store in <data>/projects, git, proposals, assets and media.
type Projects struct {
	root    string
	mu      sync.Mutex // Node runs each operation without yielding; serialize them here
	history *History
}

func NewProjects(root string) (*Projects, error) {
	for _, name := range []string{"projects", "proposals", "assets", "media", "releases", "grants", "git"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0o700); err != nil {
			return nil, err
		}
	}
	s := &Projects{root: root}
	s.history = newHistory(s)
	return s, nil
}
func (s *Projects) path(id string) (string, error) {
	if err := safeID(id); err != nil {
		return "", err
	}
	return filepath.Join(s.root, "projects", id+".json"), nil
}
func (s *Projects) proposalPath(projectID, proposalID string) (string, error) {
	if err := safeID(projectID); err != nil {
		return "", err
	}
	if err := safeID(proposalID); err != nil {
		return "", err
	}
	return filepath.Join(s.root, "proposals", projectID+"."+proposalID+".json"), nil
}

// repository is a project's bare repository; id is one the caller checked.
func (s *Projects) repository(id string) string { return filepath.Join(s.root, "git", id+".git") }

func (s *Projects) hasAsset(hash string) bool {
	_, err := os.Stat(filepath.Join(s.root, "assets", hash))
	return hashPattern.MatchString(hash) && err == nil
}

func readFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path) // #nosec G304 G703 -- every caller builds path from the data directory and a validated ID
	if errors.Is(err, os.ErrNotExist) {
		return nil, fail(http.StatusNotFound, "The requested item does not exist.")
	}
	return data, err
}

// ids are the projects the store keeps, by their files.
func (s *Projects) ids() ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "projects"))
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, entry := range entries {
		if id, ok := strings.CutSuffix(entry.Name(), ".json"); ok {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

// fileVersion is the version a project's file says it is.
func fileVersion(data []byte) any {
	var raw struct {
		Version any `json:"version"`
	}
	_ = json.Unmarshal(data, &raw)
	return raw.Version
}

func (s *Projects) stored(id string) (*storedProject, error) {
	path, err := s.path(id)
	if err != nil {
		return nil, err
	}
	data, err := readFile(path)
	if err != nil {
		return nil, err
	}
	if version, ok := fileVersion(data).(float64); ok && version == 1 {
		return nil, fail(http.StatusServiceUnavailable, "This project is still to be migrated. Start the editor again.")
	}
	var saved storedProject
	if err := decodeContract("stored-project", data, &saved); err != nil {
		return nil, err
	}
	if err := normalizeStored(&saved); err != nil {
		return nil, err
	}
	if saved.ID != id {
		return nil, fail(http.StatusUnprocessableEntity, "The stored project ID does not match its filename.")
	}
	return &saved, nil
}

// normalizeStored applies what storedProject.parse does beyond the JSON Schema.
func normalizeStored(p *storedProject) error {
	title, err := trimmed("title", p.Title, 80)
	if err != nil {
		return err
	}
	p.Title = title
	if p.Notes, err = normalizeNotes(p.Notes); err != nil {
		return err
	}
	if p.Attachments == nil {
		p.Attachments = []Attachment{}
	}
	return nil
}

// save writes a project's metadata.
func (s *Projects) save(p *storedProject) error {
	if err := normalizeStored(p); err != nil {
		return err
	}
	data, err := jsJSON(p)
	if err != nil {
		return err
	}
	// storedProject.parse(value) before every write in Node.
	if err := checkContract("stored-project", data); err != nil {
		return err
	}
	path, err := s.path(p.ID)
	if err != nil {
		return err
	}
	return atomicWrite(path, data)
}

// update changes a project's metadata.
func (s *Projects) update(id string, change func(*storedProject) error) error {
	current, err := s.stored(id)
	if err != nil {
		return err
	}
	if err := change(current); err != nil {
		return err
	}
	return s.save(current)
}

// read is a project as the API answers it: its history from its repository,
// the branch heads in full.
func (s *Projects) read(id string) (*Project, error) {
	saved, err := s.stored(id)
	if err != nil {
		return nil, err
	}
	repo := s.repository(id)
	branches, err := readBranches(repo)
	if err != nil {
		return nil, err
	}
	if _, ok := branches["main"]; !ok {
		return nil, fail(http.StatusUnprocessableEntity, "The project’s repository has no main branch.")
	}
	listed, err := s.history.revisions(repo, branches)
	if err != nil {
		return nil, err
	}
	heads := branchHeads(branches)
	revisions := make([]Revision, 0, len(listed))
	for _, meta := range listed {
		if slices.Contains(heads, meta.ID) {
			content, err := s.history.content(repo, meta.ID)
			if err != nil {
				return nil, err
			}
			meta.Scene, meta.Game, meta.Assets = content.Scene, content.Game, content.Assets
		}
		revisions = append(revisions, meta)
	}
	return &Project{Version: 1, ID: saved.ID, Title: saved.Title, Template: saved.Template, Branches: branches,
		Revisions: revisions, Notes: saved.Notes, Attachments: saved.Attachments, Upstream: saved.Upstream,
		Imported: saved.Imported, Source: saved.Source}, nil
}

func (s *Projects) Read(id string) (*Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.read(id)
}
func (s *Projects) Has(id string) bool {
	path, err := s.path(id)
	if err != nil {
		return false
	}
	_, err = os.Stat(path) // #nosec G703 -- path joins the data directory and a checked ID
	return err == nil
}

type ProjectSummary struct {
	ID       string            `json:"id"`
	Title    string            `json:"title"`
	Template string            `json:"template,omitempty"`
	Branches map[string]string `json:"branches"`
}

func (s *Projects) Summaries() ([]ProjectSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids, err := s.ids()
	if err != nil {
		return nil, err
	}
	list := []ProjectSummary{}
	for _, id := range ids {
		p, err := s.stored(id)
		if err != nil {
			return nil, err
		}
		branches, err := readBranches(s.repository(id))
		if err != nil {
			return nil, err
		}
		list = append(list, ProjectSummary{p.ID, p.Title, p.Template, branches})
	}
	return list, nil
}
func (s *Projects) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.stored(id); err != nil {
		return err
	}
	return s.moveAside(id, filepath.Join(s.root, "removed-projects"))
}

// moveAside moves a project's file and repository into another folder.
func (s *Projects) moveAside(id, dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	name := id
	if _, err := os.Stat(filepath.Join(dir, id+".json")); err == nil {
		name = id + "." + newID()
	}
	path, _ := s.path(id)
	if err := os.Rename(path, filepath.Join(dir, name+".json")); err != nil { // #nosec G703 -- path is the data directory's own file for a checked id
		return err
	}
	if _, err := os.Stat(s.repository(id)); err == nil {
		return os.Rename(s.repository(id), filepath.Join(dir, name+".git"))
	}
	return nil
}
