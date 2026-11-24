package main

import (
	"bytes"
	"compress/gzip"
	"errors"
	"net/http"
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

// gamePage mirrors packages/server/game-page.ts.
func gamePage(release *Release, runtime, ancestors string) (policy, html string) {
	assets := map[string]string{}
	for _, asset := range release.Manifest.Assets {
		assets[asset.ID] = "data:" + asset.Media + ";base64," + release.Assets[asset.Hash]
	}
	policy = strings.Join([]string{
		"sandbox allow-scripts", "default-src 'none'",
		"script-src 'unsafe-inline' " + runtime + "game-sdk.js " + runtime + "three.module.js",
		"style-src 'unsafe-inline'", "img-src data: blob:", "media-src data: blob:", "font-src data:",
		"connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'",
		"frame-ancestors " + ancestors,
	}, "; ")
	registration := ""
	if game := release.Game; game.RegisterObjects != nil && !*game.RegisterObjects {
		registration = ` data-registration="off"`
	}
	bootstrap := `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<script type="importmap">` + scriptJSON(map[string]any{"imports": map[string]string{"three": runtime + "three.module.js"}}) + `</script>` +
		`<script type="application/json" id="zirbel-assets"` + registration + `>` + scriptJSON(assets) + `</script>` +
		`<script crossorigin="anonymous" src="` + runtime + `game-sdk.js"></script>`
	return policy, "<!doctype html>" + bootstrap + doctype.ReplaceAllString(release.Game.HTML, "")
}
func (l *Listener) serveGame(w http.ResponseWriter, r *http.Request, room *Room) error {
	origin := "http://" + r.Host
	value, _ := room.gamePages.LoadOrStore(origin, &gamePageEntry{})
	entry, ok := value.(*gamePageEntry)
	if !ok {
		return errors.New("the game page cache holds an unexpected value")
	}
	entry.once.Do(func() {
		policy, html := gamePage(room.Release, origin+"/runtime/"+room.ID+"/", l.ancestors())
		var out bytes.Buffer
		writer := gzip.NewWriter(&out)
		_, _ = writer.Write([]byte(html))
		_ = writer.Close()
		entry.policy, entry.html, entry.gzip = policy, []byte(html), out.Bytes()
	})
	w.Header().Set("content-security-policy", entry.policy)
	w.Header().Set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
	if !acceptsGzip(r) {
		bytesReply(w, entry.html, typeFor(".html"), nil)
		return nil
	}
	bytesReply(w, entry.gzip, typeFor(".html"), map[string]string{"content-encoding": "gzip", "vary": "accept-encoding"})
	return nil
}
