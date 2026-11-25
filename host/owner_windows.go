//go:build windows

package main

import "os"

// ownedByMe: Windows has no uid; account.ts skips the check there too.
func ownedByMe(os.FileInfo) bool { return true }
