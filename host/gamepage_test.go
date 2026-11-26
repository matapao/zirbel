package main

import (
	"strings"
	"testing"
)

// The policy and import map every game gets, as test/helpers.ts writes them
// out for game-page.ts.
func TestEveryGameGetsTheSameSandbox(t *testing.T) {
	runtime, base := "http://h/runtime/r/", "http://h/game/r/key/"
	addons := runtime + "three/addons/"
	want := "sandbox allow-scripts allow-pointer-lock; default-src 'none'; " +
		"script-src 'unsafe-inline' 'wasm-unsafe-eval' " + base + " " + runtime + "game-sdk.js " + runtime + "three.module.js " + addons + "; " +
		"style-src 'unsafe-inline' " + base + "; img-src data: blob: " + base + "; media-src data: blob: " + base + "; font-src data: " + base + "; " +
		"connect-src " + base + " " + addons + " data: blob:; worker-src " + base + " blob:; frame-src 'none'; form-action 'none'; base-uri 'none'; " +
		"frame-ancestors 'self'"
	imports := `<script type="importmap">{"imports":{"three":"` + runtime + `three.module.js","three/addons/":"` + addons + `"}}</script>`
	for name, game := range map[string]*Game{
		"document": {HTML: "<canvas></canvas>", MaxPlayers: 1},
		"folder":   {HTML: "<!doctype html><script type=module src=./main.js></script>", MaxPlayers: 1, Files: map[string]string{"main.js": "x"}},
	} {
		policy, html := gamePage(&Release{Game: game}, runtime, "'self'", base)
		if policy != want {
			t.Errorf("%s policy:\n got %s\nwant %s", name, policy, want)
		}
		if !strings.Contains(html, imports) {
			t.Errorf("%s import map missing from %s", name, html)
		}
	}
}

func TestGameFilesOfferModelsTexturesShadersAndSourceAsData(t *testing.T) {
	for name, want := range map[string]string{
		"model.obj": "model/obj", "model.mtl": "model/mtl", "model.fbx": "application/octet-stream",
		"sky.hdr": "image/vnd.radiance", "sky.exr": "image/x-exr",
		"shader.glsl": "text/plain; charset=utf-8", "shader.vert": "text/plain; charset=utf-8", "shader.frag": "text/plain; charset=utf-8",
		"src/main.ts": "text/plain; charset=utf-8", "src/app.tsx": "text/plain; charset=utf-8", "src/app.jsx": "text/plain; charset=utf-8",
	} {
		if got := gameFileType(name); got != want {
			t.Errorf("%s: got %s, want %s", name, got, want)
		}
	}
}
