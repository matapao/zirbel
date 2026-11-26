package main

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// scriptJSON mirrors game-page.ts: JSON inside <script> with every "<" escaped,
// so no value can close the tag.
func scriptJSON(value any) string {
	data, _ := jsJSON(value)
	return strings.ReplaceAll(string(data), "<", "\\u003c")
}

// gamePageEntry holds one room's page for one origin. The page inlines every
// asset (possibly tens of MB), so it is built and compressed once.
type gamePageEntry struct {
	once   sync.Once
	policy string
	html   []byte
	gzip   []byte
}

// gamePath is the game document's own address; a built game's files sit beside it.
func gamePath(room *Room) string { return "/game/" + room.ID + "/" + room.DocumentKey + "/" }

// threeAddons mirrors THREE_ADDONS in game-page.ts: three.js's addons, served
// from the host's own build beside three.module.js (webfiles.Addon).
const threeAddons = "three/addons/"

// gamePage mirrors packages/server/game-page.ts. base is the document's own
// address: a game imported as a built folder loads its files from beside it,
// and only those. Every game gets the same policy: WebAssembly, workers and
// loaders reading data: and blob: URLs, and no other origin anywhere.
func gamePage(release *Release, runtime, ancestors, base string) (policy, html string) {
	assets := map[string]string{}
	for _, asset := range release.Manifest.Assets {
		assets[asset.ID] = "data:" + asset.Media + ";base64," + release.Assets[asset.Hash]
	}
	addons := runtime + threeAddons
	scripts := "script-src 'unsafe-inline' 'wasm-unsafe-eval' " + base + " " + runtime + "game-sdk.js " + runtime + "three.module.js " + addons
	// Loaders turn embedded data into blob: and data: URLs and read them back, and fetch the decoders
	// the addons ship with (Draco, Basis); none of it reaches the network.
	connects := "connect-src " + base + " " + addons + " data: blob:"
	// A game with its own netcode also loads zirbel-net and reaches the relay, both on this listener.
	if isNet(release.Manifest.Simulation) {
		origin, relay := netOrigins(base)
		scripts += " " + origin + "/zirbel-net.js"
		connects += " " + relay + "/mp"
	}
	policy = strings.Join([]string{
		"sandbox allow-scripts", "default-src 'none'", scripts,
		"style-src 'unsafe-inline' " + base, "img-src data: blob: " + base, "media-src data: blob: " + base, "font-src data: " + base,
		connects, "worker-src " + base + " blob:",
		"frame-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors " + ancestors,
	}, "; ")
	registration := ""
	if game := release.Game; game.RegisterObjects != nil && !*game.RegisterObjects {
		registration = ` data-registration="off"`
	}
	// encoding/json sorts the keys, which puts them in game-page.ts's order: "three", then "three/addons/".
	imports := map[string]string{"three": runtime + "three.module.js", threeAddons: addons}
	bootstrap := `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<script type="importmap">` + scriptJSON(map[string]any{"imports": imports}) + `</script>` +
		`<script type="application/json" id="zirbel-assets"` + registration + `>` + scriptJSON(assets) + `</script>` +
		`<script crossorigin="anonymous" src="` + runtime + `game-sdk.js"></script>`
	return policy, "<!doctype html>" + bootstrap + doctype.ReplaceAllString(release.Game.HTML, "")
}

// netOrigins are the origin of the game page's base and that origin's
// WebSocket twin (http: to ws:, https: to wss:).
func netOrigins(base string) (origin, relay string) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", ""
	}
	origin = parsed.Scheme + "://" + parsed.Host
	if rest, ok := strings.CutPrefix(origin, "http"); ok {
		relay = "ws" + rest
	}
	return origin, relay
}

// serveGame serves the game document, or the built game's file at file.
func (l *Listener) serveGame(w http.ResponseWriter, r *http.Request, room *Room, file string) error {
	origin := "http://" + r.Host
	value, _ := room.gamePages.LoadOrStore(origin, &gamePageEntry{})
	entry, ok := value.(*gamePageEntry)
	if !ok {
		return errors.New("the game page cache holds an unexpected value")
	}
	entry.once.Do(func() {
		policy, html := gamePage(room.Release, origin+"/runtime/"+room.ID+"/", l.ancestors(hostnameOf(r.Host)), origin+gamePath(room))
		var out bytes.Buffer
		writer := gzip.NewWriter(&out)
		_, _ = writer.Write([]byte(html))
		_ = writer.Close()
		entry.policy, entry.html, entry.gzip = policy, []byte(html), out.Bytes()
	})
	// A file opened on its own stays in the game's sandbox too.
	w.Header().Set("content-security-policy", entry.policy)
	w.Header().Set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
	if file != "" {
		hash, ok := room.Release.Game.Files[file]
		if !ok {
			return fail(http.StatusNotFound, "Game file does not exist.")
		}
		data, err := base64.StdEncoding.DecodeString(room.Release.Assets[hash])
		if err != nil {
			return err
		}
		// The game's origin is opaque, so its module scripts, fonts and fetches are CORS requests.
		bytesReply(w, data, gameFileType(file), map[string]string{"access-control-allow-origin": "*"})
		return nil
	}
	if !acceptsGzip(r) {
		bytesReply(w, entry.html, typeFor(".html"), nil)
		return nil
	}
	bytesReply(w, entry.gzip, typeFor(".html"), map[string]string{"content-encoding": "gzip", "vary": "accept-encoding"})
	return nil
}
