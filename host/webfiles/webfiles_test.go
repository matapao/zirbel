package webfiles

import (
	"bytes"
	"compress/gzip"
	"io"
	"testing"
)

func TestAddonServesOnlyTheEmbeddedFiles(t *testing.T) {
	for _, name := range []string{"", "/loaders/GLTFLoader.js", "../three.module.js", "loaders/../loaders/GLTFLoader.js",
		"loaders", "libs/draco/README.md", "loaders/GLTFLoader.js.gz"} {
		if Addon(name) != nil {
			t.Errorf("%q was served", name)
		}
	}
	file := Addon("loaders/GLTFLoader.js")
	if file == nil {
		t.Skip("three.js's addons are not embedded: run `pnpm build && pnpm build:host`")
	}
	if Addon("loaders/GLTFLoader.js") != file {
		t.Error("a second request read the file again")
	}
	if !bytes.Contains(file.Bytes, []byte("class GLTFLoader")) || file.ETag == "" || len(file.Hash) != 64 {
		t.Fatal("the addon was not unpacked and hashed")
	}
	// Sent gzipped as embedded, and that gzip is the same file.
	reader, err := gzip.NewReader(bytes.NewReader(file.Gzip()))
	if err != nil {
		t.Fatal(err)
	}
	unpacked, err := io.ReadAll(reader)
	if err != nil || !bytes.Equal(unpacked, file.Bytes) {
		t.Fatal("the gzip does not hold the addon")
	}
	// As in runtime-files.ts: text and WebAssembly over 1 KB go gzipped, and smaller files as they are.
	for name, gzipped := range map[string]bool{"libs/draco/draco_decoder.wasm": true, "loaders/RGBELoader.js": false} {
		addon := Addon(name)
		if addon == nil || (addon.Gzip() != nil) != gzipped {
			t.Errorf("%s: served %v, gzipped %v", name, addon != nil, addon != nil && addon.Gzip() != nil)
		}
	}
}
