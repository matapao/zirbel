package main

import (
	"net/http"
	"os"
	"time"
)

// A project's repository as the store makes it and reads it, mirroring the
// Projects class in packages/core/projects.ts: a new project's repository is
// written aside and moved in whole, its metadata last; a revision in full is
// a commit one of its branches reaches.

type initialRevision struct {
	scene    *Scene
	game     *Game
	assets   []Asset
	template string
	upstream string
	label    string
}

// seconds is now as a commit's date.
func seconds() int64 { return time.Now().Unix() }

func (s *Projects) createRevision(title string, initial initialRevision, author ident) (*Project, error) {
	name, err := trimmed("title", title, 80)
	if err != nil {
		return nil, err
	}
	first := Content{Scene: initial.scene, Game: initial.game, Assets: initial.assets}
	if first.Assets == nil {
		first.Assets = []Asset{}
	}
	return s.createRepository(func(repo string) ([][2]string, error) {
		stream := newFastImport()
		changes, hashes, err := treeChanges(nil, func(string) string { return "" }, first, s.readAsset, stream)
		if err != nil {
			return nil, err
		}
		stream.commit("refs/heads/main", commitSpec{author: author, time: seconds(), message: commitMessage(initial.label)}, changes)
		_, err = stream.run(repo)
		return hashes, err
	}, projectMeta{title: name, template: initial.template, upstream: initial.upstream}, newID())
}

// createRepository makes a new project whose repository fill writes, made
// aside and moved in whole; its metadata last.
func (s *Projects) createRepository(fill func(repo string) ([][2]string, error), meta projectMeta, id string) (*Project, error) {
	making := s.repository(id) + "." + newID() + ".making"
	defer func() { _ = os.RemoveAll(making) }()
	if err := initRepository(making); err != nil {
		return nil, err
	}
	hashes, err := fill(making)
	if err != nil {
		return nil, err
	}
	return s.adopt(making, hashes, meta, id)
}

// adopt makes a repository written aside a new project's: hashes, the SHA-256s
// of blobs it was written with.
func (s *Projects) adopt(making string, hashes [][2]string, meta projectMeta, id string) (*Project, error) {
	repo := s.repository(id)
	if err := os.RemoveAll(repo); err != nil {
		return nil, err
	}
	if err := os.Rename(making, repo); err != nil {
		return nil, err
	}
	if err := s.history.learn(repo, hashes); err != nil {
		return nil, err
	}
	if err := s.save(&storedProject{Version: 2, ID: id, Title: meta.title, Template: meta.template, Notes: []Note{},
		Attachments: []Attachment{}, Upstream: meta.upstream, Imported: meta.imported, Source: meta.source}); err != nil {
		return nil, err
	}
	return s.read(id)
}

func (s *Projects) CreateGame(title string, game *Game, author ident) (*Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	label := "Created project"
	if game != nil {
		label = "Created with harness"
	}
	return s.createRevision(title, initialRevision{game: game, label: label}, author)
}
func (s *Projects) Rename(id, title string) (*Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.update(id, func(p *storedProject) error {
		name, err := trimmed("title", title, 80)
		p.Title = name
		return err
	}); err != nil {
		return nil, err
	}
	return s.read(id)
}

// revision is a revision of the project's history, in full: a commit
// reachable from one of its branches.
func (s *Projects) revision(projectID, revisionID string) (*Revision, error) {
	if _, err := s.stored(projectID); err != nil {
		return nil, err
	}
	repo := s.repository(projectID)
	commit := ""
	if commitPattern.MatchString(revisionID) {
		found, err := resolve(repo, revisionID)
		if err != nil {
			return nil, err
		}
		commit = found
	}
	reachable := false
	if commit != "" && commit == revisionID {
		out, err := runGit(repo, []string{"for-each-ref", "--count=1", "--contains", commit, "refs/heads/"}, gitOptions{})
		if err != nil {
			return nil, err
		}
		reachable = len(out.stdout) > 0
	}
	if !reachable {
		return nil, fail(http.StatusNotFound, "Revision does not exist.")
	}
	meta, err := s.history.meta(repo, commit)
	if err != nil {
		return nil, err
	}
	content, err := s.history.content(repo, commit)
	if err != nil {
		return nil, err
	}
	meta.Scene, meta.Game, meta.Assets = content.Scene, content.Game, content.Assets
	return &meta, nil
}

// Revision is GET /api/projects/<id>/revisions/<revision>.
func (s *Projects) Revision(projectID, revisionID string) (*Revision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.revision(projectID, revisionID)
}

// knownAssets is every asset the listed history holds: what an MCP grant may add again.
func (s *Projects) knownAssets(projectID string) ([]Asset, error) {
	repo := s.repository(projectID)
	branches, err := readBranches(repo)
	if err != nil {
		return nil, err
	}
	listed, err := s.history.revisions(repo, branches)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(listed))
	for _, revision := range listed {
		names = append(names, revision.ID+":"+assetsJSON)
	}
	files, err := readObjects(repo, names, nil)
	if err != nil {
		return nil, err
	}
	known := []Asset{}
	for _, data := range files {
		var list []Asset
		if parsedJSON(data, "asset-list", &list) {
			for i := range list {
				normalizeSource(&list[i])
			}
			known = append(known, list...)
		}
	}
	return known, nil
}
