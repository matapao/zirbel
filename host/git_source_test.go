package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A game's source elsewhere: the addresses the host fetches from, a project's
// title from one, and an import and its updates from a repository on this
// computer (git.contract runs the same through both hosts' API).

func TestSourcesAreHttpsAddressesWrittenAsTheURLStandardWritesThem(t *testing.T) {
	for input, want := range map[string]string{
		"https://GitHub.com/owner/game.git":    "https://github.com/owner/game.git",
		" https://example.org:443/a/./b/../c ": "https://example.org/a/c",
		"https://example.org:8443":             "https://example.org:8443/",
		"https://example.org/a b/<c>":          "https://example.org/a%20b/%3Cc%3E",
		"https://example.org/x.git?":           "https://example.org/x.git?",
		"HTTPS:\\\\example.org\\games\\x.git":  "https://example.org/games/x.git",
		"https://[0:0:0:0:0:0:0:1]/x.git":      "https://[::1]/x.git",
		"https://example.org/%E2%9C%93/ü.git":  "https://example.org/%E2%9C%93/%C3%BC.git",
		"https://example.org/a/%2e%2E/b.git":   "https://example.org/b.git",
		// IPv4 and IPv6 addresses as the URL standard writes them, which fuzzing found the Go host didn't.
		"https://127.1/x.git":        "https://127.0.0.1/x.git",
		"https://0X7F.0.0.1.:443/":   "https://127.0.0.1/",
		"https://[::FFFF:1.2.3.4]/x": "https://[::ffff:102:304]/x",
	} {
		if got, err := sourceURL(input); got != want || err != nil {
			t.Errorf("sourceURL(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	for input, want := range map[string]string{
		"http://example.org/x.git": "Give the repository’s https:// address.", "ftp://example.org/x.git": "Give the repository’s https:// address.",
		"https://": "Give the repository’s https:// address.", "game.git": "Give the repository’s https:// address.",
		"file:///tmp/x.git":                     "Give the repository’s https:// address.",
		"https://user:secret@example.org/x.git": "The host imports public repositories only: give the address without a user name or password.",
		"https://example.org/x.git?a=1":         "Give the repository’s address without a query or fragment.",
		"https://example.org/x.git#main":        "Give the repository’s address without a query or fragment.",
	} {
		if _, err := sourceURL(input); err == nil || err.Error() != want || status(err) != http.StatusBadRequest {
			t.Errorf("sourceURL(%q): %v; want %q", input, err, want)
		}
	}
	for address, want := range map[string]string{"https://example.org/owner/My%20Game.git": "My Game", "https://example.org/": "Imported game",
		"https://example.org/a/b/": "b", "https://example.org/%FF.git": "%FF", "file:///tmp/source/game.git": "game"} {
		if got := sourceTitle(address); got != want {
			t.Errorf("sourceTitle(%q) = %q, want %q", address, got, want)
		}
	}
	for _, ref := range []string{"../main", "a//b", "a@{1}", "a/", "a.", "a.lock", "a/.b"} {
		if !badRef.MatchString(ref) {
			t.Errorf("%s is taken as a branch or tag", ref)
		}
	}
}

func TestAGameImportsFromItsSourceAndUpdatesFromIt(t *testing.T) {
	t.Setenv("ZIRBEL_GIT_ALLOW_LOCAL", "1")
	root := t.TempDir()
	source := filepath.Join(root, "source", "game.git")
	if err := initRepository(source); err != nil {
		t.Fatal(err)
	}
	first := commitFiles(t, source, "refs/heads/main", "", map[string]string{"index.html": "<p>1</p>", "a.js": "a1", "README.md": "#"}, "The game\n")
	store, err := NewProjects(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	address := "file://" + filepath.ToSlash(source)
	if _, err := store.ImportGit([]byte(`{"url":"` + address + `","ref":"no-such-branch"}`)); status(err) != http.StatusBadGateway {
		t.Errorf("a missing branch: %v", err)
	}
	if _, err := store.ImportGit([]byte(`{"url":"` + address + `","ref":"../main"}`)); status(err) != http.StatusBadRequest {
		t.Errorf("a bad ref: %v", err)
	}
	imported, err := store.ImportGit([]byte(`{"url":"` + address + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	if imported.Title != "game" || imported.Source == nil || imported.Source.URL != address || imported.Branches["main"] != first ||
		imported.Revisions[0].Author != "Tester" {
		t.Fatalf("the import: %+v", imported)
	}
	if leftovers, _ := filepath.Glob(filepath.Join(root, "data", "git", "*.importing")); len(leftovers) > 0 {
		t.Errorf("the import left %v", leftovers)
	}
	update := func(base string) (*sourceUpdate, error) {
		return store.UpdateFromSource(imported.ID, []byte(`{"baseRevision":"`+base+`"}`), ownerIdent)
	}
	if result, err := update(first); err != nil || result.Updated {
		t.Errorf("up to date: %+v %v", result, err)
	}
	second := commitFiles(t, source, "refs/heads/main", first, map[string]string{"index.html": "<p>1</p>", "a.js": "a2", "README.md": "#"}, "Faster\n")
	if result, err := update(first); err != nil || !result.Updated || result.Project.Branches["main"] != second {
		t.Fatalf("a fast-forward: %+v %v", result, err)
	}
	// The game's own commit, then the source's: a merge, the game's first; then both change the page.
	own := commitFiles(t, store.repository(imported.ID), "refs/zirbel/own", second, map[string]string{"index.html": "<p>1</p>", "a.js": "a2",
		"README.md": "#", "zirbel.json": `{"players":{"max":4}}`}, "Multiplayer\n")
	if _, err := updateRefs(store.repository(imported.ID), []refUpdate{{ref: "refs/heads/main", to: own, from: second}}); err != nil {
		t.Fatal(err)
	}
	third := commitFiles(t, source, "refs/heads/main", second, map[string]string{"index.html": "<p>3</p>", "a.js": "a2", "README.md": "#"}, "Page\n")
	merged, err := update(own)
	if err != nil {
		t.Fatal(err)
	}
	top := mustHead(t, merged.Project)
	if top.Label != "Update from source" || *top.Parent != own || !top.Game.Net || top.Game.HTML != "<p>3</p>" {
		t.Fatalf("a merge: %+v %v", top, err)
	}
	parents, _ := runGit(store.repository(imported.ID), []string{"log", "-1", "--format=%P", top.ID}, gitOptions{})
	if strings.TrimSpace(string(parents.stdout)) != own+" "+third {
		t.Errorf("the merge's parents: %s", parents.stdout)
	}
	page := commitFiles(t, store.repository(imported.ID), "refs/zirbel/page", top.ID, map[string]string{"index.html": "<p>host</p>", "a.js": "a2",
		"README.md": "#", "zirbel.json": `{"players":{"max":4}}`}, "Host page\n")
	if _, err := updateRefs(store.repository(imported.ID), []refUpdate{{ref: "refs/heads/main", to: page, from: top.ID}}); err != nil {
		t.Fatal(err)
	}
	commitFiles(t, source, "refs/heads/main", third, map[string]string{"index.html": "<p>source</p>", "a.js": "a2", "README.md": "#"}, "Source page\n")
	if _, err := update(page); err == nil || err.Error() != "The source’s changes conflict with this game’s in: index.html. Merge them in a clone and push." {
		t.Errorf("a conflict: %v", err)
	}
	if _, err := update(strings.Repeat("f", 40)); status(err) != http.StatusConflict {
		t.Errorf("a stale base: %v", err)
	}
	plain, err := store.CreateGame("Plain", nil, ownerIdent)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateFromSource(plain.ID, []byte(`{"baseRevision":"`+plain.Branches["main"]+`"}`), ownerIdent); status(err) != http.StatusNotFound {
		t.Errorf("a game without a source: %v", err)
	}
	if err := os.Unsetenv("ZIRBEL_GIT_ALLOW_LOCAL"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ImportGit([]byte(`{"url":"` + address + `"}`)); status(err) != http.StatusBadRequest {
		t.Errorf("file: without the tests' switch: %v", err)
	}
}

// An import's address and ref, as importSource checks them: what it takes is
// an https address it fetches as it is, and a branch or tag name git can't
// read as an option or another refspec; what it refuses, it refuses as the
// client's mistake.
func FuzzImportSource(f *testing.F) {
	for _, seed := range []string{`{"url":"https://example.org/game.git"}`, `{"url":"https://example.org/game.git","ref":"release/v1.2"}`,
		`{"url":"https://example.org/game.git","ref":"a..b"}`, `{"url":"https://example.org/game.git","ref":"-c"}`, `{"url":" https://example.org "}`,
		`{"url":"https://example.org/","ref":"main","extra":1}`, `{"url":"","ref":""}`, `{"url":"https://example.org/x","url":"file:///x"}`, `[]`} {
		f.Add([]byte(seed))
	}
	f.Setenv("ZIRBEL_GIT_ALLOW_LOCAL", "")
	f.Fuzz(func(t *testing.T, data []byte) {
		source, err := importSource(data)
		if err != nil {
			if status(err) != http.StatusBadRequest {
				t.Fatalf("%s: %v, not a 400", data, err)
			}
			return
		}
		if !strings.HasPrefix(source.URL, "https://") || strings.Contains(source.URL[:strings.IndexByte(source.URL[8:], '/')+8], "@") {
			t.Fatalf("%s: the address %q", data, source.URL)
		}
		if ref := source.Ref; ref != "" {
			first := ref[0]
			alphanumeric := first >= '0' && first <= '9' || first >= 'A' && first <= 'Z' || first >= 'a' && first <= 'z'
			if len(ref) > 200 || !alphanumeric || strings.Trim(ref, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-") != "" ||
				strings.Contains(ref, "..") || strings.Contains(ref, "//") || strings.Contains(ref, "/.") || strings.HasSuffix(ref, "/") ||
				strings.HasSuffix(ref, ".") || strings.HasSuffix(ref, ".lock") {
				t.Fatalf("%s: the ref %q", data, ref)
			}
		}
		if again, err := importSource(data); err != nil || again != source {
			t.Fatalf("%s: %v, then %v (%v)", data, source, again, err)
		}
	})
}
