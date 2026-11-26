package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// The lobby's routes: its page and API on every player listener, public on
// that listener's network, and the owner's side in the editor API.

// lobbyPolicy is the lobby page's, like the player page's: its own scripts and
// styles, no inline script, and nothing may frame it.
const lobbyPolicy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
	"connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

// seatLink is the player link that seats a guest with the ticket the lobby gave.
func seatLink(base string, room *Room, ticket string) string {
	return base + "/join/" + room.ID + "#seat=" + ticket
}

// serveLobby answers the lobby's page, its files and its API; handled says
// whether the path was the lobby's.
func (l *Listener) serveLobby(w http.ResponseWriter, r *http.Request, pathname string) (bool, error) {
	get, post := r.Method == http.MethodGet, r.Method == http.MethodPost
	name := strings.TrimPrefix(pathname, "/")
	switch {
	case get && pathname == "/":
		return true, l.lobbyFile(w, r, "lobby.html")
	case get && name != "lobby.html" && l.lobbyFiles[name] != nil:
		return true, l.lobbyFile(w, r, name)
	case !strings.HasPrefix(pathname, "/lobby/"):
		return false, nil
	}
	w.Header().Set("content-security-policy", lobbyPolicy)
	switch {
	case get && pathname == "/lobby/state":
		reply(w, http.StatusOK, l.config.lobby.State(l.access()))
		return true, nil
	case post && pathname == "/lobby/sessions":
		return true, l.startSession(w, r)
	case post && pathname == "/lobby/join":
		return true, l.joinSession(w, r)
	}
	return true, fail(http.StatusNotFound, "Lobby route does not exist.")
}

func (l *Listener) lobbyFile(w http.ResponseWriter, r *http.Request, name string) error {
	file := l.lobbyFiles[name]
	if file == nil {
		return fail(http.StatusNotFound, "Open the invitation link from the host.")
	}
	w.Header().Set("content-security-policy", lobbyPolicy)
	sendFile(w, r, typeFor(name), "no-cache", file)
	return nil
}

// lobbyInput reads a lobby request: a strict object of the two keys, the
// first a string (the release or the code), and the player's name, as the
// player page's join form takes it.
func lobbyInput(r *http.Request, key string) (value, name string, err error) {
	if err := checkOrigin(r, true); err != nil {
		return "", "", err
	}
	data, err := readBody(r, 4096)
	if err != nil {
		return "", "", err
	}
	fields, err := objectFields(data)
	if err != nil {
		return "", "", err
	}
	if err := fields.only(key, "name"); err != nil {
		return "", "", err
	}
	value, present, err := fields.text(key)
	if err != nil || !present {
		return "", "", fail(http.StatusBadRequest, key+" · Invalid input: expected string")
	}
	raw, present, err := fields.text("name")
	if err != nil || !present {
		return "", "", fail(http.StatusBadRequest, "name · Invalid input: expected string")
	}
	name, err = trimmed("name", raw, 24)
	return value, name, err
}

// guest is the address a lobby request came from, as its limits count it.
func guest(r *http.Request) string { return plainAddress(remoteAddress(r)) }

func (l *Listener) startSession(w http.ResponseWriter, r *http.Request) error {
	release, name, err := lobbyInput(r, "release")
	if err != nil {
		return err
	}
	if safeID(release) != nil {
		return fail(http.StatusBadRequest, "release · Invalid ID")
	}
	room, ticket, err := l.config.lobby.Start(release, name, l.access(), guest(r))
	if err != nil {
		return err
	}
	var code *string // null for a one-player game's room
	if room.Code != "" {
		code = &room.Code
	}
	reply(w, http.StatusCreated, struct {
		Code *string `json:"code"`
		Link string  `json:"link"`
	}{code, seatLink("http://"+r.Host, room, ticket)})
	return nil
}

func (l *Listener) joinSession(w http.ResponseWriter, r *http.Request) error {
	code, name, err := lobbyInput(r, "code")
	if err != nil {
		return err
	}
	room, ticket, err := l.config.lobby.Join(code, name, l.access(), guest(r))
	if err != nil {
		return err
	}
	reply(w, http.StatusOK, map[string]string{"link": seatLink("http://"+r.Host, room, ticket)})
	return nil
}

// serveLobby is the owner's side: which releases the lobby offers.
func (s *EditorServer) serveLobby(w http.ResponseWriter, r *http.Request, pathID, action string) error {
	switch {
	case s.lobby == nil: // a server built without one, as in tests
	case r.Method == http.MethodGet && pathID == "" && action == "":
		reply(w, http.StatusOK, map[string][]string{"offered": s.lobby.Offered()})
		return nil
	case r.Method == http.MethodPost && pathID == "offer" && action == "":
		data, err := readBody(r, 4096)
		if err != nil {
			return err
		}
		var input struct {
			Release *string `json:"release"`
			Offered *bool   `json:"offered"`
		}
		if strictKeys(data, "release", "offered") != nil || json.Unmarshal(data, &input) != nil ||
			input.Release == nil || input.Offered == nil || safeID(*input.Release) != nil {
			return fail(http.StatusBadRequest, "Invalid lobby request.")
		}
		list, err := s.lobby.Offer(*input.Release, *input.Offered)
		return send(w, http.StatusOK, map[string][]string{"offered": list}, err)
	}
	return fail(http.StatusNotFound, "Editor route does not exist.")
}
