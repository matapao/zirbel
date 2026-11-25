//go:build darwin

package main

import (
	"encoding/binary"
	"math"
	"syscall"
)

// memoryMB is the system's memory in MiB, as Node's os.totalmem() reports it on
// macOS: hw.memsize, a 64-bit count of bytes (Sysctl drops its last zero byte).
func memoryMB() int {
	raw, err := syscall.Sysctl("hw.memsize")
	if err != nil || len(raw) > 8 {
		return 0
	}
	bytes := make([]byte, 8)
	copy(bytes, raw)
	return int(math.Round(float64(binary.LittleEndian.Uint64(bytes)) / 1048576))
}
