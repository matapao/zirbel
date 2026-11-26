package main

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Git's smart HTTP alone, through git http-backend: what the routes answer
// before the backend, and a ref advertisement from it.

func TestGitIsServedOverSmartHTTPAlone(t *testing.T) {
	root := t.TempDir()
	store, err := NewProjects(root)
	if err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateGame("Served", &Game{HTML: "<p>served</p>", MaxPlayers: 1}, ownerIdent)
	if err != nil {
		t.Fatal(err)
	}
	hooks, err := writeHooks(root)
	if err != nil {
		t.Fatal(err)
	}
	server := &EditorServer{Editor: &Editor{projects: store}, hooks: hooks}
	call := func(method, path string, access boxAccess) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		handled, err := server.serveGit(recorder, httptest.NewRequestWithContext(t.Context(), method, path, http.NoBody), access)
		if !handled {
			t.Fatalf("%s %s wasn't git's", method, path)
		}
		if err != nil {
			replyError(recorder, err)
		}
		return recorder
	}
	local := boxAccess{local: true}
	repo := "/git/" + project.ID + ".git"
	for path, want := range map[string]int{repo + "/HEAD": 404, repo + "/info/refs": 404, repo + "/info/refs?service=git-daemon": 404,
		"/git/no-such-game.git/info/refs?service=git-upload-pack": 404, "/git/../x.git/info/refs?service=git-upload-pack": 404} {
		if got := call(http.MethodGet, path, local).Code; got != want {
			t.Errorf("GET %s: %d, want %d", path, got, want)
		}
	}
	if answer := call(http.MethodGet, repo+"/git-receive-pack", local); answer.Code != 405 || answer.Header().Get("allow") != "POST" {
		t.Errorf("a GET of a service: %d %v", answer.Code, answer.Header())
	}
	// From the box's network, a request without credentials is challenged; an editor's session reaches its game alone.
	if answer := call(http.MethodGet, repo+"/info/refs?service=git-upload-pack", boxAccess{}); answer.Code != 401 ||
		answer.Header().Get("www-authenticate") != `Basic realm="Zirbel", charset="UTF-8"` {
		t.Errorf("no credentials: %d %v", answer.Code, answer.Header())
	}
	if got := call(http.MethodGet, repo+"/info/refs?service=git-upload-pack", boxAccess{editor: "e", game: "another"}).Code; got != 403 {
		t.Errorf("an editor of another game: %d", got)
	}
	answer := call(http.MethodGet, repo+"/info/refs?service=git-upload-pack", local)
	if answer.Code != 200 || answer.Header().Get("content-type") != "application/x-git-upload-pack-advertisement" ||
		!strings.Contains(answer.Body.String(), project.Branches["main"]+" HEAD") || strings.Contains(answer.Body.String(), "refs/zirbel") {
		t.Errorf("the advertisement: %d %v %q", answer.Code, answer.Header(), answer.Body.String())
	}
	if filepath.Base(hooks) != "git-hooks" {
		t.Errorf("hooks at %s", hooks)
	}
}

// A push larger than a git client's post buffer comes chunked: the backend reads it to its end.
func TestALargePushArrivesWhole(t *testing.T) {
	root := t.TempDir()
	store, err := NewProjects(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateGame("Large", &Game{HTML: "<p>large</p>", MaxPlayers: 1}, ownerIdent)
	if err != nil {
		t.Fatal(err)
	}
	hooks := filepath.Join(root, "hooks")
	// The hook writeHooks writes runs this program, which here is the test's: one that takes every push stands in.
	if err := os.MkdirAll(hooks, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hooks, "pre-receive"), []byte("#!/bin/sh\ncat >/dev/null\n"), 0o700); err != nil { // #nosec G306 -- a hook git runs
		t.Fatal(err)
	}
	server := &EditorServer{Editor: &Editor{projects: store}, hooks: hooks}
	chunked := make(chan bool, 16)
	listener := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/git-receive-pack") {
			chunked <- len(r.TransferEncoding) > 0
		}
		if _, err := server.serveGit(w, r, boxAccess{local: true}); err != nil {
			replyError(w, err)
		}
	}))
	defer listener.Close()
	client := func(dir string, args ...string) {
		command := exec.CommandContext(t.Context(), "git", append([]string{"-c", "user.name=Tester", "-c", "user.email=t@example.org"}, args...)...) // #nosec G204 G702 -- the test's own git
		command.Dir, command.Env = dir, gitEnvironment()
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	client(root, "clone", "--quiet", listener.URL+"/git/"+project.ID+".git", "work")
	work := filepath.Join(root, "work")
	large := make([]byte, 3<<20)
	if _, err := rand.Read(large); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "large.bin"), large, 0o600); err != nil {
		t.Fatal(err)
	}
	client(work, "add", "-A")
	client(work, "commit", "--quiet", "-m", "Large")
	client(work, "push", "--quiet", "origin", "main")
	// A probe with its length first, then the pack, chunked.
	close(chunked)
	sawChunked := false
	for value := range chunked {
		sawChunked = sawChunked || value
	}
	if !sawChunked {
		t.Error("the push came with its length: it tests nothing of a chunked one")
	}
	read, err := store.Read(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if now := mustHead(t, read); now.Label != "Large" || now.Game.Files["large.bin"] != digest(large) {
		t.Errorf("the push: %+v", now)
	}
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// nodeCredential is credential() in packages/server/git-http.ts as Node runs
// it on a header's text, which it reads as Latin-1; it gives the bytes Node
// decodes before it reads them as UTF-8, which changes only bytes no token holds.
func nodeCredential(header string) string {
	// /^Bearer (\S+)$/: JavaScript's white space in Latin-1 is these bytes.
	if token, ok := strings.CutPrefix(header, "Bearer "); ok && token != "" {
		spaced := false
		for i := range len(token) {
			spaced = spaced || strings.IndexByte("\t\n\v\f\r \xa0", token[i]) >= 0
		}
		if !spaced {
			return token
		}
	}
	encoded, ok := strings.CutPrefix(header, "Basic ")
	if !ok || encoded == "" || strings.Trim(encoded, base64Alphabet+"=") != "" {
		return ""
	}
	// Buffer.from(…, 'base64'): up to the first "=", four characters three bytes, and two or three at the end one or two.
	var value [256]byte
	var next byte
	for _, c := range []byte(base64Alphabet) {
		value[c] = next
		next++
	}
	digits, _, _ := strings.Cut(encoded, "=")
	var decoded []byte
	for i := 0; i+1 < len(digits); i += 4 {
		a, b := value[digits[i]], value[digits[i+1]]
		decoded = append(decoded, a<<2|b>>4)
		if i+2 < len(digits) {
			c := value[digits[i+2]]
			decoded = append(decoded, b<<4|c>>2)
			if i+3 < len(digits) {
				decoded = append(decoded, c<<6|value[digits[i+3]])
			}
		}
	}
	text := string(decoded)
	return text[strings.IndexByte(text, ':')+1:]
}

// The token a git client sends as its Basic password or bearer token, as
// credential reads it: what Node reads from the same header, and the password
// or token the client put in it.
func FuzzGitCredential(f *testing.F) {
	for _, header := range []string{"Bearer abc", "Basic emlyYmVsOnNlY3JldA==", "Basic c2VjcmV0", "Basic emlyYmVsOg==", "Digest x", "Basic YTpiYw==YQ",
		"Basic YQ==YTpi", "Basic YTpiYwZ", "Bearer a b", "Bearer a\xa0b", "Bearer a\vb", "Basic ", "bearer abc"} {
		f.Add(header, "zirbel", "o.00000000-0000-4000-8000-000000000001."+strings.Repeat("A", 43))
	}
	f.Fuzz(func(t *testing.T, header, user, password string) {
		got, want := credential(header), nodeCredential(header)
		token := func(text string) bool { return grantToken.MatchString(text) || tokenShape.MatchString(text) }
		// Go's \S differs from JavaScript's in \v and past ASCII alone, where no token is.
		if exact := strings.IndexFunc(header, func(r rune) bool { return r == '\v' || r >= 0x80 }) < 0; (exact || token(got) || token(want)) && got != want {
			t.Fatalf("%q: %q; Node reads %q", header, got, want)
		}
		if strings.Contains(user, ":") {
			return
		}
		basic := base64.StdEncoding.EncodeToString([]byte(user + ":" + password))
		for _, sent := range []string{basic, strings.TrimRight(basic, "=")} {
			if sent != "" && credential("Basic "+sent) != password {
				t.Fatalf("Basic %s: %q, not %q", sent, credential("Basic "+sent), password)
			}
		}
		if password != "" && strings.IndexFunc(password, func(r rune) bool { return r <= ' ' || r >= 0x7f }) < 0 && credential("Bearer "+password) != password {
			t.Fatalf("Bearer %s: %q", password, credential("Bearer "+password))
		}
	})
}
