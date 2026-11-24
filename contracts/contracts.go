// Package contracts embeds the JSON Schemas that scripts/contracts.ts generates
// from the Zod schemas in packages/sdk, and validates documents against them.
// Do not edit the generated files by hand; run `pnpm contracts`.
package contracts

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
)

//go:embed *.schema.json
var files embed.FS

// MCPTools is the tools/list catalogue generated from packages/server/mcp.ts.
//
//go:embed mcp-tools.json
var MCPTools []byte

// MCPScene is the Scene app page that read_scene opens in MCP Apps clients.
//
//go:embed mcp-scene.html
var MCPScene string

var (
	once     sync.Once
	compiled map[string]*schema
	loadErr  error
)

func load() {
	entries, err := files.ReadDir(".")
	if err != nil {
		loadErr = err
		return
	}
	compiled = map[string]*schema{}
	for _, entry := range entries {
		data, err := files.ReadFile(entry.Name())
		if err != nil {
			loadErr = err
			return
		}
		raw, err := Decode(data)
		if err != nil {
			loadErr = fmt.Errorf("contract %s: %w", entry.Name(), err)
			return
		}
		root, err := compile(raw, nil)
		if err != nil {
			loadErr = fmt.Errorf("contract %s: %w", entry.Name(), err)
			return
		}
		compiled[strings.TrimSuffix(entry.Name(), ".schema.json")] = root
	}
}

// Decode parses JSON the way the validator expects: numbers stay exact
// (json.Number) and trailing data is an error.
func Decode(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	// More() reports false before a stray } or ], so ask for the next token.
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after the JSON value")
	}
	return value, nil
}

// Unmarshal fills out from a value Decode returned, as JavaScript reads the
// same JSON: Decode keeps the last of duplicate keys, and every number is a
// double, so 2.0 fills an integer field and -0 is 0.
func Unmarshal(value, out any) error {
	var data bytes.Buffer
	encoder := json.NewEncoder(&data)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(doubles(value)); err != nil {
		return err
	}
	return json.Unmarshal(data.Bytes(), out)
}

func doubles(value any) any {
	switch v := value.(type) {
	case json.Number:
		f, _ := v.Float64()
		if f == 0 {
			return 0.0 // JSON.stringify writes -0 as 0
		}
		return f
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = doubles(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = doubles(item)
		}
		return out
	}
	return value
}

// Equal compares values from Decode as parsed JSON: object key order does not
// matter and numbers compare by value.
func Equal(a, b any) bool { return equal(a, b) }

// Validate checks a value from Decode against a named contract, such as
// "release", and reports the first failure as "path · message".
func Validate(name string, value any) error {
	once.Do(load)
	if loadErr != nil {
		return loadErr
	}
	root := compiled[name]
	if root == nil {
		return fmt.Errorf("unknown contract %q", name)
	}
	if err := root.validate(value, nil); err != nil {
		return err
	}
	return nil
}
