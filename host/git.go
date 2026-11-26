package main

import (
	"bytes"
	"context"
	"crypto/sha1" // #nosec G505 -- git names its objects by SHA-1: an object id, not a security hash
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"zirbel/contracts"
)

// The git program, as the host runs it, mirroring packages/core/git.ts: with
// none of the system's or the person's settings (credential helpers,
// insteadOf, hooks), no prompts, and plain C messages. Everything is plumbing:
// ls-tree and cat-file to read, fast-import to write (git_import.go),
// update-ref --stdin to move refs, each move compare-and-swap.
// The git store in AGENTS.md is the design.

// The oldest git the host runs on: merge-tree --write-tree came in 2.38.
const gitMinimumMajor, gitMinimumMinor = 2, 38

// zeroCommit is the value update-ref and a hook give a ref that isn't there.
const zeroCommit = "0000000000000000000000000000000000000000"

// gitContext is what the host's git runs under: a step of the store, once
// started, runs to its end whatever becomes of the request that asked for it,
// as Node's spawnSync does.
var gitContext = context.Background()

var (
	commitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
	gitVersionAt  = regexp.MustCompile(`git version (\d+)\.(\d+)`)
	identCrud     = regexp.MustCompile("[<>\x00-\x1f\x7f]")
)

// ident is who a commit names: its author, or its committer.
type ident struct{ name, email string }

var (
	committer  = ident{"Zirbel", "zirbel@zirbel.invalid"}
	ownerIdent = ident{"Owner", "owner@zirbel.invalid"}
)

// identName is a name as an ident takes it: no angle brackets, control
// characters or surrounding space, at most 120 code points; Unknown for none.
func identName(name string) string {
	plain := []rune(contracts.Trim(identCrud.ReplaceAllString(name, "")))
	if len(plain) > 120 {
		plain = plain[:120]
	}
	if text := contracts.Trim(string(plain)); text != "" {
		return text
	}
	return "Unknown"
}

func newIdent(name, email string) ident { return ident{identName(name), email} }

// gitEnvironment is what every git the host runs starts from; extra adds to it
// (a hook's quarantine, CGI variables) as KEY=VALUE.
func gitEnvironment(extra ...string) []string {
	env := []string{}
	for _, key := range []string{"PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot"} {
		if value := os.Getenv(key); value != "" {
			env = append(env, key+"="+value)
		}
	}
	env = append(env, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_TERMINAL_PROMPT=0",
		"GIT_NO_REPLACE_OBJECTS=1", "LC_ALL=C")
	return append(env, extra...)
}

type gitOptions struct {
	input []byte
	allow []int    // exit codes that are answers (1 for "no"), not failures
	env   []string // nil: gitEnvironment()
}
type gitResult struct {
	status int
	stdout []byte
	stderr string
}

// runGit runs git on a repository and waits: its output, or an error with
// git's own words, which the API answers as a 500 and logs.
func runGit(repo string, args []string, o gitOptions) (gitResult, error) {
	env := o.env
	if env == nil {
		env = gitEnvironment()
	}
	// The program is git; its arguments are the host's own plumbing.
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	cmd := exec.CommandContext(gitContext, "git", append([]string{"--git-dir=" + repo}, args...)...) // #nosec G204 G702 -- git, with the host's own arguments
	cmd.Env = env
	if o.input != nil {
		cmd.Stdin = bytes.NewReader(o.input)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	status := 0
	if exit, ok := errors.AsType[*exec.ExitError](err); ok {
		status = exit.ExitCode()
	} else if err != nil {
		return gitResult{}, errors.New("git could not run: " + err.Error())
	}
	result := gitResult{status, stdout.Bytes(), stderr.String()}
	if status != 0 && !slices.Contains(o.allow, status) {
		said := strings.TrimSpace(result.stderr)
		if len(said) > 400 {
			said = said[:400]
		}
		return result, errors.New("git " + args[0] + " failed: " + said)
	}
	return result, nil
}

// requireGit refuses to go on without git, or with one older than 2.38.
func requireGit() error {
	cmd := exec.CommandContext(gitContext, "git", "--version")
	cmd.Env = gitEnvironment()
	out, _ := cmd.Output()
	text := strings.TrimSpace(string(out))
	found := "no git"
	if match := gitVersionAt.FindStringSubmatch(text); match != nil {
		major, _ := strconv.Atoi(match[1])
		minor, _ := strconv.Atoi(match[2])
		if major > gitMinimumMajor || (major == gitMinimumMajor && minor >= gitMinimumMinor) {
			return nil
		}
		found = text
	}
	return errors.New("Zirbel needs git " + strconv.Itoa(gitMinimumMajor) + "." + strconv.Itoa(gitMinimumMinor) +
		" or later to keep its games' history (found " + found + "). Install git and start Zirbel again.")
}

// blobID is a blob's id as git names it: SHA-1 of its header and bytes.
func blobID(data []byte) string {
	// nosemgrep: go.lang.security.audit.crypto.use_of_weak_crypto.use-of-sha1 -- git's object ids are SHA-1
	hash := sha1.New() // #nosec G401 -- git's object id
	hash.Write([]byte("blob " + strconv.Itoa(len(data)) + "\x00"))
	hash.Write(data)
	return hex.EncodeToString(hash.Sum(nil))
}

// initRepository makes a new bare repository whose HEAD is main, its objects
// named by SHA-1 whatever git's default is.
func initRepository(repo string) error {
	if err := os.RemoveAll(repo); err != nil {
		return err
	}
	cmd := exec.CommandContext(gitContext, "git", "init", "--bare", "--quiet", "--object-format=sha1", repo) // #nosec G204 G702 -- git, with a path in the data directory
	cmd.Env = gitEnvironment()
	if out, err := cmd.CombinedOutput(); err != nil {
		return errors.New("git init failed: " + strings.TrimSpace(string(out)))
	}
	_, err := runGit(repo, []string{"symbolic-ref", "HEAD", "refs/heads/main"}, gitOptions{})
	return err
}

// readBranches is a repository's branches by name, read from its ref files: a
// loose ref over a packed one. Names that aren't ids are left out. A
// repository with reftable is asked instead.
func readBranches(repo string) (map[string]string, error) {
	branches := map[string]string{}
	if _, err := os.Stat(filepath.Join(repo, "reftable")); err == nil {
		listed, err := runGit(repo, []string{"for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"}, gitOptions{})
		if err != nil {
			return nil, err
		}
		for line := range strings.SplitSeq(string(listed.stdout), "\n") {
			oid, ref, _ := strings.Cut(line, " ")
			branch, isBranch := strings.CutPrefix(ref, "refs/heads/")
			if isBranch && idPattern.MatchString(branch) && commitPattern.MatchString(oid) {
				branches[branch] = oid
			}
		}
		return branches, nil
	}
	packed, err := os.ReadFile(filepath.Join(repo, "packed-refs")) // #nosec G304 -- a repository in the data directory
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	for line := range strings.SplitSeq(string(packed), "\n") {
		oid, ref, _ := strings.Cut(line, " ")
		branch, isBranch := strings.CutPrefix(ref, "refs/heads/")
		if isBranch && commitPattern.MatchString(oid) && idPattern.MatchString(branch) {
			branches[branch] = oid
		}
	}
	loose, _ := os.ReadDir(filepath.Join(repo, "refs", "heads"))
	for _, entry := range loose {
		if !idPattern.MatchString(entry.Name()) || entry.IsDir() {
			continue
		}
		text, err := os.ReadFile(filepath.Join(repo, "refs", "heads", entry.Name())) // #nosec G304 -- a ref named as an id
		if oid := strings.TrimSpace(string(text)); err == nil && commitPattern.MatchString(oid) {
			branches[entry.Name()] = oid
		}
	}
	return branches, nil
}

// branchHeads are a repository's branch heads once each, in the order of
// their branches' names.
func branchHeads(branches map[string]string) []string {
	names := make([]string, 0, len(branches))
	for name := range branches {
		names = append(names, name)
	}
	sort.Strings(names)
	heads := []string{}
	for _, name := range names {
		if !slices.Contains(heads, branches[name]) {
			heads = append(heads, branches[name])
		}
	}
	return heads
}

// treeEntry is one entry of a commit's tree, at any depth: mode, type, object
// id, size (blobs) and path.
type treeEntry struct {
	mode, kind, oid string
	size            int64
	path            string
}

// listTree is a commit's (or tree's) every entry. env: a hook's quarantine.
func listTree(repo, treeish string, env []string) ([]treeEntry, error) {
	out, err := runGit(repo, []string{"ls-tree", "-r", "-z", "--full-tree", "-l", treeish}, gitOptions{env: env})
	if err != nil {
		return nil, err
	}
	entries := []treeEntry{}
	for record := range strings.SplitSeq(string(out.stdout), "\x00") {
		head, path, found := strings.Cut(record, "\t")
		fields := strings.Fields(head)
		if !found || len(fields) < 4 {
			continue
		}
		size, _ := strconv.ParseInt(fields[3], 10, 64)
		entries = append(entries, treeEntry{fields[0], fields[1], fields[2], size, path})
	}
	return entries, nil
}

// readObjects is objects' contents by id, in one cat-file run. A missing
// object is left out; an object named by an expression is found by its id.
func readObjects(repo string, oids []string, env []string) (map[string][]byte, error) {
	found := map[string][]byte{}
	wanted := []string{}
	for _, oid := range oids {
		if !slices.Contains(wanted, oid) {
			wanted = append(wanted, oid)
		}
	}
	if len(wanted) == 0 {
		return found, nil
	}
	out, err := runGit(repo, []string{"cat-file", "--batch"}, gitOptions{input: []byte(strings.Join(wanted, "\n") + "\n"), env: env})
	if err != nil {
		return nil, err
	}
	data := out.stdout
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		if end < 0 {
			break
		}
		header := strings.Split(string(data[:end]), " ")
		data = data[end+1:]
		if len(header) < 3 || header[1] == "missing" {
			continue
		}
		size := objectSize(header[2])
		if size < 0 || size > len(data) {
			break
		}
		found[header[0]] = data[:size]
		data = data[min(size+1, len(data)):]
	}
	return found, nil
}

// objectSize is the size cat-file gives an object, or -1.
func objectSize(text string) int {
	size, err := strconv.Atoi(text)
	if err != nil {
		return -1
	}
	return size
}

// commitInfo is a commit as its metadata: tree, parents, author's name,
// committer time (seconds) and message.
type commitInfo struct {
	id, tree string
	parents  []string
	author   string
	time     int64
	message  string
}

var (
	authorTail    = regexp.MustCompile(` <[^>]*> -?\d+ [+-]\d{4}$`)
	committerTime = regexp.MustCompile(` (-?\d+) [+-]\d{4}$`)
)

func parseCommit(id string, raw []byte) commitInfo {
	text := string(raw)
	head, message, _ := strings.Cut(text, "\n\n")
	info := commitInfo{id: id, parents: []string{}, message: message}
	for line := range strings.SplitSeq(head, "\n") {
		switch {
		case strings.HasPrefix(line, "tree "):
			info.tree = line[5:]
		case strings.HasPrefix(line, "parent "):
			info.parents = append(info.parents, line[7:])
		case strings.HasPrefix(line, "author "):
			info.author = authorTail.ReplaceAllString(line[7:], "")
		case strings.HasPrefix(line, "committer "):
			if match := committerTime.FindStringSubmatch(line); match != nil {
				info.time, _ = strconv.ParseInt(match[1], 10, 64)
			}
		}
	}
	return info
}

// resolve is a ref's commit, or "" when there is none.
func resolve(repo, ref string) (string, error) {
	out, err := runGit(repo, []string{"rev-parse", "--verify", "--quiet", ref + "^{commit}"}, gitOptions{allow: []int{1}})
	if err != nil {
		return "", err
	}
	if oid := strings.TrimSpace(string(out.stdout)); out.status == 0 && commitPattern.MatchString(oid) {
		return oid, nil
	}
	return "", nil
}

func isAncestor(repo, ancestor, descendant string, env []string) (bool, error) {
	out, err := runGit(repo, []string{"merge-base", "--is-ancestor", ancestor, descendant}, gitOptions{allow: []int{1}, env: env})
	return err == nil && out.status == 0, err
}

// refUpdate moves ref to (or deletes it, with to ""), expecting it at from
// (zeroCommit: not there yet; "": anywhere).
type refUpdate struct{ ref, to, from string }

var refMoved = regexp.MustCompile(`cannot lock ref|is at .* but expected|reference already exists|unable to resolve reference`)

// updateRefs moves refs in one transaction: each update names the value it
// expects, so nothing moves when one of them has moved on. It says whether it
// went through.
func updateRefs(repo string, updates []refUpdate) (bool, error) {
	var lines strings.Builder
	for _, u := range updates {
		line := "update " + u.ref + " " + u.to
		if u.to == "" {
			line = "delete " + u.ref
		}
		if u.from != "" {
			line += " " + u.from
		}
		lines.WriteString(line + "\n")
	}
	out, err := runGit(repo, []string{"update-ref", "--stdin"}, gitOptions{input: []byte(lines.String()), allow: []int{128}})
	if err != nil {
		return false, err
	}
	if out.status == 0 {
		return true, nil
	}
	if refMoved.MatchString(out.stderr) {
		return false, nil
	}
	return false, errors.New("git update-ref failed: " + strings.TrimSpace(out.stderr))
}

// commitTree commits an existing tree, its parents in order: its id.
func commitTree(repo, tree string, parents []string, author ident, time int64, message string) (string, error) {
	stamp := strconv.FormatInt(time, 10) + " +0000"
	args := []string{"commit-tree", tree}
	for _, parent := range parents {
		args = append(args, "-p", parent)
	}
	env := gitEnvironment("GIT_AUTHOR_NAME="+identName(author.name), "GIT_AUTHOR_EMAIL="+author.email,
		"GIT_AUTHOR_DATE="+stamp, "GIT_COMMITTER_NAME="+committer.name, "GIT_COMMITTER_EMAIL="+committer.email,
		"GIT_COMMITTER_DATE="+stamp)
	out, err := runGit(repo, append(args, "-F", "-"), gitOptions{input: []byte(message), env: env})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out.stdout)), nil
}
