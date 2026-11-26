package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The pre-receive check refuses a push that isn't a game, or isn't a
// fast-forward of a branch, before any branch moves; git-box.contract and
// git.contract push through both hosts' hooks.

func TestThePushCheckTakesGamesAndRefusesTheRest(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "git", "game.git")
	if err := initRepository(repo); err != nil {
		t.Fatal(err)
	}
	first := commitFiles(t, repo, "refs/heads/main", "", map[string]string{"index.html": "<p>1</p>"}, "One\n")
	next := commitFiles(t, repo, "refs/zirbel/next", first, map[string]string{"index.html": "<p>2</p>", "README.md": "# Mine"}, "Two\n")
	other := commitFiles(t, repo, "refs/zirbel/other", "", map[string]string{"index.html": "<p>other</p>"}, "Other\n")
	pageless := commitFiles(t, repo, "refs/zirbel/pageless", first, map[string]string{"other.html": "<p>"}, "No page\n")
	refuse := func(update string, grant bool) string {
		refused, err := refuseUpdate(repo, update, false, nil, grant)
		if err != nil {
			t.Fatal(err)
		}
		return refused
	}
	for update, want := range map[string]string{
		first + " " + next + " refs/heads/main":         "",
		zeroCommit + " " + next + " refs/heads/new":     "",
		first + " " + next + " refs/tags/v1":            "refs/tags/v1: Zirbel takes branches alone, named in lowercase letters, digits, - and _.",
		first + " " + next + " refs/heads/Bad_Name":     "refs/heads/Bad_Name: Zirbel takes branches alone, named in lowercase letters, digits, - and _.",
		first + " " + zeroCommit + " refs/heads/main":   "main: a branch isn’t deleted by a push.",
		next + " " + other + " refs/heads/main":         "main: it has moved on. Pull, then push again (history isn’t rewritten).",
		first + " " + pageless + " refs/heads/main":     "main: there is no index.html at its top: a game needs one.",
		first + " " + next:                              "That ref: Zirbel takes branches alone, named in lowercase letters, digits, - and _.",
		zeroCommit + " " + next + " refs/heads/granted": "",
	} {
		if got := refuse(update, false); got != want {
			t.Errorf("%s: %q, want %q", update, got, want)
		}
	}
	if got := refuse(zeroCommit+" "+next+" refs/heads/new", true); got != "new: a project grant pushes to the game’s branches, and makes none." {
		t.Errorf("a grant made a branch: %q", got)
	}
	// The hook as git runs it: its updates on stdin, the repository as GIT_DIR, and the reason on stderr.
	t.Setenv("GIT_DIR", repo)
	var said bytes.Buffer
	if code := gitHookCommand(strings.NewReader(first+" "+next+" refs/heads/main\n"+first+" "+zeroCommit+" refs/heads/main\n"), &said); code != 1 ||
		said.String() != "main: a branch isn’t deleted by a push.\n" {
		t.Errorf("exit %d: %q", code, said.String())
	}
	said.Reset()
	if code := gitHookCommand(strings.NewReader(first+" "+next+" refs/heads/main\n"), &said); code != 0 || said.Len() > 0 {
		t.Errorf("a fast-forward of a game: exit %d, %q", code, said.String())
	}
	hooks, err := writeHooks(root)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(hooks, "pre-receive"))
	written, _ := os.ReadFile(filepath.Join(hooks, "pre-receive")) // #nosec G304 -- the test's own file
	if err != nil || info.Mode().Perm() != 0o700 || !strings.HasSuffix(string(written), "' git-hook pre-receive\n") {
		t.Errorf("the hook: %v %s", err, written)
	}
}

func TestGitTokensAreDerivedFromTheBoxsSecret(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "box")
	tokens, err := newGitTokens(folder)
	if err != nil {
		t.Fatal(err)
	}
	holder := tokenHolder{"o", "00000000-0000-4000-8000-000000000001"}
	token, err := tokens.token(holder)
	if err != nil || !tokenShape.MatchString(token) {
		t.Fatalf("token %q: %v", token, err)
	}
	if found, ok := tokens.holder(token); !ok || found != holder {
		t.Errorf("the token's holder: %+v %v", found, ok)
	}
	again, err := newGitTokens(folder)
	if err != nil {
		t.Fatal(err)
	}
	if same, _ := again.token(holder); same != token {
		t.Error("the token changed with the secret kept")
	}
	if _, ok := tokens.holder("e" + token[1:]); ok {
		t.Error("a device's mac made an editor's token")
	}
	secret, _ := os.ReadFile(filepath.Join(folder, "git-secret")) // #nosec G304 -- the test's own file
	info, err := os.Stat(filepath.Join(folder, "git-secret"))
	if err != nil {
		t.Fatal(err)
	}
	if !secretShape.MatchString(strings.TrimSuffix(string(secret), "\n")) || !strings.HasSuffix(string(secret), "\n") || info.Mode().Perm() != 0o600 {
		t.Errorf("the secret: %q %v", secret, info.Mode())
	}
	for header, want := range map[string]string{"Bearer abc": "abc", "Basic emlyYmVsOnNlY3JldA==": "secret", "Basic c2VjcmV0": "secret",
		"Basic emlyYmVsOg==": "", "Digest x": ""} {
		if got := credential(header); got != want {
			t.Errorf("credential(%q) = %q, want %q", header, got, want)
		}
	}
}

// A pushed update's line, `<old> <new> <ref>`, as refuseUpdate reads it: the
// refusals that need no repository are the Node host's, word for word, and an
// update it takes moves a branch named as an id, deletes nothing, and ends at
// a game.
func FuzzRefuseUpdate(f *testing.F) {
	repo := filepath.Join(f.TempDir(), "git", "game.git")
	if err := initRepository(repo); err != nil {
		f.Fatal(err)
	}
	first := commitFiles(f, repo, "refs/heads/main", "", map[string]string{"index.html": "<p>1</p>"}, "One\n")
	next := commitFiles(f, repo, "refs/zirbel/next", first, map[string]string{"index.html": "<p>2</p>"}, "Two\n")
	pageless := commitFiles(f, repo, "refs/zirbel/pageless", first, map[string]string{"other.html": "<p>"}, "No page\n")
	for _, update := range []string{first + " " + next + " refs/heads/main", zeroCommit + " " + next + " refs/heads/new", next + " " + first + " refs/heads/main",
		first + " " + pageless + " refs/heads/main", first + " " + zeroCommit + " refs/heads/main", first + " " + next + " refs/tags/v1",
		first + " " + next, "  refs/heads/main", first + " " + next + " refs/heads/Main extra"} {
		f.Add(update, false)
		f.Add(update, true)
	}
	games := []string{treeOf(f, repo, first), treeOf(f, repo, next)}
	refusedRef := ": Zirbel takes branches alone, named in lowercase letters, digits, - and _."
	f.Fuzz(func(t *testing.T, update string, grant bool) {
		refused, err := refuseUpdate(repo, update, false, nil, grant)
		// What packages/server/git-hook.ts refuses before it reads the repository.
		fields := strings.Split(update, " ")
		ref := "That ref"
		if len(fields) > 2 {
			ref = fields[2]
		}
		branch, isBranch := strings.CutPrefix(ref, "refs/heads/")
		switch {
		case len(fields) < 3 || fields[0] == "" || fields[1] == "" || !isBranch || !idPattern.MatchString(branch):
			if refused != ref+refusedRef || err != nil {
				t.Fatalf("%q: %q, %v; Node refuses it as %q", update, refused, err, ref+refusedRef)
			}
		case fields[1] == zeroCommit:
			if refused != branch+": a branch isn’t deleted by a push." || err != nil {
				t.Fatalf("%q, a deletion: %q, %v", update, refused, err)
			}
		case fields[0] == zeroCommit && grant:
			if refused != branch+": a project grant pushes to the game’s branches, and makes none." || err != nil {
				t.Fatalf("%q, a new branch by a grant: %q, %v", update, refused, err)
			}
		case err == nil && refused == "":
			// Taken: the update ends at a game, one of the trees with a page.
			if tree := treeOf(t, repo, fields[1]); tree != games[0] && tree != games[1] {
				t.Fatalf("%q was taken, at %q, which isn't a game", update, tree)
			}
		case err == nil && !strings.HasPrefix(refused, branch+": "):
			t.Fatalf("%q: %q names another branch", update, refused)
		}
	})
}

// treeOf is the tree a revision names in a repository, or "".
func treeOf(t testing.TB, repo, revision string) string {
	t.Helper()
	out, err := runGit(repo, []string{"rev-parse", "--verify", "--quiet", "--end-of-options", revision + "^{tree}"}, gitOptions{allow: []int{1, 128}})
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out.stdout))
}
