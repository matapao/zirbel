//go:build !windows

package main

import (
	"errors"
	"syscall"
)

// processAlive treats only "no such process" as dead, like the Node host.
func processAlive(pid int) (bool, error) {
	err := syscall.Kill(pid, 0)
	if err == nil || errors.Is(err, syscall.EPERM) {
		return true, nil
	}
	if errors.Is(err, syscall.ESRCH) {
		return false, nil
	}
	return false, err
}
