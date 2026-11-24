package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// owner matches the service.json written by packages/server/service-lock.ts, so
// the Node editor and this host exclude each other from one data directory.
type owner struct {
	PID    int    `json:"pid"`
	Port   int    `json:"port"`
	Boot   string `json:"boot"`
	Editor bool   `json:"editor"`
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// invalidOwner stands for a claim cut short by a crash or power loss. It is
// stale, so it must not lock the directory until someone deletes it by hand.
var invalidOwner = &owner{Boot: "invalid"}

// errNoClaim means service.json does not exist.
var errNoClaim = errors.New("no service claim")

// recoveryTimeout expires a recovery file left by a process killed mid-recovery.
const recoveryTimeout = 30 * time.Second

func readOwner(file string) (*owner, error) {
	data, err := os.ReadFile(file) // #nosec G304 -- <data>/service.json, a fixed name under the data directory
	if errors.Is(err, os.ErrNotExist) {
		return nil, errNoClaim
	} else if err != nil {
		return nil, err
	}
	var current owner
	if err := json.Unmarshal(data, &current); err != nil || current.PID <= 0 || !uuidPattern.MatchString(current.Boot) {
		return invalidOwner, nil //nolint:nilerr // an unreadable claim is stale, not a failure
	}
	return &current, nil
}

type claim struct {
	owner   bool
	current *owner
	file    string
	self    owner
}

func (c *claim) release() {
	if current, err := readOwner(c.file); err == nil && current.Boot == c.self.Boot {
		_ = os.Remove(c.file)
	}
}

// claimDirectory mirrors claimDirectory in service-lock.ts: an exclusive hard
// link, with serialized recovery of a dead owner's claim.
func claimDirectory(root string, self owner) (*claim, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	file := filepath.Join(root, "service.json")
	temp := filepath.Join(root, "service-"+self.Boot+".tmp")
	data, _ := json.Marshal(self)
	handle, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) // #nosec G304 -- fixed name plus our own boot UUID
	if err != nil {
		return nil, err
	}
	_, err = handle.Write(data)
	if err == nil {
		err = handle.Sync() // the claim must survive a crash right after linking
	}
	if closeErr := handle.Close(); err == nil {
		err = closeErr
	}
	defer func() { _ = os.Remove(temp) }()
	if err != nil {
		return nil, err
	}
	for {
		if err := os.Link(temp, file); err == nil {
			return &claim{owner: true, file: file, self: self}, nil
		} else if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		current, err := readOwner(file)
		if errors.Is(err, errNoClaim) {
			continue // the owner released it; try to link again
		} else if err != nil {
			return nil, err
		}
		// A claim with our own PID but another boot is stale (containers run as PID 1).
		if current != invalidOwner && current.PID != os.Getpid() {
			alive, err := processAlive(current.PID)
			if err != nil {
				return nil, err
			}
			if alive {
				return &claim{owner: false, current: current, file: file, self: self}, nil
			}
		}
		recovery := filepath.Join(root, "recover-"+current.Boot+".json")
		if err := os.Link(temp, recovery); errors.Is(err, os.ErrExist) {
			// The recovery file links the recovering process's claim, so its age is that process's.
			if info, statErr := os.Stat(recovery); statErr == nil && time.Since(info.ModTime()) > recoveryTimeout {
				_ = os.Remove(recovery)
				continue
			}
			return nil, errors.New("another process is recovering the project directory; retry after recovery completes")
		} else if err != nil {
			return nil, err
		}
		if latest, err := readOwner(file); err == nil && latest.Boot == current.Boot {
			_ = os.Remove(file)
		}
		_ = os.Remove(recovery)
	}
}
