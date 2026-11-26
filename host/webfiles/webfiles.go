// Package webfiles embeds the player runtime built by `pnpm build`, so the
// host ships as one binary. `pnpm build:host` copies the files into web/.
package webfiles

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"path"
	"sync"
	"sync/atomic"
)

//go:embed all:web
var embedded embed.FS

// Fixed mirrors the runtime list in packages/core/releases.ts. Every file in
// chunks/ is also part of the runtime, as in the Node host.
var Fixed = []string{
	"player.html", "player.js", "garden-3d.js", "garden-3d.js.LEGAL.txt", "player.css",
	"game-sdk.js", "three.module.js", "three-license.txt", "zod-license.txt",
}

// EditorFixed are the editor's own files (http.ts editorFiles), plus every
// file in editor-chunks/. They are served only on the loopback editor port.
var EditorFixed = []string{"index.html", "workspace.js", "workspace.css", "favicon.svg"}

// LoadEditor reads the embedded editor UI.
func LoadEditor() (map[string][]byte, error) {
	root, err := fs.Sub(embedded, "web")
	if err != nil {
		return nil, err
	}
	names := append([]string{}, EditorFixed...)
	if chunks, err := fs.ReadDir(root, "editor-chunks"); err == nil {
		for _, chunk := range chunks {
			names = append(names, "editor-chunks/"+chunk.Name())
		}
	}
	files := map[string][]byte{}
	for _, name := range names {
		data, err := fs.ReadFile(root, name)
		if err != nil {
			return nil, errors.New("the editor is missing " + name + "; run `pnpm build:host`")
		}
		files[name] = data
	}
	return files, nil
}

type File struct {
	Bytes []byte
	Hash  string // hex SHA-256, as in release manifests
	ETag  string
	gzip  atomic.Pointer[[]byte]
}

// Gzip returns the compressed body once it is ready, or nil.
func (f *File) Gzip() []byte {
	if data := f.gzip.Load(); data != nil {
		return *data
	}
	return nil
}

// newFile mirrors runtimeEntry in packages/server/runtime-files.ts.
func newFile(data []byte) *File {
	sum := sha256.Sum256(data)
	return &File{Bytes: data, Hash: hex.EncodeToString(sum[:]), ETag: `"` + base64.RawURLEncoding.EncodeToString(sum[:]) + `"`}
}

// compressible mirrors runtime-files.ts: text and WebAssembly over 1 KB are sent gzipped.
func compressible(name string, size int) bool {
	switch path.Ext(name) {
	case ".js", ".css", ".html", ".txt", ".wasm":
		return size > 1024
	}
	return false
}

// addons holds the three.js addon files read so far, by name.
var addons sync.Map

// Addon returns three.js's addon file at name (three/examples/jsm/<name>),
// or nil. It mirrors threeAddons in runtime-files.ts. The build embeds each
// gzipped, and a game uses a few of the hundreds there, so each is unpacked
// on its first request and kept.
func Addon(name string) *File {
	if cached, ok := addons.Load(name); ok {
		if file, ok := cached.(*File); ok {
			return file
		}
	}
	if !fs.ValidPath(name) {
		return nil
	}
	packed, err := fs.ReadFile(embedded, "web/three/addons/"+name+".gz")
	if err != nil {
		return nil
	}
	reader, err := gzip.NewReader(bytes.NewReader(packed))
	if err != nil {
		return nil
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		return nil
	}
	file := newFile(data)
	if compressible(name, len(data)) {
		file.gzip.Store(&packed)
	}
	stored, _ := addons.LoadOrStore(name, file)
	if kept, ok := stored.(*File); ok {
		return kept
	}
	return file
}

// Load reads the embedded runtime and starts compressing it in the background.
func Load() (map[string]*File, error) {
	root, err := fs.Sub(embedded, "web")
	if err != nil {
		return nil, err
	}
	names := append([]string{}, Fixed...)
	chunks, err := fs.ReadDir(root, "chunks")
	if err != nil {
		return nil, errors.New("the player runtime is missing; run `pnpm build:host`")
	}
	if _, err := fs.Stat(root, "three/addons/loaders/GLTFLoader.js.gz"); err != nil {
		return nil, errors.New("the player runtime is missing three/addons; run `pnpm build:host`")
	}
	for _, chunk := range chunks {
		names = append(names, "chunks/"+chunk.Name())
	}
	files := make(map[string]*File, len(names))
	for _, name := range names {
		data, err := fs.ReadFile(root, name)
		if err != nil {
			return nil, errors.New("the player runtime is missing " + name + "; run `pnpm build:host`")
		}
		files[name] = newFile(data)
	}
	go func() {
		for name, file := range files {
			compress(name, file)
		}
	}()
	return files, nil
}

// compress keeps a compressible file's gzip beside it.
func compress(name string, file *File) {
	if !compressible(name, len(file.Bytes)) {
		return
	}
	var out bytes.Buffer
	writer, _ := gzip.NewWriterLevel(&out, gzip.BestCompression)
	if _, err := writer.Write(file.Bytes); err != nil || writer.Close() != nil {
		return
	}
	data := out.Bytes()
	file.gzip.Store(&data)
}

// LobbyFiles are the lobby's page and what it loads, the TV page's (/tv) and
// the pad page's (/pad), which every player listener serves beside its rooms:
// the host's own, not a release's runtime.
var LobbyFiles = []string{"lobby.html", "lobby.js", "lobby.css", "tv.html", "tv.js", "tv.css", "pad.html", "pad.js", "pad.css"}

// Lobby holds the lobby files the build has, by name.
var Lobby = sync.OnceValue(func() map[string]*File {
	files := map[string]*File{}
	for _, name := range LobbyFiles {
		if data, err := fs.ReadFile(embedded, "web/"+name); err == nil {
			files[name] = newFile(data)
			compress(name, files[name])
		}
	}
	return files
})

// Manifest is Zirbel's skalet.json, the listeners and spaces block of the
// spaces kernel the host runs (spaces.go), or nil when the build has none.
var Manifest = sync.OnceValue(func() *File { return hostFile("skalet.json") })

// Guide is one of the guides the editor's MCP server gives agents as
// resources (mcp-guides/<name>.md, put together by scripts/build.mjs), or nil
// when the build has none.
func Guide(name string) []byte {
	if !fs.ValidPath(name) {
		return nil
	}
	data, err := fs.ReadFile(embedded, "web/mcp-guides/"+name+".md")
	if err != nil {
		return nil
	}
	return data
}

// hostFile is one of the host's own files, or nil when the build has none.
func hostFile(name string) *File {
	data, err := fs.ReadFile(embedded, "web/"+name)
	if err != nil {
		return nil
	}
	file := newFile(data)
	compress(name, file)
	return file
}
