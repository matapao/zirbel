//go:build !windows

package main

import (
	"os"
	"syscall"
)

// ownedByMe reports whether this user owns a file, as account.ts checks its uid.
func ownedByMe(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Getuid()
}
