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
	"io/fs"
	"path"
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
	for _, chunk := range chunks {
		names = append(names, "chunks/"+chunk.Name())
	}
	files := make(map[string]*File, len(names))
	for _, name := range names {
		data, err := fs.ReadFile(root, name)
		if err != nil {
			return nil, errors.New("the player runtime is missing " + name + "; run `pnpm build:host`")
		}
		sum := sha256.Sum256(data)
		files[name] = &File{Bytes: data, Hash: hex.EncodeToString(sum[:]),
			ETag: `"` + base64.RawURLEncoding.EncodeToString(sum[:]) + `"`}
	}
	go func() {
		for name, file := range files {
			switch path.Ext(name) {
			case ".js", ".css", ".html", ".txt":
			default:
				continue
			}
			if len(file.Bytes) <= 1024 {
				continue
			}
			var out bytes.Buffer
			writer, _ := gzip.NewWriterLevel(&out, gzip.BestCompression)
			if _, err := writer.Write(file.Bytes); err != nil || writer.Close() != nil {
				continue
			}
			data := out.Bytes()
			file.gzip.Store(&data)
		}
	}()
	return files, nil
}
