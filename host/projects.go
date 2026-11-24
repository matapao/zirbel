package main

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"zirbel/contracts"
)

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

// revision finds a revision of the project by ID.
func (p *Project) revision(id string) *Revision {
	for i := range p.Revisions {
		if p.Revisions[i].ID == id {
			return &p.Revisions[i]
		}
	}
	return nil
}
func head(p *Project, branch string) (*Revision, error) {
	if id, ok := p.Branches[branch]; ok {
		if revision := p.revision(id); revision != nil {
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
		return nil, fail(http.StatusConflict, "The branch has changed. Request a new proposal against its current revision.")
	}
	return current, nil
}

// Projects is the project store in <data>/projects, proposals, assets and media.
type Projects struct {
	root string
	mu   sync.Mutex // Node runs each operation without yielding; serialize them here
}

func NewProjects(root string) (*Projects, error) {
	for _, name := range []string{"projects", "proposals", "assets", "media", "releases", "grants"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0o700); err != nil {
			return nil, err
		}
	}
	return &Projects{root: root}, nil
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
func readFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path) // #nosec G304 G703 -- every caller builds path from the data directory and a validated ID
	if errors.Is(err, os.ErrNotExist) {
		return nil, fail(http.StatusNotFound, "The requested item does not exist.")
	}
	return data, err
}
func (s *Projects) read(id string) (*Project, error) {
	path, err := s.path(id)
	if err != nil {
		return nil, err
	}
	data, err := readFile(path)
	if err != nil {
		return nil, err
	}
	var p Project
	if err := decodeContract("project", data, &p); err != nil {
		return nil, err
	}
	if err := normalizeProject(&p); err != nil {
		return nil, err
	}
	if p.ID != id {
		return nil, fail(http.StatusUnprocessableEntity, "The stored project ID does not match its filename.")
	}
	return &p, nil
}
func (s *Projects) save(p *Project) (*Project, error) {
	if err := normalizeProject(p); err != nil {
		return nil, err
	}
	data, err := jsJSON(p)
	if err != nil {
		return nil, err
	}
	// project.parse(value) before every write in Node.
	if err := checkContract("project", data); err != nil {
		return nil, err
	}
	path, err := s.path(p.ID)
	if err != nil {
		return nil, err
	}
	return p, atomicWrite(path, data)
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
	_, err = os.Stat(path)
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
	entries, err := os.ReadDir(filepath.Join(s.root, "projects"))
	if err != nil {
		return nil, err
	}
	list := []ProjectSummary{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		p, err := s.read(strings.TrimSuffix(entry.Name(), ".json"))
		if err != nil {
			return nil, err
		}
		list = append(list, ProjectSummary{p.ID, p.Title, p.Template, p.Branches})
	}
	return list, nil
}
func (s *Projects) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.read(id); err != nil {
		return err
	}
	dir := filepath.Join(s.root, "removed-projects")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	target := filepath.Join(dir, id+".json")
	if _, err := os.Stat(target); err == nil {
		target = filepath.Join(dir, id+"."+newID()+".json")
	}
	path, _ := s.path(id)
	return os.Rename(path, target)
}

type initialRevision struct {
	scene    *Scene
	game     *Game
	assets   []Asset
	template string
	upstream string
	label    string
}

func (s *Projects) createRevision(title string, initial initialRevision) (*Project, error) {
	assets := initial.assets
	if assets == nil {
		assets = []Asset{}
	}
	first := Revision{ID: newID(), Label: initial.label, Date: now(), Game: initial.game, Scene: initial.scene, Assets: assets}
	return s.save(&Project{Version: 1, ID: newID(), Title: title, Template: initial.template,
		Branches: map[string]string{"main": first.ID}, Revisions: []Revision{first}, Upstream: initial.upstream})
}
func (s *Projects) CreateGame(title string, game *Game) (*Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	label := "Created project"
	if game != nil {
		label = "Created with harness"
	}
	return s.createRevision(title, initialRevision{game: game, label: label})
}
func (s *Projects) Rename(id, title string) (*Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.read(id)
	if err != nil {
		return nil, err
	}
	p.Title = title
	return s.save(p)
}
