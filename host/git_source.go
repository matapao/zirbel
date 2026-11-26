package main

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"zirbel/contracts"
)

// A game's source elsewhere, mirroring packages/core/git-source.ts: a public
// git repository the host imports a game from, and fetches again to update it.
// The host holds no outside credentials and never pushes outside; it fetches
// over https alone, with none of the person's git settings, within a time and
// size limit. An update merges the source's commits under the host's own (a
// fast-forward when it has none), and a conflict is reported, never forced.

const (
	fetchTime  = 120 * time.Second
	fetchBytes = 4 * PortableFileLimit
	sourceRef  = "refs/zirbel/source"
)

// badRef is what gitRef's refinement refuses besides its pattern.
var badRef = regexp.MustCompile(`\.\.|//|@\{|/$|\.$|\.lock$|/\.`)

// localSources: tests alone fetch from this computer, file: URLs and http on
// loopback, while ZIRBEL_GIT_ALLOW_LOCAL=1.
func localSources() bool { return os.Getenv("ZIRBEL_GIT_ALLOW_LOCAL") == "1" }

// sizeOf is the size of what a folder keeps, in bytes.
func sizeOf(path string) int64 {
	var total int64
	_ = filepath.WalkDir(path, func(_ string, entry fs.DirEntry, err error) error {
		if err == nil && entry.Type().IsRegular() {
			if info, err := entry.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

// tailWriter keeps the last 2000 bytes written to it.
type tailWriter struct {
	mu   sync.Mutex
	text []byte
}

func (t *tailWriter) Write(data []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.text = append(t.text, data...)
	if len(t.text) > 2000 {
		t.text = t.text[len(t.text)-2000:]
	}
	return len(data), nil
}

func (t *tailWriter) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.text)
}

// fetchSource fetches a source's branch or tag (its default branch without
// one) into the repository's refs/zirbel/source: the commit it fetched.
func fetchSource(repo, address, ref string) (string, error) {
	args := []string{"-c", "protocol.allow=never", "-c", "protocol.https.allow=always"}
	if localSources() {
		args = append(args, "-c", "protocol.file.allow=always", "-c", "protocol.http.allow=always")
	}
	// No askpass, no terminal: a repository that asks for credentials is refused, as it isn't public.
	args = append(args, "-c", "credential.helper=", "-c", "core.askPass=", "--git-dir="+repo, "fetch", "--no-tags",
		"--no-recurse-submodules", "--quiet", "--", address, "+"+firstOf(ref, "HEAD")+":"+sourceRef)
	ctx, cancel := context.WithCancel(gitContext)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...) // #nosec G204 G702 -- git, with an address and ref the host checked
	cmd.Env = gitEnvironment()
	stderr := &tailWriter{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return "", errors.New("git could not run: " + err.Error())
	}
	var once sync.Once
	var stopped error
	stop := func(reason error) { once.Do(func() { stopped = reason; cancel() }) }
	timer := time.AfterFunc(fetchTime, func() { stop(fail(http.StatusGatewayTimeout, "The source took too long to fetch.")) })
	tooLarge := fail(http.StatusRequestEntityTooLarge, "The source is larger than a game’s repository can be.")
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if sizeOf(filepath.Join(repo, "objects")) > fetchBytes {
					stop(tooLarge)
				}
			}
		}
	}()
	err := cmd.Wait()
	timer.Stop()
	close(done)
	stop(nil)
	if stopped != nil {
		return "", stopped
	}
	if err == nil && sizeOf(filepath.Join(repo, "objects")) > fetchBytes {
		return "", tooLarge
	}
	if err != nil {
		reason := "git could not fetch it"
		for line := range strings.SplitSeq(stderr.String(), "\n") {
			if line = strings.TrimSpace(strings.TrimPrefix(line, "fatal: ")); line != "" {
				reason = line
				break
			}
		}
		return "", fail(http.StatusBadGateway, "The source could not be fetched: "+truncateUTF16(reason, 200))
	}
	commit, err := resolve(repo, sourceRef)
	if err == nil && commit == "" {
		return "", fail(http.StatusBadGateway, "The source could not be fetched: it has no commit there.")
	}
	return commit, err
}

// checkHead is the problem a commit's tree has as a game's head, as a push's
// check reads it, or "".
func (s *Projects) checkHead(repo, commit string, scene bool) (string, error) {
	content, problems, err := s.history.read(repo, commit)
	if err != nil {
		return "", err
	}
	if len(problems) > 0 {
		return problems[0], nil
	}
	if content.Game == nil && (!scene || content.Scene == nil) {
		return "There is no index.html at its top: a game needs one.", nil
	}
	return "", nil
}

// importSource is what an import from a git URL asks for, checked: the
// address the host fetches and the branch or tag, if it names one.
func importSource(data []byte) (gitSource, error) {
	var input gitSource
	if err := decodeContract("import-git", data, &input); err != nil {
		return gitSource{}, err
	}
	if input.Ref != "" && badRef.MatchString(input.Ref) {
		return gitSource{}, fail(http.StatusBadRequest, "ref · Name a branch or tag.")
	}
	address, err := sourceURL(input.URL)
	if err != nil {
		return gitSource{}, err
	}
	return gitSource{address, input.Ref}, nil
}

// ImportGit is POST /api/projects/import-git: a new project from a public
// repository, its history the source's.
func (s *Projects) ImportGit(data []byte) (*Project, error) {
	source, err := importSource(data)
	if err != nil {
		return nil, err
	}
	projectID := newID()
	making := s.repository(projectID) + "." + newID() + ".importing"
	if err := initRepository(making); err != nil {
		return nil, err
	}
	defer func() { _ = os.RemoveAll(making) }()
	commit, err := fetchSource(making, source.URL, source.Ref)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	problem, err := s.checkHead(making, commit, false)
	if err != nil {
		return nil, err
	}
	if problem != "" {
		return nil, fail(http.StatusUnprocessableEntity, "This repository isn’t a game Zirbel can keep. "+problem)
	}
	if _, err := updateRefs(making, []refUpdate{{ref: "refs/heads/main", to: commit}}); err != nil {
		return nil, err
	}
	return s.adopt(making, nil, projectMeta{title: sourceTitle(source.URL), source: &source}, projectID)
}

type sourceUpdate struct {
	Updated bool     `json:"updated"`
	Project *Project `json:"project"`
}

// UpdateFromSource is POST /api/projects/<id>/update-from-source: the source
// fetched again and its commits brought under the branch's.
func (s *Projects) UpdateFromSource(projectID string, data []byte, author ident) (*sourceUpdate, error) {
	var input struct {
		Branch       *string `json:"branch"`
		BaseRevision string  `json:"baseRevision"`
	}
	if err := decodeContract("update-from-source", data, &input); err != nil {
		return nil, err
	}
	branch := branchOrMain(input.Branch)
	source, err := s.sourceOf(projectID, branch, input.BaseRevision)
	if err != nil {
		return nil, err
	}
	address, err := sourceURL(source.URL)
	if err != nil {
		return nil, err
	}
	repo := s.repository(projectID)
	fetched, err := fetchSource(repo, address, source.Ref)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	project, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	current, err := assertCurrent(project, branch, input.BaseRevision)
	if err != nil {
		return nil, err
	}
	if known, err := isAncestor(repo, fetched, current.ID, nil); err != nil || known {
		return &sourceUpdate{false, project}, err
	}
	next, err := s.mergeSource(repo, current.ID, fetched, author)
	if err != nil {
		return nil, err
	}
	problem, err := s.checkHead(repo, next, project.Template != "")
	if err != nil {
		return nil, err
	}
	if problem != "" {
		return nil, fail(http.StatusUnprocessableEntity, "The updated game isn’t one Zirbel can keep. "+problem)
	}
	if err := s.advance(projectID, branch, current.ID, next); err != nil {
		return nil, err
	}
	project, err = s.read(projectID)
	return &sourceUpdate{true, project}, err
}

// sourceOf is where a game came from, while the branch is where the caller saw it.
func (s *Projects) sourceOf(projectID, branch, base string) (*gitSource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	before, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	if before.Source == nil {
		return nil, fail(http.StatusNotFound, "This game has no source to update from.")
	}
	if _, err := assertCurrent(before, branch, base); err != nil {
		return nil, err
	}
	return before.Source, nil
}

// mergeSource is what the branch moves to: the source's commit when the head
// is in its history, or else a merge of the two, the head its first parent.
func (s *Projects) mergeSource(repo, head, fetched string, author ident) (string, error) {
	forward, err := isAncestor(repo, head, fetched, nil)
	if err != nil || forward {
		return fetched, err
	}
	merged, err := runGit(repo, []string{"merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", head, fetched},
		gitOptions{allow: []int{1, 128}})
	if err != nil {
		return "", err
	}
	if merged.status == 128 {
		if strings.Contains(merged.stderr, "unrelated histories") {
			return "", fail(http.StatusConflict, "The source’s history no longer shares a revision with this game’s. Merge it in a clone and push.")
		}
		return "", errors.New("git merge-tree failed: " + strings.TrimSpace(merged.stderr))
	}
	parts := strings.Split(string(merged.stdout), "\x00")
	if merged.status == 1 {
		paths := []string{}
		for _, path := range parts[1:] {
			if path == "" {
				break
			}
			if !slices.Contains(paths, path) {
				paths = append(paths, path)
			}
		}
		return "", fail(http.StatusConflict, "The source’s changes conflict with this game’s in: "+listedPaths(paths)+". Merge them in a clone and push.")
	}
	return commitTree(repo, parts[0], []string{head, fetched}, author, seconds(), commitMessage("Update from source"))
}

// sourceTitle is a project's title from its source's address: the last part
// of its path, without .git.
func sourceTitle(address string) string {
	path := address[strings.Index(address, "://")+3:]
	if slash := strings.IndexByte(path, '/'); slash >= 0 {
		path = path[slash:]
	} else {
		path = ""
	}
	if end := strings.IndexAny(path, "?#"); end >= 0 {
		path = path[:end]
	}
	last := ""
	for part := range strings.SplitSeq(path, "/") {
		if part != "" {
			last = part
		}
	}
	name := strings.TrimSuffix(last, ".git")
	if decoded, ok := decodeURIComponent(name); ok {
		name = decoded
	}
	if title := contracts.Trim(codePoints(contracts.Trim(name), 80)); title != "" {
		return title
	}
	return "Imported game"
}
