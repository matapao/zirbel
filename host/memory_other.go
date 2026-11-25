//go:build !linux && !darwin

package main

// memoryMB is unknown here; a box runs Linux.
func memoryMB() int { return 0 }
