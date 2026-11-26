package main

import (
	"errors"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// A project's history and heads, read from its repository, mirroring
// packages/core/history.ts: the newest commits reachable from its branches as
// revisions' metadata, and each branch head's content. A commit never
// changes, so what it holds is kept by its id; the history is kept while the
// branches stay where they are. The SHA-256 of a game file's blob is kept
// beside the repository (zirbel-sha256), and a game file the host reads is
// kept in the asset store, where releases and MCP read it. Every call is made
// under the store's lock.

const (
	historyLength = 200 // how many of the newest revisions a project's history lists
	contentsKept  = 64
)

var sha256Line = regexp.MustCompile(`^([0-9a-f]{40}) ([0-9a-f]{64})$`)

// assetStore is where the host keeps bytes by their SHA-256: the data folder's assets/.
type assetStore interface {
	hasAsset(hash string) bool
	storeAsset(data []byte) (string, error)
}

type historyLog struct {
	key       string
	revisions []Revision
}

type History struct {
	store    assetStore
	logs     map[string]historyLog
	contents map[string]Content
	order    []string // contents, the one used longest ago first
	hashes   map[string]map[string]string
}

func newHistory(store assetStore) *History {
	return &History{store: store, logs: map[string]historyLog{}, contents: map[string]Content{}, hashes: map[string]map[string]string{}}
}

// logCommits lists commits as git log does from some tips: newest first,
// children before parents; max 0 for every one.
func logCommits(repo string, tips []string, max int) ([]commitInfo, error) {
	if len(tips) == 0 {
		return []commitInfo{}, nil
	}
	args := []string{"log", "--topo-order", "-z", "--format=%H%n%T%n%P%n%an%n%ct%n%B"}
	if max > 0 {
		args = append(args, "--max-count="+strconv.Itoa(max))
	}
	out, err := runGit(repo, append(append(args, tips...), "--"), gitOptions{})
	if err != nil {
		return nil, err
	}
	commits := []commitInfo{}
	for record := range strings.SplitSeq(string(out.stdout), "\x00") {
		if strings.TrimSpace(record) == "" {
			continue
		}
		lines := strings.Split(strings.TrimPrefix(record, "\n"), "\n")
		if len(lines) < 5 {
			continue
		}
		time, _ := strconv.ParseInt(lines[4], 10, 64)
		parents := []string{}
		if lines[2] != "" {
			parents = strings.Split(lines[2], " ")
		}
		commits = append(commits, commitInfo{id: lines[0], tree: lines[1], parents: parents, author: lines[3], time: time,
			message: strings.Join(lines[5:], "\n")})
	}
	return commits, nil
}

// revisions is the history of a repository with these branches: its newest
// commits and every head, oldest first, each without its content.
func (h *History) revisions(repo string, branches map[string]string) ([]Revision, error) {
	names := make([]string, 0, len(branches))
	for name := range branches {
		names = append(names, name)
	}
	sort.Strings(names)
	var built strings.Builder
	for _, name := range names {
		built.WriteString(name + " " + branches[name] + "\n")
	}
	key := built.String()
	if known, ok := h.logs[repo]; ok && known.key == key {
		return known.revisions, nil
	}
	heads := branchHeads(branches)
	listed, err := logCommits(repo, heads, historyLength)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	for _, info := range listed {
		ids[info.id] = true
	}
	missing := []string{}
	for _, head := range heads {
		if !ids[head] {
			missing = append(missing, head)
		}
	}
	found, err := readObjects(repo, missing, nil)
	if err != nil {
		return nil, err
	}
	for _, head := range missing {
		if raw, ok := found[head]; ok {
			listed = append(listed, parseCommit(head, raw))
		}
	}
	revisions := make([]Revision, len(listed))
	for i, info := range listed {
		revisions[len(listed)-1-i] = revisionMeta(info)
	}
	h.logs[repo] = historyLog{key, revisions}
	return revisions, nil
}

// meta is one commit's metadata.
func (h *History) meta(repo, commit string) (Revision, error) {
	found, err := readObjects(repo, []string{commit}, nil)
	if err != nil {
		return Revision{}, err
	}
	raw, ok := found[commit]
	if !ok {
		return Revision{}, errors.New("the commit " + commit + " is missing")
	}
	return revisionMeta(parseCommit(commit, raw)), nil
}

// read is a commit's content, its game files and assets kept in the asset
// store, and the problems its tree has.
func (h *History) read(repo, commit string) (Content, []string, error) {
	entries, err := listTree(repo, commit, nil)
	if err != nil {
		return Content{}, nil, err
	}
	content, problems, err := readTree(entries, h.source(repo))
	if err == nil && len(problems) == 0 {
		h.remember(commit, content)
	}
	return content, problems, err
}

// content is a commit's content, as it was read before or read now. Each
// caller gets its own copy.
func (h *History) content(repo, commit string) (Content, error) {
	if kept, ok := h.contents[commit]; ok {
		h.remember(commit, kept)
		return kept.clone(), nil
	}
	content, _, err := h.read(repo, commit)
	if err != nil {
		return Content{}, err
	}
	h.remember(commit, content)
	return content.clone(), nil
}

func (h *History) remember(commit string, content Content) {
	if _, ok := h.contents[commit]; ok {
		h.order = without(h.order, func(id string) bool { return id == commit })
	}
	h.contents[commit] = content
	h.order = append(h.order, commit)
	if len(h.order) > contentsKept {
		delete(h.contents, h.order[0])
		h.order = h.order[1:]
	}
}

// sha256 is the SHA-256 of a blob the host has read or written, or "".
func (h *History) sha256(repo, oid string) string { return h.cache(repo)[oid] }

// learn notes the SHA-256 of blobs the host wrote.
func (h *History) learn(repo string, pairs [][2]string) error {
	cache := h.cache(repo)
	var fresh strings.Builder
	for _, pair := range pairs {
		if _, known := cache[pair[0]]; !known {
			cache[pair[0]] = pair[1]
			fresh.WriteString(pair[0] + " " + pair[1] + "\n")
		}
	}
	if fresh.Len() == 0 {
		return nil
	}
	file, err := os.OpenFile(filepath.Join(repo, "zirbel-sha256"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600) // #nosec G304 -- a repository in the data directory
	if err != nil {
		return err
	}
	_, err = file.WriteString(fresh.String())
	return errors.Join(err, file.Close())
}

func (h *History) cache(repo string) map[string]string {
	if cache, ok := h.hashes[repo]; ok {
		return cache
	}
	cache := map[string]string{}
	data, _ := os.ReadFile(filepath.Join(repo, "zirbel-sha256")) // #nosec G304 -- none yet: hashed as read
	for line := range strings.SplitSeq(string(data), "\n") {
		if match := sha256Line.FindStringSubmatch(line); match != nil {
			cache[match[1]] = match[2]
		}
	}
	h.hashes[repo] = cache
	return cache
}

func (h *History) source(repo string) treeSource {
	bytes := func(oids []string) (map[string][]byte, error) { return readObjects(repo, oids, nil) }
	return treeSource{
		bytes: bytes,
		sha256: func(entries []treeEntry) (map[string]string, error) {
			cache := h.cache(repo)
			hashes, unread := map[string]string{}, []string{}
			for _, entry := range entries {
				if hash, ok := cache[entry.oid]; ok && h.store.hasAsset(hash) {
					hashes[entry.oid] = hash
				} else {
					unread = append(unread, entry.oid)
				}
			}
			found, err := readObjects(repo, unread, nil)
			if err != nil {
				return nil, err
			}
			learnt := [][2]string{}
			for _, oid := range unread {
				data, ok := found[oid]
				if !ok {
					continue
				}
				hash, err := h.store.storeAsset(data)
				if err != nil {
					return nil, err
				}
				hashes[oid] = hash
				learnt = append(learnt, [2]string{oid, hash})
			}
			return hashes, h.learn(repo, learnt)
		},
		assets: func(found []foundAsset) ([]string, error) { return checkAssets(found, bytes, h.store) },
	}
}

// checkAssets checks each asset's bytes, as its tree holds them, against its
// hash and media type, and keeps them in the store when there is one.
func checkAssets(found []foundAsset, bytes func([]string) (map[string][]byte, error), store assetStore) ([]string, error) {
	unread := []foundAsset{}
	oids := []string{}
	for _, item := range found {
		if store == nil || !store.hasAsset(item.asset.Hash) {
			unread = append(unread, item)
			oids = append(oids, item.entry.oid)
		}
	}
	read, err := bytes(oids)
	if err != nil {
		return nil, err
	}
	wrong := []string{}
	for _, item := range unread {
		data, ok := read[item.entry.oid]
		if !ok || digest(data) != item.asset.Hash || !mediaMatches(item.asset.Media, data) {
			wrong = append(wrong, item.asset.Name)
		} else if store != nil {
			if _, err := store.storeAsset(data); err != nil {
				return nil, err
			}
		}
	}
	if len(wrong) == 0 {
		return nil, nil
	}
	return []string{"The bytes of these assets don’t match them: " + strings.Join(wrong[:min(len(wrong), 8)], ", ") + "."}, nil
}

// clone is a copy of content that shares nothing with it.
func (c Content) clone() Content {
	out := Content{Assets: append([]Asset{}, c.Assets...)}
	if c.Scene != nil {
		scene := *c.Scene
		scene.Objects = append([]SceneObject{}, c.Scene.Objects...)
		out.Scene = &scene
	}
	if c.Game != nil {
		game := *c.Game
		game.Files = maps.Clone(c.Game.Files) // nil stays nil
		out.Game = &game
	}
	return out
}
