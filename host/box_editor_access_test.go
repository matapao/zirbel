package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// testBoxEditor is an editor in box mode over fresh folders, with two games.
func testBoxEditor(t *testing.T) (s *EditorServer, garden, walk *Project) {
	t.Helper()
	root := t.TempDir()
	projects, err := NewProjects(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	releases, err := NewReleases(filepath.Join(root, "data"), nil)
	if err != nil {
		t.Fatal(err)
	}
	box, err := NewBox(filepath.Join(root, "account"), func() int { return 4173 })
	if err != nil {
		t.Fatal(err)
	}
	rooms := NewRooms()
	t.Cleanup(rooms.Dispose)
	s = &EditorServer{Editor: &Editor{projects: projects, releases: releases}, rooms: rooms, box: box, port: 4173,
		players: &Players{rooms: rooms, local: &Listener{port: 4174}, lanHost: "games.lan"},
		files:   map[string][]byte{"index.html": []byte("<!doctype html><title>Zirbel</title>")}}
	if garden, err = projects.CreateGame("Garden", &Game{HTML: "<canvas></canvas>", MaxPlayers: 1}, ownerIdent); err != nil {
		t.Fatal(err)
	}
	if walk, err = projects.CreateGame("Walk", &Game{HTML: "<canvas></canvas>", MaxPlayers: 1}, ownerIdent); err != nil {
		t.Fatal(err)
	}
	return s, garden, walk
}

const (
	boxHost    = "localhost:4173"
	boxOrigin  = "http://localhost:4173"
	fromBox    = "127.0.0.1:5000"
	fromDevice = "192.168.1.5:5000"
)

var editorCookieText = regexp.MustCompile(`^zirbel_editor=([\w-]{43}); HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000$`)

// redeem posts the edit form from a device, with what it sends besides.
func redeem(t *testing.T, s *EditorServer, code, name string, headers map[string]string) lobbyReply {
	t.Helper()
	form := map[string]string{"content-type": "application/x-www-form-urlencoded", "origin": boxOrigin}
	for key, value := range headers {
		form[key] = value
	}
	return call(t, s, http.MethodPost, boxHost, "/edit", fromDevice, url.Values{"code": {code}, "name": {name}}.Encode(), form)
}

func TestAnEditorWorksOnItsGameAndNothingElse(t *testing.T) {
	s, garden, walk := testBoxEditor(t)
	owner := map[string]string{"origin": boxOrigin}
	made := call(t, s, http.MethodPost, boxHost, "/api/projects/"+garden.ID+"/edit-code", fromBox, "{}", owner)
	var code struct {
		Code, Link, ExpiresAt string
		QR                    *string
	}
	if json.Unmarshal([]byte(made.body), &code) != nil || made.status != http.StatusCreated || code.QR != nil ||
		code.Link != "http://games.lan:4173/edit?code="+strings.ReplaceAll(code.Code, "-", "") {
		t.Fatalf("the edit code: %+v", made)
	}
	page := call(t, s, http.MethodGet, boxHost, "/edit?code="+strings.ToLower(strings.ReplaceAll(code.Code, "-", "")), fromDevice, "", nil)
	if page.status != http.StatusOK || !strings.Contains(page.body, `value="`+code.Code+`"`) ||
		page.header.Get("content-security-policy") == "" || page.header.Get("referrer-policy") != "same-origin" {
		t.Fatalf("the edit page: %+v", page)
	}
	if got := redeem(t, s, code.Code, "Ada", map[string]string{"origin": ""}); got.status != http.StatusForbidden {
		t.Fatalf("a form from elsewhere: %+v", got)
	}
	if got := redeem(t, s, code.Code, "  ", nil); got.status != http.StatusBadRequest || !strings.Contains(got.body, "name · Too small") {
		t.Fatalf("no name: %+v", got)
	}
	redeemed := redeem(t, s, code.Code, " Ada ", nil)
	found := editorCookieText.FindStringSubmatch(redeemed.header.Get("set-cookie"))
	if redeemed.status != http.StatusSeeOther || redeemed.header.Get("location") != "/" || found == nil {
		t.Fatalf("redeeming: %+v", redeemed)
	}
	editor := map[string]string{"cookie": "zirbel_editor=" + found[1], "origin": boxOrigin}
	as := func(method, path, body string) lobbyReply {
		return call(t, s, method, boxHost, path, fromDevice, body, editor)
	}

	if got := as(http.MethodGet, "/api/me", ""); got.body != `{"game":"`+garden.ID+`","role":"editor"}`+"\n" {
		t.Fatalf("who the editor is: %+v", got)
	}
	if got := as(http.MethodGet, "/api/projects", ""); !strings.Contains(got.body, garden.ID) || strings.Contains(got.body, walk.ID) {
		t.Fatalf("the editor's games: %+v", got)
	}
	if got := as(http.MethodGet, "/", ""); got.status != http.StatusOK || !strings.Contains(got.body, "<title>Zirbel</title>") {
		t.Fatalf("the editor's /: %+v", got)
	}
	// A change it saves becomes a revision of the game.
	proposed := as(http.MethodPost, "/api/projects/"+garden.ID+"/proposals", `{"baseRevision":"`+garden.Branches["main"]+
		`","branch":"main","label":"Edit","operations":[{"op":"writeGame","game":{"html":"<canvas id=\"edited\"></canvas>"}}]}`)
	var staged struct{ Proposal struct{ ID string } }
	if json.Unmarshal([]byte(proposed.body), &staged) != nil || proposed.status != http.StatusCreated {
		t.Fatalf("a proposal: %+v", proposed)
	}
	if got := as(http.MethodPost, "/api/projects/"+garden.ID+"/apply/"+staged.Proposal.ID, "{}"); got.status != http.StatusOK {
		t.Fatalf("applying it: %+v", got)
	}
	read, err := s.projects.Read(garden.ID)
	if err != nil {
		t.Fatal(err)
	}
	if read.Branches["main"] == garden.Branches["main"] || len(read.Revisions) != 2 {
		t.Fatalf("the change is no revision: %+v", read.Branches)
	}
	// A change made on a revision that is no longer the game's is refused as the owner's is: the editor refreshes.
	if got := as(http.MethodPost, "/api/projects/"+garden.ID+"/proposals", `{"baseRevision":"`+garden.Branches["main"]+
		`","branch":"main","label":"Stale","operations":[{"op":"writeGame","game":{"html":"<p>stale</p>"}}]}`); got.status != http.StatusConflict {
		t.Fatalf("a proposal on the old revision: %+v", got)
	}
	if got := as(http.MethodGet, "/api/rooms", ""); got.status != http.StatusOK || got.body != "[]\n" {
		t.Fatalf("the editor's rooms: %+v", got)
	}
	for _, refused := range [][2]string{{"GET", "/api/projects/" + walk.ID}, {"POST", "/api/projects/" + walk.ID + "/proposals"},
		{"POST", "/api/projects"}, {"POST", "/api/projects/import-game"}, {"POST", "/api/projects/import"},
		{"POST", "/api/projects/" + garden.ID + "/release"}, {"POST", "/api/projects/" + garden.ID + "/remove"},
		{"POST", "/api/projects/" + garden.ID + "/edit-code"}, {"POST", "/api/projects/" + garden.ID + "/edit-code/stop"},
		{"GET", "/api/projects/" + garden.ID + "/editors"}, {"GET", "/api/releases"}, {"POST", "/api/releases/import"},
		{"POST", "/api/rooms"}, {"POST", "/api/lobby/offer"}, {"GET", "/api/box/settings"}, {"PUT", "/api/box/settings"},
		{"GET", "/api/box/status"}, {"GET", "/api/box/network"}, {"POST", "/api/pairing"}, {"GET", "/api/pairing/devices"},
		{"GET", "/api/processors"}, {"POST", "/api/chat"}, {"GET", "/api/projects/" + garden.ID + "/thread"}} {
		if got := as(refused[0], refused[1], "{}"); got.status != http.StatusForbidden || got.body != `{"error":"This device edits one game only."}`+"\n" {
			t.Errorf("%s %s: %+v", refused[0], refused[1], got)
		}
	}

	// The owner sees who edits, and removes it: its next request is refused.
	listed := call(t, s, http.MethodGet, boxHost, "/api/projects/"+garden.ID+"/editors", fromBox, "", nil)
	var editors struct {
		Code    *editCodeLink
		Editors []editorView
	}
	if json.Unmarshal([]byte(listed.body), &editors) != nil || editors.Code == nil || *editors.Code != (editCodeLink{code.Code, code.Link, code.ExpiresAt}) ||
		len(editors.Editors) != 1 || editors.Editors[0].Name != "Ada" {
		t.Fatalf("the game's editors: %+v", listed)
	}
	if got := call(t, s, http.MethodDelete, boxHost, "/api/projects/"+garden.ID+"/editors/"+editors.Editors[0].ID, fromBox, "", owner); got.status != http.StatusOK || got.body != "{}\n" {
		t.Fatalf("removing the editor: %+v", got)
	}
	const ended = `{"error":"This device’s edit access has ended. Ask the box’s owner for a new edit code."}` + "\n"
	if got := as(http.MethodGet, "/api/projects", ""); got.status != http.StatusUnauthorized || got.body != ended {
		t.Fatalf("a removed editor: %+v", got)
	}
	// Its pages go where any device's do that isn't paired.
	if got := as(http.MethodGet, "/", ""); got.status != http.StatusSeeOther || got.header.Get("location") != "/pair" {
		t.Fatalf("a removed editor's page: %+v", got)
	}
	if got := call(t, s, http.MethodDelete, boxHost, "/api/projects/"+garden.ID+"/editors/"+editors.Editors[0].ID, fromBox, "", owner); got.status != http.StatusNotFound {
		t.Fatalf("removing it again: %+v", got)
	}

	// A stopped code opens nothing; nor does the code of a game that was removed.
	if got := call(t, s, http.MethodPost, boxHost, "/api/projects/"+garden.ID+"/edit-code/stop", fromBox, "{}", owner); got.status != http.StatusOK {
		t.Fatalf("stopping the code: %+v", got)
	}
	if got := redeem(t, s, code.Code, "Ada", nil); got.status != http.StatusForbidden || !strings.Contains(got.body, "That code doesn&#39;t open a game.") ||
		!strings.Contains(got.body, `value="Ada"`) {
		t.Fatalf("a stopped code: %+v", got)
	}
	if got := call(t, s, http.MethodGet, boxHost, "/api/projects/"+garden.ID+"/editors", fromBox, "", nil); got.body != `{"code":null,"editors":[]}`+"\n" {
		t.Fatalf("no code and no editors: %+v", got)
	}
	fresh := call(t, s, http.MethodPost, boxHost, "/api/projects/"+walk.ID+"/edit-code", fromBox, "{}", owner)
	if err := json.Unmarshal([]byte(fresh.body), &code); err != nil {
		t.Fatal(err)
	}
	again := editorCookieText.FindStringSubmatch(redeem(t, s, code.Code, "Ada", nil).header.Get("set-cookie"))
	if again == nil {
		t.Fatal("the walk's code opens nothing")
	}
	if got := call(t, s, http.MethodPost, boxHost, "/api/projects/"+walk.ID+"/remove", fromBox, "{}", owner); got.status != http.StatusOK {
		t.Fatalf("removing the game: %+v", got)
	}
	if got := call(t, s, http.MethodGet, boxHost, "/api/me", fromDevice, "", map[string]string{"cookie": "zirbel_editor=" + again[1]}); got.status != http.StatusUnauthorized ||
		got.body != ended {
		t.Fatalf("an editor of a removed game: %+v", got)
	}
	if got := redeem(t, s, code.Code, "Ada", nil); got.status != http.StatusForbidden {
		t.Fatalf("a removed game's code: %+v", got)
	}
	for path, status := range map[string]int{"/api/projects/missing/edit-code": http.StatusNotFound, "/api/projects/" + garden.ID + "/edit-code/again": http.StatusNotFound} {
		if got := call(t, s, http.MethodPost, boxHost, path, fromBox, "{}", owner); got.status != status {
			t.Errorf("%s: %+v", path, got)
		}
	}
	if got := call(t, s, http.MethodPost, boxHost, "/api/projects/"+garden.ID+"/edit-code", "192.168.1.6:5000", "{}", map[string]string{"cookie": "zirbel_session=x"}); got.status != http.StatusUnauthorized {
		t.Fatalf("a device that isn't paired makes a code: %+v", got)
	}
}

func TestAnOwnerDeviceIsNoEditorAndWhoIsWhoIsToldApart(t *testing.T) {
	s, garden, _ := testBoxEditor(t)
	made := call(t, s, http.MethodPost, boxHost, "/api/projects/"+garden.ID+"/edit-code", fromBox, "{}", map[string]string{"origin": boxOrigin})
	var code struct{ Code string }
	if err := json.Unmarshal([]byte(made.body), &code); err != nil {
		t.Fatal(err)
	}
	token, err := s.box.pairing.Claim("node")
	if err != nil {
		t.Fatal(err)
	}
	owner := map[string]string{"cookie": "zirbel_session=" + token, "origin": boxOrigin}
	if got := redeem(t, s, code.Code, "Ada", owner); got.status != http.StatusConflict || got.header.Get("set-cookie") != "" ||
		!strings.Contains(got.body, "This device owns the box") {
		t.Fatalf("an owner device redeems: %+v", got)
	}
	// So does the box itself, and its tries are no wrong codes.
	form := url.Values{"code": {"ZZZ-ZZZ"}, "name": {"Box"}}.Encode()
	for range wrongSessionCodes + 1 {
		if got := call(t, s, http.MethodPost, boxHost, "/edit", fromBox, form, map[string]string{"content-type": "application/x-www-form-urlencoded",
			"origin": boxOrigin}); got.status != http.StatusConflict || !strings.Contains(got.body, "This device owns the box and edits every game already.") {
			t.Fatalf("the box itself redeems: %+v", got)
		}
	}
	if s.box.editors.wrong.blocked("127.0.0.1") {
		t.Fatal("the box's own tries were counted as wrong codes")
	}

	// An editor that pairs is an owner from then on: its editor's session ends, and its cookie with it.
	editing := editorCookieText.FindStringSubmatch(redeem(t, s, code.Code, "Ada", nil).header.Get("set-cookie"))
	if editing == nil {
		t.Fatal("the code opens nothing")
	}
	pairing, _ := s.box.pairing.CreateCode()
	paired := call(t, s, http.MethodPost, boxHost, "/pair", fromDevice, "code="+pairing, map[string]string{"content-type": "application/x-www-form-urlencoded",
		"origin": boxOrigin, "cookie": "zirbel_editor=" + editing[1]})
	if cookies := paired.header.Values("set-cookie"); paired.status != http.StatusSeeOther || len(cookies) != 2 ||
		!strings.HasPrefix(cookies[0], "zirbel_session=") || cookies[1] != "zirbel_editor=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" {
		t.Fatalf("an editor pairs: %+v", paired)
	}
	if _, still, _ := s.box.editors.Session("zirbel_editor=" + editing[1]); still {
		t.Fatal("an editor that paired still edits")
	}
	pairing, _ = s.box.pairing.CreateCode()
	if cookies := call(t, s, http.MethodPost, boxHost, "/pair", fromDevice, "code="+pairing, map[string]string{"content-type": "application/x-www-form-urlencoded",
		"origin": boxOrigin}).header.Values("set-cookie"); len(cookies) != 1 {
		t.Fatalf("a device that never edited pairs: %v", cookies)
	}
	// An owner's paired device must send its origin for the box's own API, as for pairing.
	if got := call(t, s, http.MethodPost, boxHost, "/api/projects/"+garden.ID+"/edit-code", fromDevice, "{}", map[string]string{"cookie": owner["cookie"]}); got.status != http.StatusForbidden {
		t.Fatalf("a code made without an origin: %+v", got)
	}
	for from, want := range map[string]string{fromBox: `{"role":"box"}`, fromDevice: `{"role":"owner"}`} {
		if got := call(t, s, http.MethodGet, boxHost, "/api/me", from, "", owner); got.body != want+"\n" {
			t.Errorf("/api/me from %s: %+v", from, got)
		}
	}
	// Outside box mode the editor is the machine's own.
	s.box = nil
	if got := call(t, s, http.MethodGet, "127.0.0.1:4173", "/api/me", fromBox, "", nil); got.body != `{"role":"box"}`+"\n" {
		t.Fatalf("/api/me without a box: %+v", got)
	}
	if got := call(t, s, http.MethodPost, "127.0.0.1:4173", "/api/projects/"+garden.ID+"/edit-code", fromBox, "{}", nil); got.status != http.StatusNotFound {
		t.Fatalf("an edit code without a box: %+v", got)
	}
	for _, route := range [][3]string{{"GET", "", "1"}, {"POST", "", ""}, {"POST", "proposals", "1"}, {"GET", "export", "1"},
		{"POST", "release", ""}, {"POST", "remove", ""}, {"POST", "edit-code", ""}, {"GET", "editors", ""}, {"DELETE", "editors", ""},
		{"POST", "grants", "1"}, {"POST", "playtest", "1"}, {"POST", "asset", "1"}} {
		if editorProjectRoute(route[0], route[1]) != (route[2] == "1") {
			t.Errorf("an editor's %s %s", route[0], route[1])
		}
	}
}

func TestTheEditFormTakesOnlyItsFields(t *testing.T) {
	read := func(contentType, body string) error {
		r, err := http.NewRequestWithContext(t.Context(), http.MethodPost, "/edit", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("content-type", contentType)
		_, err = editForm(r)
		return err
	}
	for body, status := range map[string]int{"code=ABC-DEF&name=Ada": 0, "code=ABC-DEF": 400, "name=Ada": 400, "code=x&name=Ada&other=1": 400,
		"code=x&name=" + strings.Repeat("a", 25): 400, "code=x&name=" + strings.Repeat("é", 24): 0,
		// Zod counts code points: 13 to 24 emoji, past 24 UTF-16 units, are a name.
		url.Values{"code": {"x"}, "name": {strings.Repeat("😀", 13)}}.Encode(): 0, url.Values{"code": {"x"}, "name": {strings.Repeat("😀", 24)}}.Encode(): 0,
		url.Values{"code": {"x"}, "name": {strings.Repeat("😀", 25)}}.Encode(): 400, url.Values{"code": {strings.Repeat("😀", 40)}, "name": {"Ada"}}.Encode(): 0,
		"code=" + strings.Repeat("A", 41) + "&name=Ada": 400, "code=" + strings.Repeat("A", 1100): 413} {
		if got := statusOf(read("application/x-www-form-urlencoded", body)); got != status {
			t.Errorf("%.30s: %d, want %d", body, got, status)
		}
	}
	if err := read("application/x-www-form-urlencoded", "other=1&more=2"); err == nil ||
		err.Error() != `code · Invalid input: expected string, received undefined · name · Invalid input: expected string, received undefined · Unrecognized keys: "more", "other"` {
		t.Fatalf("the issues: %v", err)
	}
	if statusOf(read("application/json", "{}")) != http.StatusUnsupportedMediaType {
		t.Fatal("a form of another kind is read")
	}
}
