package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

// The per-user account folder, mirroring packages/server/account.ts: a box's
// paired devices and switches live here, never in the project data folder.

var errNotPrivate = errors.New("zirbel account storage must be a private directory owned by this user")

// accountDirectory is the folder account.ts names: ZIRBEL_ACCOUNT_DIR, else
// Zirbel in the platform's per-user configuration folder.
func accountDirectory() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	config := firstOf(os.Getenv("XDG_CONFIG_HOME"), filepath.Join(home, ".config"))
	switch runtime.GOOS {
	case "darwin":
		config = filepath.Join(home, "Library", "Application Support")
	case "windows":
		config = firstOf(os.Getenv("LOCALAPPDATA"), filepath.Join(home, "AppData", "Local"))
	}
	directory := firstOf(os.Getenv("ZIRBEL_ACCOUNT_DIR"), filepath.Join(config, "Zirbel"))
	if !filepath.IsAbs(directory) {
		return "", errors.New("zirbel account storage requires an absolute path")
	}
	return directory, nil
}

// privateDirectory makes a folder only this user may use; one that isn't
// private and theirs is refused, as privateDirectory in account.ts does.
func privateDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || !ownedByMe(info) || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return errNotPrivate
	}
	return nil
}
