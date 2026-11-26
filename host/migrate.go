package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"
)

// Revisions kept in full, as a version-1 project file or a bundle holds them,
// written as commits, mirroring packages/core/migrate.ts: one per revision in
// order, its parent its parent's commit, its date as the commit's. A project
// still kept as a version-1 file becomes a repository at the editor's start,
// its pending proposals commits of their own; the version-2 file written last
// is the migration's commit point, so a start that finds a version-1 file
// again does it all again, to the same commits.

const importingRef = "refs/zirbel/import"

func secondsOf(date string) int64 {
	at, _ := time.Parse(time.RFC3339Nano, date)
	return at.Unix()
}

func noHash(string) string { return "" }

// writeRevisions writes revisions as commits: each old id's commit, and the
// SHA-256s of the blobs written. author: who made them all (or else each
// revision's own author, then Zirbel); trailer: whether each names its old
// id. A restore's target must be written before its trailer can name it, so
// the revisions go in runs that end before a restore of one in the same run.
func writeRevisions(repo string, revisions []Revision, read func(string) ([]byte, error), author *ident, trailer bool) (map[string]string, [][2]string, error) {
	commits, hashes := map[string]string{}, [][2]string{}
	for index := 0; index < len(revisions); {
		stream := newFastImport()
		marks := map[string]string{}
		for ; index < len(revisions); index++ {
			revision := revisions[index]
			restored := revision.RestoredFrom
			if restored != "" && commits[restored] == "" && marks[restored] != "" {
				break
			}
			from := ""
			if revision.Parent != nil {
				from = firstOf(marks[*revision.Parent], commits[*revision.Parent])
			}
			if from == "" {
				stream.reset(importingRef)
			}
			changes, written, err := treeChanges(nil, noHash, revision.content(), read, stream)
			if err != nil {
				return nil, nil, err
			}
			hashes = append(hashes, written...)
			trailers := [][2]string{}
			if commits[restored] != "" {
				trailers = append(trailers, [2]string{"Zirbel-Restored-From", commits[restored]})
			}
			if trailer {
				trailers = append(trailers, [2]string{"Zirbel-Revision", revision.ID})
			}
			by := committer
			if author != nil {
				by = *author
			} else if revision.Author != "" {
				by = newIdent(revision.Author, committer.email)
			}
			marks[revision.ID] = stream.commit(importingRef, commitSpec{author: by, time: secondsOf(revision.Date),
				message: commitMessage(revision.Label, trailers...), from: from}, append([]treeChange{{op: "deleteall"}}, changes...))
		}
		ids, err := stream.run(repo)
		if err != nil {
			return nil, nil, err
		}
		for old, mark := range marks {
			commits[old] = ids[mark]
		}
	}
	_, err := updateRefs(repo, []refUpdate{{ref: importingRef}})
	return commits, hashes, err
}

// branchUpdates set each branch to its revision's commit.
func branchUpdates(branches map[string]string, commits map[string]string) ([]refUpdate, error) {
	updates := []refUpdate{}
	for _, branch := range sortedKeys(branches) {
		commit := commits[branches[branch]]
		if commit == "" {
			return nil, errors.New("the branch " + branch + " names a revision the history doesn't have")
		}
		updates = append(updates, refUpdate{ref: "refs/heads/" + branch, to: commit})
	}
	return updates, nil
}

// Migrate makes every project still kept as a version-1 file a repository:
// how many it migrated.
func (s *Projects) Migrate() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids, err := s.ids()
	if err != nil {
		return 0, err
	}
	migrated := 0
	for _, id := range ids {
		path, err := s.path(id)
		if err != nil {
			continue
		}
		data, err := readFile(path)
		if err != nil {
			return migrated, err
		}
		if version, ok := fileVersion(data).(float64); !ok || version != 1 {
			continue
		}
		var old Project
		if err := decodeContract("project", data, &old); err != nil {
			return migrated, err
		}
		if err := normalizeProject(&old); err != nil {
			return migrated, err
		}
		if err := s.migrateProject(&old, path); err != nil {
			return migrated, err
		}
		migrated++
	}
	return migrated, nil
}

func copyFile(from, to string) error {
	source, err := os.Open(from) // #nosec G304 -- a project file of the data directory
	if err != nil {
		return err
	}
	defer func() { _ = source.Close() }()
	target, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600) // #nosec G304 -- beside it, in migrated-projects
	if err != nil {
		return err
	}
	_, err = io.Copy(target, source)
	return errors.Join(err, target.Close())
}

// migrateProject makes a version-1 project a repository and a version-2 file,
// keeping the old file in migrated-projects/.
func (s *Projects) migrateProject(old *Project, path string) error {
	aside := filepath.Join(s.root, "migrated-projects")
	if err := os.MkdirAll(aside, 0o700); err != nil {
		return err
	}
	if kept := filepath.Join(aside, old.ID+".json"); !exists(kept) {
		if err := copyFile(path, kept); err != nil {
			return err
		}
	}
	repo := s.repository(old.ID)
	making := repo + ".migrating"
	if err := initRepository(making); err != nil {
		return err
	}
	commits, hashes, err := writeRevisions(making, old.Revisions, s.readAsset, &committer, true)
	if err != nil {
		return err
	}
	updates, err := branchUpdates(old.Branches, commits)
	if err != nil {
		return err
	}
	if _, err := updateRefs(making, updates); err != nil {
		return err
	}
	rebased, written, err := s.migrateProposals(making, old, commits)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(repo); err != nil {
		return err
	}
	if err := os.Rename(making, repo); err != nil {
		return err
	}
	if err := s.history.learn(repo, append(hashes, written...)); err != nil {
		return err
	}
	for _, proposal := range rebased {
		if err := s.saveProposal(proposal); err != nil {
			return err
		}
	}
	notes := append([]Note{}, old.Notes...)
	for i := range notes {
		notes[i].References = append([]Reference{}, notes[i].References...)
		for j := range notes[i].References {
			if commit := commits[notes[i].References[j].Revision]; commit != "" {
				notes[i].References[j].Revision = commit
			}
		}
	}
	return s.save(&storedProject{Version: 2, ID: old.ID, Title: old.Title, Template: old.Template, Notes: notes,
		Attachments: old.Attachments, Upstream: old.Upstream, Imported: old.Imported})
}

// migrateProposals writes each pending proposal of a project as a commit on
// its own ref, its base the new commit (also when a migration ran before):
// the proposals rebased, and the SHA-256s of the blobs written.
func (s *Projects) migrateProposals(repo string, old *Project, commits map[string]string) ([]*Proposal, [][2]string, error) {
	mapped := map[string]string{}
	for oldID, commit := range commits {
		mapped[commit] = oldID
	}
	ids, err := s.proposalFiles(old.ID)
	if err != nil {
		return nil, nil, err
	}
	stream := newFastImport()
	rebased, hashes := []*Proposal{}, [][2]string{}
	for _, id := range ids {
		proposal, err := s.getProposal(old.ID, id)
		if err != nil {
			continue
		}
		baseID := firstOf(mapped[proposal.BaseRevision], proposal.BaseRevision)
		base, commit := old.revision(baseID), commits[baseID]
		if base == nil || commit == "" {
			continue
		}
		applied, err := applyOperations(base, proposal.Operations)
		if err != nil {
			continue
		}
		changes, written, err := treeChanges(nil, noHash, *applied, s.readAsset, stream)
		if err != nil {
			return nil, nil, err
		}
		hashes = append(hashes, written...)
		stream.commit(proposalRef(proposal.ID), commitSpec{author: committer, time: secondsOf(proposal.Date),
			message: commitMessage(proposal.Label), from: commit}, append([]treeChange{{op: "deleteall"}}, changes...))
		next := *proposal
		next.BaseRevision = commit
		rebased = append(rebased, &next)
	}
	if len(rebased) > 0 {
		if _, err := stream.run(repo); err != nil {
			return nil, nil, err
		}
	}
	return rebased, hashes, nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
