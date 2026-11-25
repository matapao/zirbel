//go:build linux

package main

import (
	"math"
	"os"
	"strconv"
	"strings"
)

// memoryMB is the system's memory in MiB, as Node's os.totalmem() reports it on
// Linux: MemTotal from /proc/meminfo. Zero when it can't be read.
func memoryMB() int {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if fields := strings.Fields(line); len(fields) >= 2 && fields[0] == "MemTotal:" {
			kilobytes, err := strconv.ParseFloat(fields[1], 64)
			if err == nil {
				return int(math.Round(kilobytes / 1024))
			}
		}
	}
	return 0
}
