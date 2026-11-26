package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// The host's pre-receive hook (`zirbel-host git-hook pre-receive`), mirroring
// packages/server/git-hook.ts, which git runs for every push before any ref
// moves: each update must be to a branch named as an id, no deletion, a
// fast-forward of a branch that exists (a project grant's push makes no new
// one), and end at a commit whose tree holds a game a host can keep (a scene
// project: a game or a scene), read under the rules every host applies
// (git_tree.go). It reads the pushed objects in receive-pack's quarantine, so
// a refused push leaves nothing behind; the reason goes to stderr, which the
// client shows. The git store in AGENTS.md is the design.

// quarantine is the environment receive-pack gives its hooks: the repository and its quarantine.
func quarantine() []string {
	kept := []string{}
	for _, key := range []string{"GIT_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_QUARANTINE_PATH"} {
		if value := os.Getenv(key); value != "" {
			kept = append(kept, key+"="+value)
		}
	}
	return gitEnvironment(kept...)
}

// refuseUpdate says why an update can't be taken, or nothing when it can.
// grant: a project grant pushes, which makes no branch.
func refuseUpdate(repo, update string, scene bool, env []string, grant bool) (string, error) {
	fields := strings.Split(update, " ")
	ref := "That ref"
	if len(fields) > 2 {
		ref = fields[2]
	}
	branch, isBranch := strings.CutPrefix(ref, "refs/heads/")
	if len(fields) < 3 || fields[0] == "" || fields[1] == "" || !isBranch || !idPattern.MatchString(branch) {
		return ref + ": Zirbel takes branches alone, named in lowercase letters, digits, - and _.", nil
	}
	from, to := fields[0], fields[1]
	if to == zeroCommit {
		return branch + ": a branch isn’t deleted by a push.", nil
	}
	if from == zeroCommit && grant {
		return branch + ": a project grant pushes to the game’s branches, and makes none.", nil
	}
	if from != zeroCommit {
		forward, err := isAncestor(repo, from, to, env)
		if err != nil {
			return "", err
		}
		if !forward {
			return branch + ": it has moved on. Pull, then push again (history isn’t rewritten).", nil
		}
	}
	entries, err := listTree(repo, to, env)
	if err != nil {
		return "", err
	}
	bytes := func(oids []string) (map[string][]byte, error) { return readObjects(repo, oids, env) }
	content, problems, err := readTree(entries, treeSource{bytes: bytes,
		sha256: func(entries []treeEntry) (map[string]string, error) {
			hashes := map[string]string{}
			for _, entry := range entries {
				hashes[entry.oid] = strings.Repeat("0", 64)
			}
			return hashes, nil
		},
		assets: func(found []foundAsset) ([]string, error) { return checkAssets(found, bytes, nil) }})
	if err != nil {
		return "", err
	}
	if len(problems) > 0 {
		return branch + ": this isn’t a game Zirbel can keep. " + problems[0], nil
	}
	if content.Game == nil && (!scene || content.Scene == nil) {
		return branch + ": there is no index.html at its top: a game needs one.", nil
	}
	return "", nil
}

// gitHook checks a push's updates, read from input: why the push is refused, or nothing.
func gitHook(input io.Reader) (string, error) {
	env := quarantine()
	repo, err := filepath.Abs(firstOf(os.Getenv("GIT_DIR"), "."))
	if err != nil {
		return "", err
	}
	// The project comes from the repository's directory name, the data directory from its parent's parent.
	projectID := strings.TrimSuffix(filepath.Base(repo), ".git")
	scene := false
	if idPattern.MatchString(projectID) {
		var stored struct {
			Template any `json:"template"`
		}
		data, err := os.ReadFile(filepath.Join(filepath.Dir(filepath.Dir(repo)), "projects", projectID+".json")) // #nosec G304 G703 -- the data directory's file for this repository
		if err == nil && json.Unmarshal(data, &stored) == nil {
			_, scene = stored.Template.(string)
		}
	}
	data, err := io.ReadAll(input)
	if err != nil {
		return "", err
	}
	grant := os.Getenv("ZIRBEL_GIT_GRANT") == "1"
	for update := range strings.SplitSeq(string(data), "\n") {
		if update == "" {
			continue
		}
		refused, err := refuseUpdate(repo, update, scene, env, grant)
		if err != nil || refused != "" {
			return refused, err
		}
	}
	return "", nil
}

// gitHookCommand runs the hook: its exit code.
func gitHookCommand(input io.Reader, output io.Writer) int {
	refused, err := gitHook(input)
	if err != nil {
		_, _ = fmt.Fprintln(output, "Zirbel could not check this push: "+err.Error())
		return 1
	}
	if refused != "" {
		_, _ = fmt.Fprintln(output, refused)
		return 1
	}
	return 0
}

// writeHooks writes the hooks every push runs, at each start: pre-receive runs
// this host's own check, with the program running now.
func writeHooks(root string) (string, error) {
	directory := filepath.Join(root, "git-hooks")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	program, err := os.Executable()
	if err != nil {
		return "", err
	}
	quoted := "'" + strings.ReplaceAll(program, "'", `'\''`) + "'"
	temporary, err := os.CreateTemp(directory, "pre-receive.*.tmp")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(temporary.Name()) }() // #nosec G703 -- the file just made
	_, err = temporary.WriteString("#!/bin/sh\nexec " + quoted + " git-hook pre-receive\n")
	if err == nil {
		err = temporary.Chmod(0o700) // #nosec G302 -- a hook git runs
	}
	if closed := temporary.Close(); err == nil {
		err = closed
	}
	if err == nil {
		err = os.Rename(temporary.Name(), filepath.Join(directory, "pre-receive")) // #nosec G703 -- the file just made
	}
	return directory, err
}
