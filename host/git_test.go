package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The git program as the host runs it, and the bytes it writes: names as an
// ident takes them, commit messages, and JSON files as JSON.stringify(v, null, 2)
// writes them.

func TestIdentsAndMessagesAreWrittenAsTheNodeHostWritesThem(t *testing.T) {
	for name, want := range map[string]string{"Ada <x>": "Ada x", "  \u00a0Bo\n ": "Bo", "<>": "Unknown",
		strings.Repeat("é", 130): strings.Repeat("é", 120)} {
		if got := identName(name); got != want {
			t.Errorf("identName(%q) = %q, want %q", name, got, want)
		}
	}
	if got := commitMessage("  One \r\n\t two\nthree  "); got != "One two three\n" {
		t.Errorf("a label's line breaks: %q", got)
	}
	if got := commitMessage("Restore x", [2]string{"Zirbel-Restored-From", "abc"}); got != "Restore x\n\nZirbel-Restored-From: abc\n" {
		t.Errorf("a trailer: %q", got)
	}
	if got := sliceUTF16("ab😀", 3); got != "ab\uFFFD" {
		t.Errorf("a pair cut in half: %q", got)
	}
	if got := sliceUTF16("ab😀c", 4); got != "ab😀" {
		t.Errorf("a pair kept whole: %q", got)
	}
	if got := quotePath(`a"b`); got != `"a\"b"` {
		t.Errorf("a quoted path: %s", got)
	}
}

func TestJSONFilesAreJSONStringifyWithTwoSpaces(t *testing.T) {
	scene := &Scene{ID: "s", Background: "#112233", Objects: []SceneObject{}}
	data, err := jsonFile(scene)
	if err != nil {
		t.Fatal(err)
	}
	if want := "{\n  \"id\": \"s\",\n  \"background\": \"#112233\",\n  \"objects\": []\n}\n"; string(data) != want {
		t.Errorf("scene.json:\n%s", data)
	}
	flag := false
	if data, _ = jsonFile(ownGame{MaxPlayers: 3, RegisterObjects: &flag}); string(data) != "{\n  \"maxPlayers\": 3,\n  \"registerObjects\": false\n}\n" {
		t.Errorf("game.json:\n%s", data)
	}
	asset := Asset{ID: "a", Name: "<Dot> & ü", Author: "Me", Source: "https://example.org/a.png", License: "CC0-1.0", Hash: strings.Repeat("a", 64), Media: "image/png"}
	if data, _ = jsonFile([]Asset{asset}); !strings.Contains(string(data), "\"name\": \"<Dot> & ü\",\n    \"author\"") {
		t.Errorf("assets.json, without HTML escapes:\n%s", data)
	}
}

func TestBlobIDsAreGits(t *testing.T) {
	repo := filepath.Join(t.TempDir(), "r.git")
	if err := initRepository(repo); err != nil {
		t.Fatal(err)
	}
	out, err := runGit(repo, []string{"hash-object", "--stdin"}, gitOptions{input: []byte("abc\n")})
	if err != nil || strings.TrimSpace(string(out.stdout)) != blobID([]byte("abc\n")) {
		t.Fatalf("blobID differs from git's: %s %v", out.stdout, err)
	}
	if head, _ := os.ReadFile(filepath.Join(repo, "HEAD")); /* #nosec G304 -- the test's own repository */ string(head) != "ref: refs/heads/main\n" {
		t.Errorf("HEAD is %q", head)
	}
}

func TestAnEditorNeedsGit(t *testing.T) {
	if err := requireGit(); err != nil {
		t.Fatalf("this computer's git: %v", err)
	}
	t.Setenv("PATH", t.TempDir())
	err := requireGit()
	if err == nil || err.Error() != "Zirbel needs git 2.38 or later to keep its games' history (found no git). Install git and start Zirbel again." {
		t.Errorf("without git: %v", err)
	}
}

// commitFiles writes a commit of these files alone on ref, its parent from: its id.
func commitFiles(t testing.TB, repo, ref, from string, files map[string]string, message string) string {
	t.Helper()
	stream := newFastImport()
	changes := []treeChange{{op: "deleteall"}}
	for _, path := range sortedKeys(files) {
		changes = append(changes, treeChange{op: "M", mode: "100644", blob: stream.blob([]byte(files[path])), path: path})
	}
	mark := stream.commit(ref, commitSpec{author: ident{"Tester", "t@example.org"}, time: 1_800_000_000, message: message, from: from}, changes)
	ids, err := stream.run(repo)
	if err != nil {
		t.Fatal(err)
	}
	return ids[mark]
}

func TestRefsMoveCompareAndSwapAndBranchesReadFromTheirFiles(t *testing.T) {
	repo := filepath.Join(t.TempDir(), "r.git")
	if err := initRepository(repo); err != nil {
		t.Fatal(err)
	}
	first := commitFiles(t, repo, "refs/heads/main", "", map[string]string{"index.html": "<p>1</p>"}, "One\n")
	second := commitFiles(t, repo, "refs/zirbel/x", first, map[string]string{"index.html": "<p>2</p>"}, "Two\n")
	if moved, err := updateRefs(repo, []refUpdate{{ref: "refs/heads/main", to: second, from: second}}); moved || err != nil {
		t.Fatalf("a ref moved from a value it didn't have: %v %v", moved, err)
	}
	if moved, err := updateRefs(repo, []refUpdate{{ref: "refs/heads/fork", to: second, from: zeroCommit},
		{ref: "refs/zirbel/x", from: second}}); !moved || err != nil {
		t.Fatalf("a fork wasn't made: %v %v", moved, err)
	}
	if moved, _ := updateRefs(repo, []refUpdate{{ref: "refs/heads/fork", to: first, from: zeroCommit}}); moved {
		t.Fatal("a branch was made twice")
	}
	if _, err := runGit(repo, []string{"pack-refs", "--all"}, gitOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "refs", "heads", "Not_An_Id"), []byte(first+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	branches, err := readBranches(repo)
	if err != nil || len(branches) != 2 || branches["main"] != first || branches["fork"] != second {
		t.Fatalf("branches: %v %v", branches, err)
	}
	if found, _ := resolve(repo, "refs/zirbel/x"); found != "" {
		t.Errorf("a deleted ref resolved to %s", found)
	}
	if forward, _ := isAncestor(repo, first, second, nil); !forward {
		t.Error("a child isn't its parent's descendant")
	}
	info, _ := readObjects(repo, []string{second, "f" + strings.Repeat("0", 39)}, nil)
	if commit := parseCommit(second, info[second]); len(info) != 1 || commit.author != "Tester" || commit.parents[0] != first || commit.time != 1_800_000_000 {
		t.Errorf("the commit read back: %+v", commit)
	}
}
