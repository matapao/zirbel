package main

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Every save a commit, mirroring the Projects class in packages/core/projects.ts:
// a proposal is a commit on refs/zirbel/proposals/<id>, its parent its base;
// applying moves the branch to it and deletes its ref in one compare-and-swap
// transaction; a restore commits the earlier revision's tree on the head.
// docs/git-store.md lists every way a revision is made.

func proposalRef(id string) string { return "refs/zirbel/proposals/" + id }

// write writes content as a commit on a ref, its parent base, keeping what the
// host doesn't manage of base's tree: the commit.
func (s *Projects) write(repo, ref, base string, next Content, label string, author ident) (string, error) {
	stream := newFastImport()
	var entries []treeEntry
	if base != "" {
		listed, err := listTree(repo, base, nil)
		if err != nil {
			return "", err
		}
		entries = listed
	}
	changes, hashes, err := treeChanges(entries, func(oid string) string { return s.history.sha256(repo, oid) }, next, s.readAsset, stream)
	if err != nil {
		return "", err
	}
	mark := stream.commit(ref, commitSpec{author: author, time: seconds(), message: commitMessage(label), from: base}, changes)
	ids, err := stream.run(repo)
	if err != nil {
		return "", err
	}
	return ids[mark], s.history.learn(repo, hashes)
}

// Submit stages a proposal. check, when given, sees the project and the parsed
// request under the store lock before anything is staged.
func (s *Projects) Submit(projectID string, data []byte, author ident, check func(*Project, *Proposal) error) (*proposalResult, error) {
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
	return s.submit(p, request, author)
}

// submit stages a parsed proposal on a project the caller has just read.
func (s *Projects) submit(p *Project, request *Proposal, author ident) (*proposalResult, error) {
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
	applied, err := applyOperations(base, request.Operations)
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
	repo := s.repository(p.ID)
	commit, err := s.write(repo, proposalRef(proposal.ID), base.ID, *applied, request.Label, author)
	if err != nil {
		return nil, err
	}
	if err := atomicWrite(path, data); err != nil {
		return nil, err
	}
	preview, err := s.history.content(repo, commit)
	if err != nil {
		return nil, err
	}
	return &proposalResult{&proposal, &preview}, nil
}

// saveProposal writes a proposal's file, as a migration rebases it.
func (s *Projects) saveProposal(proposal *Proposal) error {
	path, err := s.proposalPath(proposal.ProjectID, proposal.ID)
	if err != nil {
		return err
	}
	data, _ := jsJSON(proposal)
	if err := checkContract("saved-proposal", data); err != nil {
		return err
	}
	return atomicWrite(path, data)
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
	// What savedProposal.parse makes of a game: its defaults, its page trimmed.
	for _, operation := range saved.Operations {
		if err := normalizeGame(operation.Game); err != nil {
			return nil, err
		}
	}
	return &saved, nil
}

// proposalFiles are the ids of the proposals staged on a project, by their files.
func (s *Projects) proposalFiles(projectID string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "proposals"))
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, entry := range entries {
		if name := entry.Name(); strings.HasPrefix(name, projectID+".") && strings.HasSuffix(name, ".json") {
			ids = append(ids, strings.TrimSuffix(strings.TrimPrefix(name, projectID+"."), ".json"))
		}
	}
	return ids, nil
}

// proposals lists what is staged on a branch head of p, oldest first.
func (s *Projects) proposals(p *Project, branch string) ([]*Proposal, error) {
	base, err := head(p, branch)
	if err != nil {
		return nil, err
	}
	ids, err := s.proposalFiles(p.ID)
	if err != nil {
		return nil, err
	}
	list := []*Proposal{}
	for _, id := range ids {
		proposal, err := s.getProposal(p.ID, id)
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

// proposalCommit is a staged proposal's commit.
func (s *Projects) proposalCommit(projectID, proposalID string) (string, error) {
	commit, err := resolve(s.repository(projectID), proposalRef(proposalID))
	if err == nil && commit == "" {
		return "", fail(http.StatusNotFound, "The requested item does not exist.")
	}
	return commit, err
}

// preview is a proposal staged on its branch's head, and its commit read back.
func (s *Projects) preview(projectID, proposalID string) (*proposalResult, error) {
	proposal, err := s.getProposal(projectID, proposalID)
	if err != nil {
		return nil, err
	}
	p, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	if _, err := assertCurrent(p, proposal.Branch, proposal.BaseRevision); err != nil {
		return nil, err
	}
	commit, err := s.proposalCommit(projectID, proposalID)
	if err != nil {
		return nil, err
	}
	content, err := s.history.content(s.repository(projectID), commit)
	if err != nil {
		return nil, err
	}
	return &proposalResult{proposal, &content}, nil
}
func (s *Projects) Preview(projectID, proposalID string) (*proposalResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.preview(projectID, proposalID)
}
func (s *Projects) Discard(projectID, proposalID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.getProposal(projectID, proposalID); err != nil {
		return err
	}
	path, _ := s.proposalPath(projectID, proposalID)
	if err := os.Remove(path); err != nil { // #nosec G703 -- proposalPath validates both IDs
		return err
	}
	_, err := updateRefs(s.repository(projectID), []refUpdate{{ref: proposalRef(proposalID)}})
	return err
}

// Commit applies a staged proposal: its branch (or a new fork) moves to the
// proposal's commit, from its base (a fork from none), and its ref goes, in one step.
func (s *Projects) Commit(projectID, proposalID, fork string) (*commitResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if fork != "" {
		if err := safeID(fork); err != nil {
			return nil, err
		}
	}
	staged, err := s.preview(projectID, proposalID)
	if err != nil {
		return nil, err
	}
	current, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	if _, exists := current.Branches[fork]; fork != "" && exists {
		return nil, fail(http.StatusConflict, "A branch with that name already exists.")
	}
	proposal := staged.Proposal
	branch, from := proposal.Branch, proposal.BaseRevision
	if fork != "" {
		branch, from = fork, zeroCommit
	}
	commit, err := s.proposalCommit(projectID, proposalID)
	if err != nil {
		return nil, err
	}
	moved, err := updateRefs(s.repository(projectID), []refUpdate{{ref: "refs/heads/" + branch, to: commit, from: from},
		{ref: proposalRef(proposalID), from: commit}})
	if err != nil {
		return nil, err
	}
	if !moved {
		return nil, errBranchChanged
	}
	path, _ := s.proposalPath(projectID, proposalID)
	_ = os.Remove(path) // #nosec G703 -- proposalPath validates both IDs
	revision, err := s.revision(projectID, commit)
	if err != nil {
		return nil, err
	}
	return &commitResult{revision, branch}, nil
}

// advance moves a branch from base to a commit, or answers that it has moved on.
func (s *Projects) advance(projectID, branch, base, commit string) error {
	moved, err := updateRefs(s.repository(projectID), []refUpdate{{ref: "refs/heads/" + branch, to: commit, from: base}})
	if err == nil && !moved {
		return errBranchChanged
	}
	return err
}

// Restore commits an earlier revision's tree exactly on the branch's head, with
// the trailer that names it.
func (s *Projects) Restore(projectID, branch, baseRevision, target string, author ident) (*Project, error) {
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
	earlier, err := s.revision(projectID, target)
	if err != nil {
		return nil, err
	}
	repo := s.repository(projectID)
	_, problems, err := s.history.read(repo, earlier.ID)
	if err != nil {
		return nil, err
	}
	if len(problems) > 0 {
		return nil, fail(http.StatusUnprocessableEntity, "That revision can’t be restored: "+problems[0])
	}
	message := commitMessage(sliceUTF16("Restore "+earlier.Label, 120), [2]string{"Zirbel-Restored-From", earlier.ID})
	restored, err := commitTree(repo, earlier.ID+"^{tree}", []string{baseRevision}, author, seconds(), message)
	if err != nil {
		return nil, err
	}
	if err := s.advance(projectID, branch, baseRevision, restored); err != nil {
		return nil, err
	}
	return s.read(projectID)
}
