package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"

	"zirbel/host/webfiles"
)

type lobbyReply struct {
	status int
	header http.Header
	body   string
}

// call sends a request to handler as a device at from, by the host name host.
func call(t *testing.T, handler http.Handler, method, host, path, from, body string, headers map[string]string) lobbyReply {
	t.Helper()
	r := httptest.NewRequestWithContext(t.Context(), method, path, strings.NewReader(body))
	r.Host, r.RemoteAddr = host, from
	if body != "" {
		r.Header.Set("content-type", "application/json")
	}
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return lobbyReply{w.Code, w.Header(), w.Body.String()}
}

func TestTheLobbyIsServedOnPlayerListeners(t *testing.T) {
	lobby, rooms, _ := testLobby(t)
	storedRelease(t, lobby.releases, "shared", "g1", "Garden", 2, true)
	storedRelease(t, lobby.releases, "alone", "g2", "Walk", 1, true)
	for _, id := range []string{"shared", "alone"} {
		if _, err := lobby.Offer(id, true); err != nil {
			t.Fatal(err)
		}
	}
	page := &webfiles.File{Bytes: []byte(`<!doctype html><script type="module" src="lobby.js"></script>`), ETag: `"page"`}
	script := &webfiles.File{Bytes: []byte(`export {};`), ETag: `"script"`}
	l := &Listener{rooms: rooms, config: listenerConfig{lan: true, lobby: lobby}, port: 4174, playerPage: "<head></head>",
		lobbyFiles: map[string]*webfiles.File{"lobby.html": page, "lobby.js": script}}
	const host, guest = "127.0.0.1:4174", "192.168.1.5:5000"
	origin := map[string]string{"origin": "http://" + host}
	get := func(path string) lobbyReply { return call(t, l, http.MethodGet, host, path, guest, "", nil) }
	post := func(path, body string, headers map[string]string) lobbyReply {
		return call(t, l, http.MethodPost, host, path, guest, body, headers)
	}

	if got := get("/"); got.status != http.StatusOK || got.body != string(page.Bytes) || got.header.Get("content-security-policy") != lobbyPolicy ||
		!strings.HasPrefix(got.header.Get("content-type"), "text/html") || got.header.Get("x-content-type-options") != "nosniff" {
		t.Fatalf("the page: %+v", got)
	}
	if got := get("/lobby.js"); got.status != http.StatusOK || !strings.Contains(got.header.Get("content-type"), "javascript") {
		t.Fatalf("its script: %+v", got)
	}
	if got := call(t, l, http.MethodGet, host, "/", "203.0.113.5:5000", "", nil); got.status != http.StatusForbidden {
		t.Fatalf("an address off the LAN: %+v", got)
	}
	if got := call(t, l, http.MethodGet, "evil.example:4174", "/lobby/state", guest, "", nil); got.status != http.StatusForbidden {
		t.Fatalf("another host name: %+v", got)
	}

	if got := post("/lobby/sessions", `{"release":"shared","name":"Ada"}`, nil); got.status != http.StatusForbidden {
		t.Fatalf("a start without its origin: %+v", got)
	}
	started := post("/lobby/sessions", `{"release":"shared","name":"  Ada  "}`, origin)
	var session struct {
		Code *string
		Link string
	}
	if json.Unmarshal([]byte(started.body), &session) != nil || started.status != http.StatusCreated || session.Code == nil ||
		started.header.Get("cache-control") != "no-store" || started.header.Get("content-security-policy") != lobbyPolicy {
		t.Fatalf("a multiplayer start: %+v", started)
	}
	room := rooms.Session(*session.Code, "lan")
	if room == nil || !strings.HasPrefix(session.Link, "http://"+host+"/join/"+room.ID+"#seat=") {
		t.Fatalf("the starter's link: %s", session.Link)
	}
	ticket := session.Link[strings.Index(session.Link, "=")+1:]
	info := call(t, l, http.MethodGet, host, "/rooms/"+room.ID+"/info", guest, "", map[string]string{"authorization": "Bearer " + ticket})
	if info.status != http.StatusOK || !strings.Contains(info.body, `"code":"`+*session.Code+`"`) {
		t.Fatalf("the room by its seat: %+v", info)
	}
	if solo := post("/lobby/sessions", `{"release":"alone","name":"Bo"}`, origin); solo.status != http.StatusCreated ||
		!strings.HasPrefix(solo.body, `{"code":null,"link":"http://`+host+`/join/`) {
		t.Fatalf("a one-player start: %+v", solo)
	}
	if got := post("/lobby/sessions", `{"release":"other","name":"Bo"}`, origin); got.status != http.StatusNotFound {
		t.Fatalf("a game that isn't offered: %+v", got)
	}

	state := get("/lobby/state")
	if state.status != http.StatusOK || state.header.Get("cache-control") != "no-store" || strings.Contains(state.body, *session.Code) ||
		strings.Contains(state.body, "Ada") || !strings.Contains(state.body, `"sessions":[{"id":"`+room.ID+`","title":"Garden","players":0,"max":2,"started":"`) ||
		!strings.Contains(state.body, `"games":[{"release":"shared","title":"Garden","players":{"min":1,"max":2},"multiplayer":true},`+
			`{"release":"alone","title":"Walk","players":{"min":1,"max":1},"multiplayer":false}]`) {
		t.Fatalf("the state: %+v", state)
	}

	typed := strings.ToLower((*session.Code)[:2]) + "-" + (*session.Code)[2:]
	joined := post("/lobby/join", `{"code":"`+typed+`","name":"Cy"}`, origin)
	if joined.status != http.StatusOK || !strings.HasPrefix(joined.body, `{"link":"http://`+host+`/join/`+room.ID+`#seat=`) {
		t.Fatalf("a join: %+v", joined)
	}
	if got := post("/lobby/join", `{"code":"ZZZZ","name":"Cy"}`, origin); got.status != http.StatusNotFound ||
		!strings.Contains(got.body, "No session has that code.") {
		t.Fatalf("a wrong code: %+v", got)
	}
	for _, body := range []string{`{"code":"ZZZZ"}`, `{"code":"ZZZZ","name":"   "}`, `{"code":"ZZZZ","name":"` + strings.Repeat("x", 25) + `"}`,
		`{"code":5,"name":"Cy"}`, `{"code":"ZZZZ","name":"Cy","role":"player"}`, `[]`, `{"code":null,"name":"Cy"}`} {
		if got := post("/lobby/join", body, origin); got.status != http.StatusBadRequest {
			t.Errorf("%s: %+v", body, got)
		}
	}
	if got := post("/lobby/sessions", `{"release":"Not an ID","name":"Cy"}`, origin); got.status != http.StatusBadRequest {
		t.Fatalf("a release that is no ID: %+v", got)
	}
	if got := get("/lobby/codes"); got.status != http.StatusNotFound {
		t.Fatalf("another lobby path: %+v", got)
	}

	// A listener without a lobby answers / as before.
	bare := &Listener{rooms: rooms, config: listenerConfig{}, port: 4174}
	if got := call(t, bare, http.MethodGet, host, "/", "127.0.0.1:5000", "", nil); got.status != http.StatusNotFound {
		t.Fatalf("without a lobby: %+v", got)
	}
}

func TestTheOwnerOffersReleasesAndSeesSessionCodes(t *testing.T) {
	lobby, rooms, _ := testLobby(t)
	storedRelease(t, lobby.releases, "shared", "g1", "Garden", 2, true)
	players := &Players{rooms: rooms, runtime: map[string]*webfiles.File{"player.html": {Bytes: []byte("<head></head>")}},
		local: &Listener{port: 4174}, lobby: lobby}
	t.Cleanup(func() {
		if lan := players.lan; lan != nil {
			lan.Close()
		}
	})
	s := &EditorServer{Editor: &Editor{releases: lobby.releases}, rooms: rooms, players: players, lobby: lobby, port: 4173}
	const host, owner = "127.0.0.1:4173", "127.0.0.1:5000"
	if got := call(t, s, http.MethodGet, host, "/api/lobby", owner, "", nil); got.status != http.StatusOK || got.body != "{\"offered\":[]}\n" {
		t.Fatalf("the empty lobby: %+v", got)
	}
	if got := call(t, s, http.MethodPost, host, "/api/lobby/offer", owner, `{"release":"shared","offered":true}`, nil); got.status != http.StatusOK ||
		got.body != "{\"offered\":[\"shared\"]}\n" {
		t.Fatalf("an offer: %+v", got)
	}
	for _, body := range []string{`{"release":"shared"}`, `{"release":"shared","offered":"yes"}`, `{"release":"","offered":true}`,
		`{"release":"shared","offered":true,"x":1}`} {
		if got := call(t, s, http.MethodPost, host, "/api/lobby/offer", owner, body, nil); got.status != http.StatusBadRequest {
			t.Errorf("%s: %+v", body, got)
		}
	}
	if got := call(t, s, http.MethodPost, host, "/api/lobby/offer", owner, `{"release":"missing","offered":true}`, nil); got.status != http.StatusNotFound {
		t.Fatalf("a missing release: %+v", got)
	}
	if !slices.Equal(lobby.Offered(), []string{"shared"}) {
		t.Fatal("a refused offer changed the list")
	}

	// The owner's LAN room is a session too; the room summaries carry its code.
	created := call(t, s, http.MethodPost, host, "/api/rooms", owner, `{"releaseId":"shared","lan":true}`, nil)
	var room struct{ ID, Code, Link string }
	if json.Unmarshal([]byte(created.body), &room) != nil || created.status != http.StatusCreated || sessionCode(room.Code) == "" {
		t.Fatalf("a LAN room: %+v", created)
	}
	listed := call(t, s, http.MethodGet, host, "/api/rooms", owner, "", nil)
	if !strings.Contains(listed.body, `"code":"`+room.Code+`"`) {
		t.Fatalf("the rooms list: %s", listed.body)
	}
	if link := call(t, s, http.MethodGet, host, "/api/rooms/"+room.ID+"/link", owner, "", nil); !strings.Contains(link.body, `"code":"`+room.Code+`"`) {
		t.Fatalf("the room's link: %s", link.body)
	}
	local := call(t, s, http.MethodPost, host, "/api/rooms", owner, `{"releaseId":"shared","lan":false}`, nil)
	if local.status != http.StatusCreated || strings.Contains(local.body, `"code"`) {
		t.Fatalf("a loopback room: %+v", local)
	}
	// Ending a session is closing its room.
	if got := call(t, s, http.MethodPost, host, "/api/rooms/"+room.ID+"/close", owner, "", nil); got.status != http.StatusOK ||
		rooms.Session(room.Code, "lan") != nil {
		t.Fatalf("closing the session: %+v", got)
	}
}

func TestABoxSendsDevicesThatArentPairedToTheLobby(t *testing.T) {
	box, err := NewBox(t.TempDir(), func() int { return 80 })
	if err != nil {
		t.Fatal(err)
	}
	box.lobbyPort = func() int { return 4174 }
	door := func(path, host, from string) (*httptest.ResponseRecorder, bool) {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, http.NoBody)
		r.Host, r.RemoteAddr = host, from
		w := httptest.NewRecorder()
		_, handled, _ := box.door(w, r)
		return w, handled
	}
	for host, want := range map[string]string{"Zirbel.local": "http://zirbel.local:4174/", "192.168.1.2": "http://192.168.1.2:4174/",
		"[fd00::2]": "http://[fd00::2]:4174/", "zirbel.local:80": "http://zirbel.local:4174/"} {
		if w, handled := door("/", host, "192.168.1.5:5000"); !handled || w.Code != http.StatusSeeOther || w.Header().Get("location") != want {
			t.Errorf("/ by %s: %d %s", host, w.Code, w.Header().Get("location"))
		}
	}
	if w, _ := door("/workspace.css", "zirbel.local", "192.168.1.5:5000"); w.Header().Get("location") != "/pair" {
		t.Fatalf("another page: %s", w.Header().Get("location"))
	}
	if _, handled := door("/", "zirbel.local", "127.0.0.1:5000"); handled {
		t.Fatal("the box itself was sent to the lobby")
	}

	// The LAN player listener on a box answers its names and IPv6 network.
	players := &Players{rooms: NewRooms(), runtime: map[string]*webfiles.File{"player.html": {Bytes: []byte("<head></head>")}},
		lanHost: "games.lan", box: &playerReach{hosts: func() []string { return []string{"zirbel.local"} }, network: onBoxNetwork}}
	t.Cleanup(players.rooms.Dispose)
	t.Cleanup(players.Close)
	lan, err := players.StartLAN(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(lan.hosts(), []string{"zirbel.local", "games.lan"}) || players.LANPort() != lan.port || lan.access() != "lan" {
		t.Fatalf("the box's LAN listener: %v %d", lan.hosts(), lan.port)
	}
	if got := call(t, lan, http.MethodGet, "zirbel.local:"+strconv.Itoa(lan.port), "/health", "[fd00::5]:5000", "", nil); got.status != http.StatusOK {
		t.Fatalf("a device on the box's IPv6 network: %+v", got)
	}
}
