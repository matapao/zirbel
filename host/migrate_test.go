package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Version-1 projects become repositories once, to the same commits, with the
// old files kept aside; a bundle imports as commits and exports back.

func versionOne(t *testing.T, root string) (string, string) {
	t.Helper()
	for _, name := range []string{"projects", "proposals", "assets"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	id, ids := "00000000-0000-4000-8000-0000000000aa", []string{"00000000-0000-4000-8000-000000000001",
		"00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"}
	project := `{"version":1,"id":"` + id + `","title":"Old game","branches":{"main":"` + ids[2] + `","variant":"` + ids[3] + `"},"revisions":[` +
		`{"id":"` + ids[0] + `","parent":null,"label":"Created project","date":"2026-01-01T10:00:00.000Z","assets":[]},` +
		`{"id":"` + ids[1] + `","parent":"` + ids[0] + `","label":"Write the game","date":"2026-01-01T11:00:00.000Z","assets":[],"game":{"html":"<p>1</p>","maxPlayers":3}},` +
		`{"id":"` + ids[2] + `","parent":"` + ids[1] + `","restoredFrom":"` + ids[0] + `","label":"Restore Created project","date":"2026-01-01T12:00:00.000Z","assets":[]},` +
		`{"id":"` + ids[3] + `","parent":"` + ids[0] + `","label":"Try a variant","date":"2026-01-01T13:00:00.000Z","assets":[],"game":{"html":"<p>variant</p>"}}],` +
		`"notes":[],"attachments":[]}`
	if err := os.WriteFile(filepath.Join(root, "projects", id+".json"), []byte(project), 0o600); err != nil {
		t.Fatal(err)
	}
	proposal := `{"baseRevision":"` + ids[2] + `","branch":"main","label":"Pending","operations":[{"op":"writeGame","game":{"html":"<p>pending</p>"}}],` +
		`"id":"00000000-0000-4000-8000-0000000000bb","projectId":"` + id + `","date":"2026-01-01T14:00:00.000Z"}`
	if err := os.WriteFile(filepath.Join(root, "proposals", id+".00000000-0000-4000-8000-0000000000bb.json"), []byte(proposal), 0o600); err != nil {
		t.Fatal(err)
	}
	return id, project
}

func TestVersionOneProjectsBecomeRepositoriesOnceToTheSameCommits(t *testing.T) {
	root := t.TempDir()
	id, original := versionOne(t, root)
	store, err := NewProjects(root)
	if err != nil {
		t.Fatal(err)
	}
	if migrated, err := store.Migrate(); migrated != 1 || err != nil {
		t.Fatalf("migrated %d: %v", migrated, err)
	}
	if migrated, _ := store.Migrate(); migrated != 0 {
		t.Fatal("a version-2 project was migrated again")
	}
	if kept, _ := os.ReadFile(filepath.Join(root, "migrated-projects", id+".json")); /* #nosec G304 -- the test's own data folder */ string(kept) != original {
		t.Error("the version-1 file isn't kept")
	}
	project, err := store.Read(id)
	if err != nil {
		t.Fatal(err)
	}
	labels := []string{}
	for _, revision := range project.Revisions {
		labels = append(labels, revision.Label+"|"+revision.Date+"|"+revision.Author)
	}
	if strings.Join(labels, ",") != "Created project|2026-01-01T10:00:00.000Z|Zirbel,Write the game|2026-01-01T11:00:00.000Z|Zirbel,"+
		"Restore Created project|2026-01-01T12:00:00.000Z|Zirbel,Try a variant|2026-01-01T13:00:00.000Z|Zirbel" {
		t.Errorf("history: %v", labels)
	}
	created, written, restored := project.Revisions[0], project.Revisions[1], project.Revisions[2]
	if project.Branches["main"] != restored.ID || restored.RestoredFrom != created.ID || *written.Parent != created.ID {
		t.Errorf("branches and parents: %v %+v", project.Branches, restored)
	}
	repo := store.repository(id)
	message, _ := runGit(repo, []string{"log", "-1", "--format=%B", written.ID}, gitOptions{})
	if !strings.Contains(string(message.stdout), "\n\nZirbel-Revision: 00000000-0000-4000-8000-000000000002\n") {
		t.Errorf("the old id's trailer: %q", message.stdout)
	}
	pending, err := store.Proposals(id, "main")
	if err != nil || len(pending) != 1 || pending[0].BaseRevision != restored.ID {
		t.Fatalf("the pending proposal: %v %v", pending, err)
	}
	if staged, err := store.Preview(id, pending[0].ID); err != nil || staged.Preview.Game.HTML != "<p>pending</p>" {
		t.Errorf("its commit: %+v %v", staged, err)
	}
	var stored map[string]any
	data, _ := os.ReadFile(filepath.Join(root, "projects", id+".json")) // #nosec G304 -- the test's own data folder
	if json.Unmarshal(data, &stored) != nil || stored["version"] != 2.0 || stored["branches"] != nil {
		t.Errorf("the version-2 file: %s", data)
	}

	// A migration that ended before its last step runs again to the very same commits.
	if err := os.WriteFile(filepath.Join(root, "projects", id+".json"), []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	again, err := NewProjects(root)
	if err != nil {
		t.Fatal(err)
	}
	if migrated, _ := again.Migrate(); migrated != 1 {
		t.Fatal("a version-1 file found again wasn't migrated again")
	}
	if project, _ := again.Read(id); project == nil || project.Branches["main"] != restored.ID || project.Branches["variant"] != project.Revisions[3].ID {
		t.Errorf("migrated again to other commits: %+v", project)
	}
	if pending, _ := again.Proposals(id, "main"); len(pending) != 1 || pending[0].BaseRevision != restored.ID {
		t.Errorf("the proposal migrated again: %v", pending)
	}
}

func TestABundleImportsAsCommitsAndExportsBack(t *testing.T) {
	store, err := NewProjects(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := os.ReadFile(filepath.Join("..", "test", "fixtures", "hollow-crown.zirbel-project.json"))
	if err != nil {
		t.Fatal(err)
	}
	importer := newIdent("Importer", "owner@zirbel.invalid")
	imported, err := store.Import(bundle, importer)
	if err != nil {
		t.Fatal(err)
	}
	revision := mustHead(t, imported)
	if !commitPattern.MatchString(revision.ID) || revision.Author != "Importer" || revision.Scene == nil || !imported.Imported {
		t.Fatalf("the import: %+v", revision)
	}
	exported, err := store.Export(imported.ID)
	if err != nil {
		t.Fatal(err)
	}
	var back struct {
		Project map[string]json.RawMessage `json:"project"`
	}
	if err := json.Unmarshal(exported, &back); err != nil {
		t.Fatal(err)
	}
	var revisions []Revision
	_ = json.Unmarshal(back.Project["revisions"], &revisions)
	if len(revisions) != 1 || revisions[0].ID != revision.ID || revisions[0].Author != "Importer" || back.Project["source"] != nil {
		t.Errorf("the export: %s", exported)
	}
	again, err := store.Import(exported, importer)
	if err != nil {
		t.Fatal(err)
	}
	// The same revisions by the same author make the same commits.
	if copied := mustHead(t, again); copied.ID != revision.ID {
		t.Errorf("the copy's commit %s, the original's %s", copied.ID, revision.ID)
	}
}
