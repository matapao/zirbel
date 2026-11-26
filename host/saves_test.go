package main

import (
	"encoding/base64"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The git store: every save a commit, the game's folder at the top of its
// tree, the host's own files under .zirbel/, proposals on refs of their own,
// history from git (test/git-store.test.ts holds the Node host to the same).

func paths(t *testing.T, repo, commit string) []string {
	t.Helper()
	entries, err := listTree(repo, commit, nil)
	if err != nil {
		t.Fatal(err)
	}
	listed := []string{}
	for _, item := range entries {
		listed = append(listed, item.path)
	}
	return listed
}

func blobText(t *testing.T, repo, commit, path string) string {
	t.Helper()
	out, err := runGit(repo, []string{"cat-file", "blob", commit + ":" + path}, gitOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return string(out.stdout)
}

// mustHead is the head of main, which the test needs.
func mustHead(t *testing.T, p *Project) *Revision {
	t.Helper()
	if p == nil {
		t.Fatal("no project")
	}
	revision, err := head(p, "main")
	if err != nil || revision == nil {
		t.Fatalf("no head of main: %v", err)
	}
	return revision
}

func status(err error) int {
	if known, ok := errors.AsType[*HTTPError](err); ok {
		return known.Status
	}
	return 0
}

func TestEverySaveIsACommitByWhoAsked(t *testing.T) {
	store, err := NewProjects(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	encode := func(text string) string { return base64.StdEncoding.EncodeToString([]byte(text)) }
	ada := newIdent("Ada <x>", "editor.1@zirbel.invalid")
	project, err := store.ImportGameFolder([]byte(`{"title":"Net","files":{"index.html":"`+encode(`<script src="net/adapter.mjs"></script>`)+
		`","net/adapter.mjs":"`+encode("export {}")+`","zirbel.json":"`+encode(`{"players":{"max":8},"multiplayer":{"adapter":"net/adapter.mjs"}}`)+`"}}`), ada)
	if err != nil {
		t.Fatal(err)
	}
	repo := store.repository(project.ID)
	first := mustHead(t, project)
	if !commitPattern.MatchString(first.ID) || first.Author != "Ada x" || first.Game.MaxPlayers != 8 || !first.Game.Net ||
		strings.Join(paths(t, repo, first.ID), " ") != "index.html net/adapter.mjs zirbel.json" {
		t.Fatalf("the import: %+v %v", first, paths(t, repo, first.ID))
	}
	logged, _ := runGit(repo, []string{"log", "--format=%an|%ae|%cn|%ce|%s", "main"}, gitOptions{})
	if string(logged.stdout) != "Ada x|editor.1@zirbel.invalid|Zirbel|zirbel@zirbel.invalid|Imported game folder\n" {
		t.Errorf("the commit: %s", logged.stdout)
	}
	if kept, _ := os.ReadFile(filepath.Join(repo, "zirbel-sha256")); /* #nosec G304 -- the test's own repository */ !strings.Contains(string(kept), first.Game.Files["zirbel.json"]) {
		t.Errorf("the game files' SHA-256s aren't kept: %s", kept)
	}

	// A game for three that shares state, its own fields under .zirbel/; a proposal on a ref of its own.
	flag := false
	shared, err := store.CreateGame("Shared", &Game{HTML: "<p>three</p>", MaxPlayers: 3, RegisterObjects: &flag}, ownerIdent)
	if err != nil {
		t.Fatal(err)
	}
	sharedRepo := store.repository(shared.ID)
	if text := blobText(t, sharedRepo, "main", gameJSON); text != "{\n  \"maxPlayers\": 3,\n  \"registerObjects\": false\n}\n" {
		t.Errorf(".zirbel/game.json: %q", text)
	}
	base := shared.Branches["main"]
	staged, err := store.Submit(shared.ID, []byte(`{"baseRevision":"`+base+`","branch":"main","label":"Two","operations":[{"op":"writeGame","game":{"html":"<p>two</p>","maxPlayers":2}}]}`), ownerIdent, nil)
	if err != nil {
		t.Fatal(err)
	}
	commit, _ := resolve(sharedRepo, proposalRef(staged.Proposal.ID))
	if parent, _ := resolve(sharedRepo, commit+"^"); parent != base || staged.Preview.Game.MaxPlayers != 2 || staged.Preview.Game.RegisterObjects != nil {
		t.Fatalf("the proposal's commit: %s %+v", parent, staged.Preview.Game)
	}
	sibling, err := store.Submit(shared.ID, []byte(`{"baseRevision":"`+base+`","branch":"main","label":"Three","operations":[{"op":"writeGame","game":{"html":"<p>3</p>"}}]}`), ownerIdent, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Commit(shared.ID, sibling.Proposal.ID, "main"); status(err) != http.StatusConflict {
		t.Errorf("a fork named as a branch that exists: %v", err)
	}
	applied, err := store.Commit(shared.ID, staged.Proposal.ID, "")
	if err != nil || applied.Revision.ID != commit || applied.Revision.Author != "Owner" {
		t.Fatalf("applying: %+v %v", applied, err)
	}
	if gone, _ := resolve(sharedRepo, proposalRef(staged.Proposal.ID)); gone != "" {
		t.Error("an applied proposal kept its ref")
	}
	if _, err := store.Commit(shared.ID, sibling.Proposal.ID, ""); status(err) != http.StatusConflict {
		t.Errorf("a proposal on a base that moved on: %v", err)
	}
	if err := store.Discard(shared.ID, sibling.Proposal.ID); err != nil {
		t.Fatal(err)
	}
	if gone, _ := resolve(sharedRepo, proposalRef(sibling.Proposal.ID)); gone != "" {
		t.Error("a discarded proposal kept its ref")
	}

	// A restore commits the earlier tree exactly, with its trailer; history lists the head alone in full.
	bo := newIdent("Bo", "device.2@zirbel.invalid")
	restored, err := store.Restore(shared.ID, "main", commit, base, bo)
	if err != nil {
		t.Fatal(err)
	}
	now := mustHead(t, restored)
	trees, _ := runGit(sharedRepo, []string{"rev-parse", now.ID + "^{tree}", base + "^{tree}"}, gitOptions{})
	lines := strings.Fields(string(trees.stdout))
	if now.RestoredFrom != base || now.Label != "Restore Created with harness" || now.Author != "Bo" || lines[0] != lines[1] {
		t.Errorf("the restore: %+v %v", now, lines)
	}
	labels := []string{}
	for _, revision := range restored.Revisions {
		labels = append(labels, revision.Label+":"+map[bool]string{true: "full", false: "meta"}[revision.Assets != nil])
	}
	if strings.Join(labels, ",") != "Created with harness:meta,Two:meta,Restore Created with harness:full" {
		t.Errorf("history: %v", labels)
	}
	if earlier, err := store.Revision(shared.ID, commit); err != nil || earlier.Game.HTML != "<p>two</p>" {
		t.Errorf("a revision in full: %+v %v", earlier, err)
	}
	for _, unknown := range []string{strings.Repeat("f", 40), "nope", commit[:39]} {
		if _, err := store.Revision(shared.ID, unknown); status(err) != http.StatusNotFound {
			t.Errorf("%s: %v", unknown, err)
		}
	}
}

func TestAScenePassesThroughGitWithItsAssets(t *testing.T) {
	store, err := NewProjects(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
	hash, err := store.storeAsset(png)
	if err != nil {
		t.Fatal(err)
	}
	scene := &Scene{ID: "meadow", Background: "#000000", Objects: []SceneObject{{ID: "fire", Kind: "campfire", Name: "Fire", X: 10, Y: 20, Size: 30, Color: "#ff0000"}}}
	store.mu.Lock()
	project, err := store.createRevision("Scene", initialRevision{scene: scene, template: "mosslight", label: "Initial scene"}, ownerIdent)
	store.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	staged, err := store.Submit(project.ID, []byte(`{"baseRevision":"`+project.Branches["main"]+`","branch":"main","label":"Add a dot","operations":[`+
		`{"op":"addAsset","asset":{"id":"dot","name":"Dot","author":"Me","source":"https://example.org/dot.png","license":"CC0-1.0","credit":"","hash":"`+hash+`","media":"image/png"}},`+
		`{"op":"background","color":"#112233"}]}`), ownerIdent, nil)
	if err != nil {
		t.Fatal(err)
	}
	applied, err := store.Commit(project.ID, staged.Proposal.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	repo := store.repository(project.ID)
	if listed := strings.Join(paths(t, repo, applied.Revision.ID), " "); listed != ".zirbel/assets.json .zirbel/assets/"+hash+".png .zirbel/scene.json" {
		t.Errorf("the tree: %s", listed)
	}
	if revision := applied.Revision; revision.Scene.Background != "#112233" || len(revision.Assets) != 1 || revision.Assets[0].Hash != hash {
		t.Errorf("the revision: %+v", revision)
	}
	known, err := store.knownAssets(project.ID)
	if err != nil || len(known) != 1 || known[0].ID != "dot" {
		t.Errorf("known assets: %v %v", known, err)
	}
}
