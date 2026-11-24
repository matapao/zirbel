package main

import (
	"bufio"
	"errors"
	"io"
	"strings"
	"testing"
)

// The stdio MCP bridge skips a line over its limit and keeps reading, like
// the Node bridge; it must not stop serving the agent.
func TestReadLineSkipsOverlongLines(t *testing.T) {
	long := strings.Repeat("x", 100) // past 3 bytes per unit: dropped as it arrives
	wide := strings.Repeat("界", 10)  // 10 UTF-16 units in 30 bytes
	input := bufio.NewReaderSize(strings.NewReader("one\n"+long+"\n"+wide+"\r\ntwo"), 16)
	want := []struct {
		line    string
		skipped bool
	}{{"one", false}, {"", true}, {wide, false}, {"two", false}}
	for i, expected := range want {
		line, skipped, err := readLine(input, 10)
		if err != nil || skipped != expected.skipped || (!skipped && string(line) != expected.line) {
			t.Fatalf("line %d: got %q skipped=%v err=%v", i, line, skipped, err)
		}
	}
	if _, _, err := readLine(input, 10); !errors.Is(err, io.EOF) {
		t.Fatalf("expected the end of input, got %v", err)
	}
}
