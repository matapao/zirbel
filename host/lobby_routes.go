package main

import (
	"net/http"
	"strings"

	"zirbel/contracts"
)

// The lobby's routes, mirroring packages/server/lobby-routes.ts: its page and
// API on every player listener, public on that listener's network, and the
// owner's side in the editor API.

// lobbyPolicy is the lobby page's: it runs its own script and style alone,
// and talks only to its listener.
const lobbyPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
	"base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// seatLink is the player page in a room, holding a seat's one-time ticket: it
// goes straight in.
func seatLink(base string, room *Room, ticket string) string {
	return base + "/join/" + room.ID + "#seat=" + ticket
}

// serveLobby answers the lobby's page, its files and its API; handled says
// whether the path was the lobby's.
func (l *Listener) serveLobby(w http.ResponseWriter, r *http.Request, pathname string) (bool, error) {
	get, post := r.Method == http.MethodGet, r.Method == http.MethodPost
	name := strings.TrimPrefix(pathname, "/")
	if pathname == "/" {
		name = "lobby.html"
	}
	if file := l.lobbyFiles[name]; get && file != nil && (pathname == "/" || name != "lobby.html") {
		if name == "lobby.html" {
			w.Header().Set("content-security-policy", lobbyPolicy)
		}
		sendFile(w, r, typeFor(name), "no-cache", file)
		return true, nil
	}
	if !strings.HasPrefix(pathname, "/lobby/") {
		return false, nil
	}
	switch {
	case get && pathname == "/lobby/state":
		reply(w, http.StatusOK, l.config.lobby.State(l.access(), hostnameOf(r.Host)))
		return true, nil
	case post && pathname == "/lobby/sessions":
		return true, l.startSession(w, r)
	case post && pathname == "/lobby/join":
		return true, l.joinSession(w, r)
	}
	return true, fail(http.StatusNotFound, "Lobby route does not exist.")
}

// lobbyInput reads a lobby request from this listener's own page against its
// contract: lobby-start or lobby-join.
func lobbyInput(r *http.Request, contract string, input any) error {
	if err := checkOrigin(r, true); err != nil {
		return err
	}
	data, err := readBody(r, 4096)
	if err != nil {
		return err
	}
	return decodeContract(contract, data, input)
}

// guest is the address a lobby request came from, as its limits count it.
func guest(r *http.Request) string { return plainAddress(remoteAddress(r)) }

func (l *Listener) startSession(w http.ResponseWriter, r *http.Request) error {
	var input struct{ Release, Name string }
	if err := lobbyInput(r, "lobby-start", &input); err != nil {
		return err
	}
	room, ticket, err := l.config.lobby.Start(input.Release, contracts.Trim(input.Name), l.access(), guest(r))
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
	var input struct{ Code, Name string }
	if err := lobbyInput(r, "lobby-join", &input); err != nil {
		return err
	}
	room, ticket, err := l.config.lobby.Join(input.Code, contracts.Trim(input.Name), l.access(), guest(r))
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
			Release string
			Offered bool
		}
		if err := decodeContract("lobby-offer", data, &input); err != nil {
			return err
		}
		list, err := s.lobby.Offer(input.Release, input.Offered)
		return send(w, http.StatusOK, map[string][]string{"offered": list}, err)
	}
	return fail(http.StatusNotFound, "Editor route does not exist.")
}
