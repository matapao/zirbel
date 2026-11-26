package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// The box's switches (--box), mirroring packages/server/box-settings.ts, in
// the account folder (box/settings.json): whether harnesses run on the box,
// whether agents elsewhere on the network may use its MCP server, whether its
// first-run choice was made, whether someone asked for the Wi-Fi setup again,
// whether the box makes its own Wi-Fi (box_network.go), the last two of which
// the box's setup service reads from /api/box/status, and whether a TV
// plugged into the box shows its lobby (tv), which the box's console service
// reads there (AGENTS.md). The Go host has no harnesses: its box answers
// agents over MCP only.

type boxSwitches struct {
	Version        int  `json:"version"`
	Harnesses      bool `json:"harnesses"`
	ExternalMCP    bool `json:"externalMcp"`
	Onboarded      bool `json:"onboarded"`
	SetupRequested bool `json:"setupRequested"`
	// OwnNetwork is off in settings written before the box could make its own Wi-Fi.
	OwnNetwork bool `json:"ownNetwork"`
	// TV is as on a new box in settings written before its TV console.
	TV bool `json:"tv"`
}

// boxCapabilities is what the box is, as Node's boxCapabilities reports it.
type boxCapabilities struct {
	Arch      string `json:"arch"`
	MemoryMB  int    `json:"memoryMB"`
	Model     string `json:"model,omitempty"`
	Harnesses bool   `json:"harnesses"`
}

// nodeArch names an architecture as Node's process.arch does.
func nodeArch(goarch string) string {
	switch goarch {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	case "ppc64le":
		return "ppc64"
	case "mipsle":
		return "mipsel"
	}
	return goarch
}

// detectCapabilities reads the board's model where the device tree names it;
// harnesses is false: the Go host runs none, whatever the system.
func detectCapabilities() boxCapabilities {
	model := ""
	if data, err := os.ReadFile("/proc/device-tree/model"); err == nil {
		model = strings.TrimSpace(strings.ReplaceAll(string(data), "\x00", ""))
		if runes := []rune(model); len(runes) > 120 {
			model = string(runes[:120])
		}
	}
	return boxCapabilities{Arch: nodeArch(runtime.GOARCH), MemoryMB: memoryMB(), Model: model}
}

// harnessesUnavailable says in plain words why harnesses can't be turned on.
func harnessesUnavailable(capabilities boxCapabilities) string {
	if capabilities.Arch == "arm64" || capabilities.Arch == "x64" {
		return "This box runs Zirbel’s native host, which has no harnesses. Use your own agent over MCP instead."
	}
	return "Claude Code and Codex aren’t made for this box’s " + capabilities.Arch + " system. Use your own agent over MCP instead."
}

// roomyMB is the memory under which, as in Node's box settings, the TV starts
// off: its browser needs room beside the host (a 2 GB board reports a little
// less).
const roomyMB = 1536

// tvByDefault: the TV starts on only on a 64-bit box with the memory for it.
func tvByDefault(capabilities boxCapabilities) bool {
	return capabilities.Arch == "arm64" && capabilities.MemoryMB >= roomyMB
}

// BoxSettings keeps the switches, read once and written on every change.
type BoxSettings struct {
	mu     sync.Mutex
	file   string
	cached *boxSwitches
	// tv is the TV switch on a new box (tvByDefault).
	tv bool
}

func NewBoxSettings(folder string) (*BoxSettings, error) {
	if err := privateDirectory(folder); err != nil {
		return nil, err
	}
	return &BoxSettings{file: filepath.Join(folder, "settings.json")}, nil
}

var errSettingsUnreadable = fail(http.StatusInternalServerError, "The box settings could not be read.")

func (s *BoxSettings) Read() (boxSwitches, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.read()
}

func (s *BoxSettings) read() (boxSwitches, error) {
	if s.cached != nil {
		return *s.cached, nil
	}
	data, err := os.ReadFile(s.file)
	if errors.Is(err, os.ErrNotExist) {
		// Harnesses start off: there are none in this host.
		defaults := boxSwitches{Version: 1, TV: s.tv}
		s.cached = &defaults
		return defaults, nil
	}
	if err != nil {
		return boxSwitches{}, err
	}
	var switches boxSwitches
	// Every key but ownNetwork and tv, which settings from before them lack; none null.
	switches.TV = s.tv
	if strictKeys(data, "version", "harnesses", "externalMcp", "onboarded", "setupRequested", "ownNetwork", "tv") != nil ||
		json.Unmarshal(data, &switches) != nil || switches.Version != 1 || hasNull(data) ||
		!allKeys(data, "version", "harnesses", "externalMcp", "onboarded", "setupRequested") {
		return boxSwitches{}, errSettingsUnreadable
	}
	s.cached = &switches
	return switches, nil
}

// Update applies a change and writes the switches.
func (s *BoxSettings) Update(change func(*boxSwitches)) (boxSwitches, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switches, err := s.read()
	if err != nil {
		return boxSwitches{}, err
	}
	change(&switches)
	data, err := json.Marshal(switches)
	if err == nil {
		err = atomicWrite(s.file, data)
	}
	if err != nil {
		return boxSwitches{}, err
	}
	s.cached = &switches
	return switches, nil
}

// allKeys reports whether a JSON object has every key, as a Zod object
// requires each of its fields.
func allKeys(data []byte, keys ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return false
	}
	for _, key := range keys {
		raw, ok := fields[key]
		if !ok || string(raw) == "null" {
			return false
		}
	}
	return true
}
