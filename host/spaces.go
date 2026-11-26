package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"zirbel/host/webfiles"
)

// The spaces kernel, mirroring packages/server/spaces.ts: games with their
// own netcode play over it. The host runs it as a child (its binary's spaces
// mode, with Zirbel's skalet.json), or, under a host that already runs one
// (SKALET_SPACES in the environment), uses that one and runs none. The host's
// own code reaches it over its local socket (spaces_socket.go); pages reach it
// through /.skalet/* on the listeners, which spaces_proxy.go passes to the
// child's address. The socket's address and token stay in this process.

const (
	spacesStartTime = 10 * time.Second // for the child's start line
	spacesSteady    = time.Minute      // a child that ran this long starts the backoff over
	// spacesListener is the listener of skalet.json a room's space is for, and
	// spacesObservers the observers each takes beside its players.
	spacesListener  = "player"
	spacesObservers = 4
)

var spacesBackoff = []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second}

// spacesBinary is the kernel's binary: the one named (--spaces-binary,
// ZIRBEL_SPACES_BINARY), else one beside this program (the box image's),
// else the one `pnpm run deps` built in the repository; empty for none.
func spacesBinary(named string) string {
	if named != "" {
		return named
	}
	name := "skalet"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	self, err := os.Executable()
	if err != nil {
		return ""
	}
	dir := filepath.Dir(self)
	for _, path := range []string{filepath.Join(dir, name), filepath.Join(dir, "..", "..", "deps", "skalet", "bin", name)} {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path
		}
	}
	return ""
}

// Spaces is the kernel as the host runs or reaches it.
type Spaces struct {
	binary   string
	manifest string // skalet.json, written out for the child

	mu      sync.Mutex
	socket  *spacesSocket
	http    string // the child's address, for /.skalet/*; empty under a host or while none runs
	token   string
	child   *exec.Cmd
	stdin   io.Closer
	exited  chan struct{} // closed when the child has ended
	timer   *time.Timer
	attempt int
	stopped bool
	resets  []func()
}

// startSpaces starts the kernel at the binary named, or found, for the rooms,
// which play a net game's room over it.
func startSpaces(rooms *Rooms, named string) *Spaces {
	spaces := &Spaces{binary: spacesBinary(named)}
	rooms.UseSpaces(spaces)
	spaces.Start()
	return spaces
}

// Start starts the kernel, or connects to the host's, and returns once the
// first try has succeeded or failed.
func (s *Spaces) Start() {
	if address := os.Getenv("SKALET_SPACES"); address != "" {
		_ = s.connect(address, os.Getenv("SKALET_SPACES_TOKEN"), "")
		return
	}
	if s.binary == "" {
		return
	}
	if info, err := os.Stat(s.binary); err != nil || info.IsDir() {
		fmt.Fprintln(os.Stderr, "Zirbel finds no spaces kernel at "+s.binary+": games with their own netcode play alone.")
		return
	}
	manifest := webfiles.Manifest()
	if manifest == nil {
		fmt.Fprintln(os.Stderr, "The build has no skalet.json; run `pnpm build` before `pnpm build:host`.")
		return
	}
	dir, err := os.MkdirTemp("", "zirbel-spaces-")
	if err == nil {
		s.manifest = filepath.Join(dir, "skalet.json")
		err = os.WriteFile(s.manifest, manifest.Bytes, 0o600)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Zirbel can't write skalet.json for the spaces kernel:", err)
		return
	}
	s.spawn()
}

// Available reports whether spaces can be opened now.
func (s *Spaces) Available() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.socket != nil
}

// Target is where /.skalet/* goes and the token it goes with: the child's.
func (s *Spaces) Target() (address, token string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.http, s.token, s.http != ""
}

// OnReset hears that the kernel went, and every space it held with it.
func (s *Spaces) OnReset(listener func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.resets = append(s.resets, listener)
}

// Call calls the kernel; a *spacesError when none runs or it refuses.
func (s *Spaces) Call(method string, params any) (json.RawMessage, error) {
	s.mu.Lock()
	socket := s.socket
	s.mu.Unlock()
	if socket == nil {
		return nil, &spacesError{Code: "unavailable", Message: "Multiplayer isn't available on this host now."}
	}
	return socket.call(method, params)
}

// Stop ends the child: it ends when its stdin closes, and on SIGTERM.
func (s *Spaces) Stop() {
	s.mu.Lock()
	s.stopped = true
	if s.timer != nil {
		s.timer.Stop()
	}
	socket, child, stdin, exited := s.socket, s.child, s.stdin, s.exited
	s.mu.Unlock()
	if socket != nil {
		socket.close()
	}
	if child != nil {
		if stdin != nil {
			_ = stdin.Close()
		}
		_ = child.Process.Signal(syscall.SIGTERM)
		select {
		case <-exited:
		case <-time.After(3 * time.Second):
			_ = child.Process.Kill()
		}
	}
	if s.manifest != "" {
		_ = os.RemoveAll(filepath.Dir(s.manifest))
	}
}

func (s *Spaces) spawn() {
	// #nosec G204 -- the binary is the owner's (a flag, the environment, or the build's own); it ends by its stdin and SIGTERM, not a context
	child := exec.CommandContext(context.Background(), s.binary, "spaces", "--manifest", s.manifest)
	child.Env = append(withoutSpaces(os.Environ()), "SKALET_EXIT_WITH_STDIN=1")
	child.Stderr = os.Stderr
	stdin, err := child.StdinPipe()
	var stdout io.ReadCloser
	if err == nil {
		stdout, err = child.StdoutPipe()
	}
	if err == nil {
		err = child.Start()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "The spaces kernel did not start:", err)
		return
	}
	born, exited := time.Now(), make(chan struct{})
	s.mu.Lock()
	// Its stdin is held open for as long as the host runs: the child ends with it, even when the host is killed.
	s.child, s.stdin, s.exited = child, stdin, exited
	s.mu.Unlock()
	lines := make(chan string, 1)
	go func() {
		reader := bufio.NewReader(stdout)
		line, _ := reader.ReadString('\n')
		lines <- line
		_, _ = io.Copy(io.Discard, reader)
	}()
	go func() {
		_ = child.Wait()
		close(exited)
		s.mu.Lock()
		if s.child == child {
			s.child, s.stdin, s.http, s.token = nil, nil, "", ""
		}
		if time.Since(born) > spacesSteady {
			s.attempt = 0
		}
		s.mu.Unlock()
		s.retry(s.spawn)
	}()
	var started struct {
		Spaces string `json:"spaces"`
		Socket string `json:"socket"`
		Token  string `json:"token"`
	}
	select {
	case line := <-lines:
		err = decodeContract("spaces-start", []byte(strings.TrimSpace(line)), &started)
		if err == nil {
			err = s.connect(started.Socket, started.Token, started.Spaces)
		}
	case <-exited:
		err = errors.New("it ended")
	case <-time.After(spacesStartTime):
		err = errors.New("it printed no start line")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "The spaces kernel did not start:", err)
		_ = child.Process.Kill()
	}
}

// connect opens the kernel's socket; http is the child's address, empty under
// a host, whose socket is tried again until it answers.
func (s *Spaces) connect(address, token, http string) error {
	socket, err := dialSpaces(address, token)
	if err != nil {
		if http != "" {
			return err
		}
		fmt.Fprintln(os.Stderr, "Zirbel can't reach the spaces kernel at "+address+":", err)
		s.retry(func() { _ = s.connect(address, token, "") })
		return nil
	}
	s.mu.Lock()
	s.socket, s.http, s.token = socket, http, token
	s.mu.Unlock()
	go func() {
		<-socket.done
		s.mu.Lock()
		if s.socket != socket {
			s.mu.Unlock()
			return
		}
		s.socket, s.http = nil, ""
		resets, child, stopped := s.resets, s.child, s.stopped
		s.mu.Unlock()
		for _, listener := range resets {
			listener()
		}
		// Under a host, its socket comes back; a child's comes back with the child, which goes without it.
		if http == "" {
			s.retry(func() { _ = s.connect(address, token, "") })
		} else if child != nil && !stopped {
			_ = child.Process.Signal(syscall.SIGTERM)
		}
	}()
	return nil
}

func (s *Spaces) retry(again func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	wait := spacesBackoff[min(s.attempt, len(spacesBackoff)-1)]
	s.attempt++
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timer = time.AfterFunc(wait, func() {
		s.mu.Lock()
		stopped := s.stopped
		s.mu.Unlock()
		if !stopped {
			again()
		}
	})
}

// withoutSpaces is an environment without a host's kernel, for the child.
func withoutSpaces(env []string) []string {
	out := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, "SKALET_SPACES=") && !strings.HasPrefix(entry, "SKALET_SPACES_TOKEN=") {
			out = append(out, entry)
		}
	}
	return out
}
