package main

import (
	"cmp"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"unicode/utf8"

	"zirbel/contracts"
)

// The box's edit page (--box), /edit, mirroring editRoute in
// packages/server/box-routes.ts: where a device on the box's network redeems a
// game's edit code, with a name the owner sees it by. The door
// (box_routes.go) sends it here before any session is checked, as /pair.

// errEditorOwns: the box itself and its paired devices own it, and a device holds one kind of session at a time.
var errEditorOwns = fail(http.StatusConflict, "This device owns the box and edits every game already. Use another device to edit with a code.")

// editLanding is where a device goes once it edits a game: the editor, which opens that game.
const editLanding = "/"

// editRoute is the edit page: a code and a name. A device that owns the box,
// the box itself (local) or a paired device, has no need of one.
func (b *Box) editRoute(w http.ResponseWriter, r *http.Request, address string, local bool) error {
	if r.Method == http.MethodGet {
		editPage(w, http.StatusOK, shownEditCode(normalizeEditCode(r.URL.Query().Get("code"))), "", "")
		return nil
	}
	if r.Method != http.MethodPost {
		return fail(http.StatusMethodNotAllowed, "Open the edit page.")
	}
	if err := checkOrigin(r, true); err != nil {
		return err
	}
	typed, name := "", ""
	token, err := func() (string, error) {
		form, err := editForm(r)
		if err != nil {
			return "", err
		}
		typed, name = form.Get("code"), form.Get("name")
		if local {
			return "", errEditorOwns
		}
		if _, owner, err := b.pairing.Session(r.Header.Get("cookie")); err != nil || owner {
			return "", cmp.Or(err, errEditorOwns)
		}
		token, _, err := b.editors.Redeem(typed, contracts.Trim(name), address, r.Header.Get("cookie"))
		return token, err
	}()
	if err != nil {
		status, message := http.StatusInternalServerError, "The server could not complete that request."
		if known, ok := errors.AsType[*HTTPError](err); ok {
			status, message = known.Status, known.Message
		}
		editPage(w, status, shownEditCode(normalizeEditCode(typed)), name, message)
		return nil
	}
	w.Header().Set("set-cookie", editorCookie+"="+token+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000")
	redirect(w, editLanding)
	return nil
}

// editForm reads the edit form as Node's editForm does: at most 1024
// characters (UTF-16 units, as Node reads the form), a code of up to 40
// characters and a name of 1 to 24 once trimmed (code points, as Zod counts),
// and nothing else; Zod's issues, up to three.
func editForm(r *http.Request) (url.Values, error) {
	if media, _, _ := mime.ParseMediaType(r.Header.Get("content-type")); media != "application/x-www-form-urlencoded" {
		return nil, fail(http.StatusUnsupportedMediaType, "Send the edit form.")
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 4*1024+1))
	if err != nil || utf16Length(string(data)) > 1024 {
		return nil, fail(http.StatusRequestEntityTooLarge, "The edit form is too long.")
	}
	form, err := url.ParseQuery(string(data))
	if err != nil {
		return nil, fail(http.StatusBadRequest, "Invalid input")
	}
	for key, values := range form {
		form.Set(key, values[len(values)-1]) // the last one, as Object.fromEntries keeps it
	}
	issues := []string{}
	if !form.Has("code") {
		issues = append(issues, "code · Invalid input: expected string, received undefined")
	} else if utf8.RuneCountInString(form.Get("code")) > 40 {
		issues = append(issues, "code · Too big: expected string to have <=40 characters")
	}
	name := contracts.Trim(form.Get("name"))
	switch {
	case !form.Has("name"):
		issues = append(issues, "name · Invalid input: expected string, received undefined")
	case name == "":
		issues = append(issues, "name · Too small: expected string to have >=1 characters")
	case utf8.RuneCountInString(name) > editorNameLength:
		issues = append(issues, "name · Too big: expected string to have <=24 characters")
	}
	unknown := []string{}
	for key := range form {
		if key != "code" && key != "name" {
			unknown = append(unknown, `"`+key+`"`)
		}
	}
	slices.Sort(unknown)
	if len(unknown) == 1 {
		issues = append(issues, "Unrecognized key: "+unknown[0])
	} else if len(unknown) > 1 {
		issues = append(issues, "Unrecognized keys: "+strings.Join(unknown, ", "))
	}
	if len(issues) > 0 {
		return nil, fail(http.StatusBadRequest, strings.Join(issues[:min(len(issues), 3)], " · "))
	}
	return form, nil
}

// nodeEscape escapes text for HTML as the Node editor's pages do: numeric references.
var nodeEscape = strings.NewReplacer("&", "&#38;", "<", "&#60;", ">", "&#62;", `"`, "&#34;", "'", "&#39;")

// editPage writes the edit page as the Node editor does.
func editPage(w http.ResponseWriter, status int, code, name, problem string) {
	alert := ""
	if problem != "" {
		alert = `<p class="error" role="alert">` + nodeEscape.Replace(problem) + `</p>`
	}
	html := `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Edit a game on Zirbel</title><style>body{font:16px system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.2rem;color:#1d2b24}
h1{font-size:1.5rem}label{display:block;margin-top:1rem}input,button{font:inherit;padding:.6rem .8rem;border-radius:.5rem;border:1px solid #8a9a90}
input{width:100%;box-sizing:border-box}#code{letter-spacing:.15em;text-transform:uppercase}button{margin-top:.8rem;background:#274336;color:#fff;border:0}
.error{color:#a3271f}</style></head><body><h1>Edit a game on this Zirbel</h1>
` + alert + `<form method="post">
<label for="code">Edit code, from the box's owner</label>
<input id="code" name="code" autocomplete="off" autocapitalize="characters" placeholder="XXX-XXX" value="` + nodeEscape.Replace(code) + `" required>
<label for="name">Your name, as the owner sees this device</label>
<input id="name" name="name" autocomplete="nickname" maxlength="24" value="` + nodeEscape.Replace(name) + `" required>
<button>Start editing</button></form></body></html>`
	boxPage(w, status, html)
}

// boxPage writes one of the box's own pages, /pair and /edit, with their headers.
func boxPage(w http.ResponseWriter, status int, html string) {
	header := w.Header()
	header.Set("content-type", "text/html; charset=utf-8")
	header.Set("cache-control", "no-store")
	// A form posted under no-referrer carries the origin "null": this page's own forms carry its origin.
	header.Set("referrer-policy", "same-origin")
	header.Set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.WriteHeader(status)
	// Not XSS: every value in the page is escaped, and the page has its own CSP.
	// nosemgrep: go.lang.security.audit.xss.no-direct-write-to-responsewriter.no-direct-write-to-responsewriter
	_, _ = w.Write([]byte(html)) // #nosec G705 -- every value in the page is escaped, and the page has its own CSP
}
