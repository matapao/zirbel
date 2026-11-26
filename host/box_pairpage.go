package main

import (
	"errors"
	"html"
	"io"
	"mime"
	"net/http"
	"net/url"
	"unicode/utf8"
)

// The box's pairing page (--box), /pair, mirroring pairRoute in
// packages/server/box-routes.ts: where a device on the box's network pairs
// with a one-time code, or claims a box no device has paired with yet. The
// door (box_routes.go) sends it here before any session is checked.

// pairRoute is the pairing page: a code, or while no device has ever paired, a one-click claim.
func (b *Box) pairRoute(w http.ResponseWriter, r *http.Request, address string) error {
	if r.Method == http.MethodGet {
		_, paired, err := b.pairing.Session(r.Header.Get("cookie"))
		if err != nil {
			return err
		}
		if paired {
			redirect(w, "/")
			return nil
		}
		claimable, err := b.pairing.Claimable()
		if err != nil {
			return err
		}
		pairPage(w, http.StatusOK, claimable, normalizeCode(r.URL.Query().Get("code")), "")
		return nil
	}
	if r.Method != http.MethodPost {
		return fail(http.StatusMethodNotAllowed, "Open the pairing page.")
	}
	if err := checkOrigin(r, true); err != nil {
		return err
	}
	typed := ""
	editing := editorToken(r.Header.Get("cookie")) != ""
	token, err := func() (string, error) {
		form, err := pairForm(r)
		if err != nil {
			return "", err
		}
		typed = form.Get("code")
		agent := r.Header.Get("user-agent")
		var token string
		if form.Has("claim") {
			token, err = b.pairing.Claim(agent)
		} else {
			token, err = b.pairing.Redeem(typed, address, agent)
		}
		// A device is an owner or an editor, not both: an editor that pairs is an owner from now on.
		if err == nil && editing {
			err = b.editors.End(r.Header.Get("cookie"))
		}
		return token, err
	}()
	if err != nil {
		var known *HTTPError
		status, message := http.StatusInternalServerError, "The server could not complete that request."
		if errors.As(err, &known) {
			status, message = known.Status, known.Message
		}
		claimable, readErr := b.pairing.Claimable()
		if readErr != nil {
			return readErr
		}
		pairPage(w, status, claimable, normalizeCode(typed), message)
		return nil
	}
	w.Header().Set("set-cookie", sessionCookie+"="+token+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000")
	if editing {
		w.Header().Add("set-cookie", endEditorCookie)
	}
	redirect(w, "/")
	return nil
}

// pairForm reads the pairing form as Node's pairForm does: at most 1024
// characters, and only code (up to 40 characters) and claim ("1").
func pairForm(r *http.Request) (url.Values, error) {
	if media, _, _ := mime.ParseMediaType(r.Header.Get("content-type")); media != "application/x-www-form-urlencoded" {
		return nil, fail(http.StatusUnsupportedMediaType, "Send the pairing form.")
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 4*1024+1))
	if err != nil || utf16Length(string(data)) > 1024 {
		return nil, fail(http.StatusRequestEntityTooLarge, "The pairing form is too long.")
	}
	form, err := url.ParseQuery(string(data))
	if err != nil {
		return nil, fail(http.StatusBadRequest, "Invalid input")
	}
	for key, values := range form {
		value := values[len(values)-1] // the last one, as Object.fromEntries keeps it
		switch {
		case key == "code" && utf8.RuneCountInString(value) <= 40: // Zod counts code points
		case key == "claim" && value == "1":
		case key == "code":
			return nil, fail(http.StatusBadRequest, "code · Too big: expected string to have <=40 characters")
		case key == "claim":
			return nil, fail(http.StatusBadRequest, "claim · Invalid input: expected \"1\"")
		default:
			return nil, fail(http.StatusBadRequest, "Unrecognized key: \""+key+"\"")
		}
		form.Set(key, value)
	}
	return form, nil
}

// pairPage writes the pairing page as the Node editor does. Its values are
// escaped by html.EscapeString, which writes &amp;, &lt; and &gt; where Node
// writes numeric references: the page with a code is the same character for
// character, and an error with one of those characters says the same.
func pairPage(w http.ResponseWriter, status int, claimable bool, code, problem string) {
	claim := ""
	if claimable {
		claim = `<form method="post"><input type="hidden" name="claim" value="1">
    <p>No device is paired with this box yet. The first one to claim it can pair others.</p>
    <button>Claim this box</button></form><p class="or">or pair with a code</p>`
	}
	alert := ""
	if problem != "" {
		alert = `<p class="error" role="alert">` + html.EscapeString(problem) + `</p>`
	}
	html := `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Pair with Zirbel</title><style>body{font:16px system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.2rem;color:#1d2b24}
h1{font-size:1.5rem}input,button{font:inherit;padding:.6rem .8rem;border-radius:.5rem;border:1px solid #8a9a90}
input{width:100%;box-sizing:border-box;letter-spacing:.15em;text-transform:uppercase}button{margin-top:.8rem;background:#274336;color:#fff;border:0}
.error{color:#a3271f}.or{color:#5c6b62;margin-top:1.6rem}</style></head><body><h1>Pair this device with Zirbel</h1>
` + alert + claim + `<form method="post">
<label for="code">Pairing code, from a device already paired or the box's setup</label>
<input id="code" name="code" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX" value="` + html.EscapeString(code) + `" required>
<button>Pair this device</button></form></body></html>`
	boxPage(w, status, html)
}
