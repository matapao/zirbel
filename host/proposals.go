package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// applyOperations mirrors applyOperations in packages/core/projects.ts.
func applyOperations(base *Revision, operations []Operation) (*Preview, error) {
	game := base.Game
	var background string
	objects := []SceneObject{}
	if base.Scene != nil {
		background = base.Scene.Background
		objects = append(objects, base.Scene.Objects...)
	}
	find := func(id string) int {
		return slices.IndexFunc(objects, func(object SceneObject) bool { return object.ID == id })
	}
	assets := append([]Asset{}, base.Assets...)
	findAsset := func(id string) int {
		return slices.IndexFunc(assets, func(asset Asset) bool { return asset.ID == id })
	}
	for _, operation := range operations {
		switch operation.Op {
		case "writeGame":
			if game != nil && game.Files != nil {
				return nil, fail(http.StatusUnprocessableEntity, "This game was imported as a built folder. Import a new build to change it.")
			}
			game = operation.Game
		case "background":
			background = operation.Color
		case "add":
			if find(operation.Object.ID) >= 0 {
				return nil, fail(http.StatusConflict, "An object already uses that ID.")
			}
			objects = append(objects, *operation.Object)
		case "update":
			index := find(operation.ID)
			if index < 0 {
				return nil, fail(http.StatusConflict, "The target object is missing.")
			}
			merged, err := mergeChanges(objects[index], operation.Changes)
			if err != nil {
				return nil, err
			}
			objects[index] = merged
		case "remove":
			index := find(operation.ID)
			if index < 0 {
				return nil, fail(http.StatusConflict, "The target object is missing.")
			}
			objects = slices.Delete(objects, index, index+1)
		case "addAsset":
			if findAsset(operation.Asset.ID) >= 0 {
				return nil, fail(http.StatusConflict, "An asset already uses that ID.")
			}
			assets = append(assets, *operation.Asset)
		case "removeAsset":
			index := findAsset(operation.ID)
			if index < 0 {
				return nil, fail(http.StatusConflict, "The target asset is missing.")
			}
			assets = slices.Delete(assets, index, index+1)
		}
	}
	if len(assets) > 80 {
		return nil, fail(http.StatusBadRequest, "A project can reference up to 80 assets.")
	}
	preview := &Preview{Game: game, Assets: assets}
	if base.Scene != nil {
		scene := &Scene{ID: base.Scene.ID, Background: background, Objects: objects}
		// scene.parse(...) in Node: the result must still be a valid scene.
		data, _ := jsJSON(scene)
		if err := checkContract("scene", data); err != nil {
			return nil, err
		}
		if err := normalizeScene(scene); err != nil {
			return nil, err
		}
		preview.Scene = scene
	}
	return preview, nil
}

// trimmedName applies Zod's trim and length check to the name in an update's changes.
func trimmedName(raw json.RawMessage) (json.RawMessage, error) {
	var name string
	_ = json.Unmarshal(raw, &name)
	name, err := trimmed("changes.name", name, 80)
	if err != nil {
		return nil, err
	}
	return jsJSON(name)
}

// mergeChanges is { ...object, ...changes }.
func mergeChanges(object SceneObject, changes map[string]json.RawMessage) (SceneObject, error) {
	data, err := json.Marshal(object)
	if err != nil {
		return object, err
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &fields); err != nil {
		return object, err
	}
	for key, value := range changes {
		if key == "name" {
			if value, err = trimmedName(value); err != nil {
				return object, err
			}
		}
		fields[key] = value
	}
	data, _ = json.Marshal(fields)
	var merged SceneObject
	if err := json.Unmarshal(data, &merged); err != nil {
		return object, fail(http.StatusBadRequest, "changes · Invalid input")
	}
	return merged, nil
}
func parseProposal(data []byte) (*Proposal, error) {
	var request Proposal
	if err := decodeContract("proposal", data, &request); err != nil {
		return nil, err
	}
	label, err := trimmed("label", request.Label, 120)
	if err != nil {
		return nil, err
	}
	request.Label = label
	for i, operation := range request.Operations {
		if operation.Op == "update" && len(operation.Changes) == 0 {
			return nil, fail(http.StatusBadRequest, "operations."+strconv.Itoa(i)+".changes · Provide at least one property.")
		}
		if operation.Asset != nil {
			normalizeSource(operation.Asset)
		}
		if operation.Object != nil {
			name, err := trimmed("object.name", operation.Object.Name, 80)
			if err != nil {
				return nil, err
			}
			operation.Object.Name = name
		}
		if err := normalizeGame(operation.Game); err != nil {
			return nil, err
		}
		// Zod trims a renamed object's name in the stored proposal too.
		if raw, ok := operation.Changes["name"]; ok {
			name, err := trimmedName(raw)
			if err != nil {
				return nil, err
			}
			operation.Changes["name"] = name
		}
	}
	return &request, nil
}

// Submit stages a proposal. check, when given, sees the project and the parsed
// request under the store lock before anything is staged.
func (s *Projects) Submit(projectID string, data []byte, check func(*Project, *Proposal) error) (*proposalResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	request, err := parseProposal(data)
	if err != nil {
		return nil, err
	}
	p, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	if check != nil {
		if err := check(p, request); err != nil {
			return nil, err
		}
	}
	return s.submit(p, request)
}

// submit stages a parsed proposal on a project the caller has just read.
func (s *Projects) submit(p *Project, request *Proposal) (*proposalResult, error) {
	base, err := assertCurrent(p, request.Branch, request.BaseRevision)
	if err != nil {
		return nil, err
	}
	if p.Template == "" {
		for _, operation := range request.Operations {
			if operation.Op != "writeGame" && operation.Op != "addAsset" && operation.Op != "removeAsset" {
				return nil, fail(http.StatusUnprocessableEntity, "Edit the game source to change its objects or behavior.")
			}
		}
	}
	// Bounds what a proposal-only MCP grant can stage; it cannot move the head to reset this.
	pending, err := s.proposals(p, request.Branch)
	if err != nil {
		return nil, err
	}
	if len(pending) >= 50 {
		return nil, fail(http.StatusTooManyRequests, "Apply or discard pending proposals before staging more.")
	}
	preview, err := applyOperations(base, request.Operations)
	if err != nil {
		return nil, err
	}
	proposal := *request
	proposal.ID, proposal.ProjectID, proposal.Date = newID(), p.ID, now()
	path, err := s.proposalPath(p.ID, proposal.ID)
	if err != nil {
		return nil, err
	}
	data, _ := jsJSON(proposal)
	// Never stage a proposal that reading it back would refuse.
	if err := checkContract("saved-proposal", data); err != nil {
		return nil, err
	}
	if err := atomicWrite(path, data); err != nil {
		return nil, err
	}
	return &proposalResult{&proposal, preview}, nil
}
func (s *Projects) getProposal(projectID, proposalID string) (*Proposal, error) {
	path, err := s.proposalPath(projectID, proposalID)
	if err != nil {
		return nil, err
	}
	data, err := readFile(path)
	if err != nil {
		return nil, err
	}
	var saved Proposal
	if err := decodeContract("saved-proposal", data, &saved); err != nil {
		return nil, err
	}
	if saved.ProjectID != projectID || saved.ID != proposalID {
		return nil, fail(http.StatusUnprocessableEntity, "The stored proposal does not match its project and filename.")
	}
	return &saved, nil
}

// proposals lists what is staged on a branch head of p, oldest first.
func (s *Projects) proposals(p *Project, branch string) ([]*Proposal, error) {
	base, err := head(p, branch)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Join(s.root, "proposals"))
	if err != nil {
		return nil, err
	}
	list := []*Proposal{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, p.ID+".") || !strings.HasSuffix(name, ".json") {
			continue
		}
		proposal, err := s.getProposal(p.ID, strings.TrimSuffix(strings.TrimPrefix(name, p.ID+"."), ".json"))
		if err != nil {
			return nil, err
		}
		if proposal.Branch == branch && proposal.BaseRevision == base.ID {
			list = append(list, proposal)
		}
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Date != list[j].Date {
			return list[i].Date < list[j].Date
		}
		return list[i].Label < list[j].Label
	})
	return list, nil
}
func (s *Projects) Proposals(projectID, branch string) ([]*Proposal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	return s.proposals(p, branch)
}

// previewOn applies a staged proposal to the project it was staged against.
func previewOn(p *Project, proposal *Proposal) (*Preview, error) {
	base, err := assertCurrent(p, proposal.Branch, proposal.BaseRevision)
	if err != nil {
		return nil, err
	}
	return applyOperations(base, proposal.Operations)
}

// staged reads a proposal, then its project, and previews the one on the other.
func (s *Projects) staged(projectID, proposalID string) (*Project, *proposalResult, error) {
	proposal, err := s.getProposal(projectID, proposalID)
	if err != nil {
		return nil, nil, err
	}
	p, err := s.read(projectID)
	if err != nil {
		return nil, nil, err
	}
	preview, err := previewOn(p, proposal)
	if err != nil {
		return nil, nil, err
	}
	return p, &proposalResult{proposal, preview}, nil
}
func (s *Projects) Preview(projectID, proposalID string) (*proposalResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, staged, err := s.staged(projectID, proposalID)
	return staged, err
}
func (s *Projects) Discard(projectID, proposalID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.getProposal(projectID, proposalID); err != nil {
		return err
	}
	path, _ := s.proposalPath(projectID, proposalID)
	return os.Remove(path)
}

// Commit applies a staged proposal as one revision, on its branch or on a new fork.
func (s *Projects) Commit(projectID, proposalID, fork string) (*commitResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if fork != "" {
		if err := safeID(fork); err != nil {
			return nil, err
		}
	}
	p, staged, err := s.staged(projectID, proposalID)
	if err != nil {
		return nil, err
	}
	if _, exists := p.Branches[fork]; fork != "" && exists {
		return nil, fail(http.StatusConflict, "A branch with that name already exists.")
	}
	proposal, preview := staged.Proposal, staged.Preview
	branch := proposal.Branch
	if fork != "" {
		branch = fork
	}
	parent := proposal.BaseRevision
	next := Revision{ID: newID(), Parent: &parent, Label: proposal.Label, Date: now(), Scene: preview.Scene, Game: preview.Game, Assets: preview.Assets}
	p.Branches[branch] = next.ID
	p.Revisions = append(p.Revisions, next)
	if _, err := s.save(p); err != nil {
		return nil, err
	}
	// Once the transaction commits the proposal is stale on that branch.
	path, _ := s.proposalPath(projectID, proposalID)
	_ = os.Remove(path) // #nosec G703 -- proposalPath validates both IDs
	return &commitResult{&next, branch}, nil
}
func (s *Projects) Restore(projectID, branch, baseRevision, target string) (*Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	if err := safeID(branch); err != nil {
		return nil, err
	}
	if _, err := assertCurrent(p, branch, baseRevision); err != nil {
		return nil, err
	}
	earlier := p.revision(target)
	if earlier == nil {
		return nil, fail(http.StatusNotFound, "Revision does not exist.")
	}
	parent := baseRevision
	revision := *earlier
	revision.ID, revision.Date, revision.Parent, revision.RestoredFrom, revision.Label =
		newID(), now(), &parent, earlier.ID, truncateUTF16("Restore "+earlier.Label, 120)
	p.Branches[branch] = revision.ID
	p.Revisions = append(p.Revisions, revision)
	return s.save(p)
}

// truncateUTF16 is JavaScript's slice(0, n), cutting before a character that
// would cross the limit.
func truncateUTF16(text string, n int) string {
	length := 0
	for i, r := range text {
		if length += utf16.RuneLen(r); length > n {
			return text[:i]
		}
	}
	return text
}
