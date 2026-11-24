//go:build windows

package main

import "os"

// processAlive reports whether a process can be opened. On Windows,
// os.FindProcess fails for a process that no longer exists.
func processAlive(pid int) (bool, error) {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false, nil
	}
	_ = process.Release()
	return true, nil
}
