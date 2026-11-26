package main

import (
	"net/http"
)

// What each kind of person on a box may do (--box), mirroring
// packages/server/box-editors.ts: the box itself and its owners everything; a
// device that edits one game (box_editors.go) that game's routes alone, and
// the listings it sees only that game in; and the owners' API for the game's
// edit code and its editors.

var errEditsOneGame = fail(http.StatusForbidden, "This device edits one game only.")

// editorProjectRoute: what an editor may do in its game's routes, by method
// and action. Not: publish a release, remove the game, or see or change its
// edit code and editors.
func editorProjectRoute(method, action string) bool {
	get, post := method == http.MethodGet, method == http.MethodPost
	switch action {
	case "": // read it
		return get
	case "proposals", "media", "grants": // its changes, history, imported media and its MCP grants
		return get || post
	case "apply", "discard", "restore", "title", "notes", "asset", "playtest", "development-room", "update-from-source":
		return post
	case "export", "revisions", "clone": // a revision in full, and the clone command with its git token
		return get
	}
	return false
}

// asEditor answers a request of a device that edits game alone: the routes it
// may not use are refused, and the listings show only its game; handled says
// whether it answered. The routes it may use go on as the owner's do.
func (s *EditorServer) asEditor(w http.ResponseWriter, r *http.Request, game, resource, pathID, action, tail string) (bool, error) {
	get, post := r.Method == http.MethodGet, r.Method == http.MethodPost
	switch {
	case resource == "health" || resource == "me":
		return false, nil
	case resource == "lobby" && get && pathID == "": // the lobby's address, to open it
		return false, nil
	case resource == "projects" && pathID == "" && get:
		list, err := s.projects.Summaries()
		return true, send(w, http.StatusOK, without(list, func(p ProjectSummary) bool { return p.ID != game }), err)
	case resource == "projects" && pathID == game && editorProjectRoute(r.Method, action):
		return false, nil
	case resource == "rooms" && pathID == "" && get:
		list := []summary{}
		for _, room := range s.rooms.list() {
			if !room.Solo && room.Release.Manifest.GameID == game {
				list = append(list, room.Summary())
			}
		}
		reply(w, http.StatusOK, list)
		return true, nil
	case resource == "rooms" && pathID != "" && tail == "" && ((get && action == "link") || (post && action == "close")):
		// Its playtests and development rooms; one that has closed is answered as the owner's is.
		if playing := s.roomGame(pathID); playing == "" || playing == game {
			return false, nil
		}
	}
	return true, errEditsOneGame
}

// roomGame is the game a room plays, empty when there is no such room.
func (s *EditorServer) roomGame(id string) string {
	room, err := s.rooms.Get(id)
	if err != nil {
		return ""
	}
	return room.Release.Manifest.GameID
}

// me is who the request is from, as /api/me tells the workspace: the box (or
// the machine an editor runs on outside box mode) itself, an owner, or an
// editor of one game.
func me(access boxAccess) map[string]string {
	switch {
	case access.local:
		return map[string]string{"role": "box"}
	case access.game != "":
		return map[string]string{"role": "editor", "game": access.game}
	}
	return map[string]string{"role": "owner"}
}

// serveEditCodes is the owners' API for a game's edit code and its editors.
func (s *EditorServer) serveEditCodes(w http.ResponseWriter, r *http.Request, projectID, action, tail string) error {
	editors := s.box.editors
	method := r.Method
	route := func() error {
		if method != http.MethodGet {
			if err := checkOrigin(r, !isLoopbackAddress(remoteAddress(r))); err != nil {
				return err
			}
		}
		_, err := s.projects.Read(projectID)
		return err
	}
	switch {
	case action == "edit-code" && tail == "" && method == http.MethodPost:
		if err := route(); err != nil {
			return err
		}
		code, err := editors.CreateCode(projectID)
		if err != nil {
			return err
		}
		// The Go host draws no QR codes; the editor shows the link and the code.
		reply(w, http.StatusCreated, map[string]any{"code": code.Code, "link": s.editLink(r, code.Code), "expiresAt": code.ExpiresAt, "qr": nil})
		return nil
	case action == "edit-code" && tail == "stop" && method == http.MethodPost:
		if err := route(); err != nil {
			return err
		}
		return send(w, http.StatusOK, map[string]any{}, editors.Stop(projectID))
	case action == "editors" && tail == "" && method == http.MethodGet:
		if err := route(); err != nil {
			return err
		}
		code, found, err := editors.Code(projectID)
		if err != nil {
			return err
		}
		var shown *editCodeLink // null while the game has no code
		if found {
			shown = &editCodeLink{code.Code, s.editLink(r, code.Code), code.ExpiresAt}
		}
		list, err := editors.List(projectID)
		return send(w, http.StatusOK, map[string]any{"code": shown, "editors": list}, err)
	case action == "editors" && tail != "" && method == http.MethodDelete:
		if err := route(); err != nil {
			return err
		}
		if err := safeID(tail); err != nil {
			return err
		}
		return send(w, http.StatusOK, map[string]any{}, editors.Remove(projectID, tail))
	}
	return fail(http.StatusNotFound, "Editor route does not exist.")
}

// editCodeLink is a game's code as its owners see it again, with its link.
type editCodeLink struct {
	Code      string `json:"code"`
	Link      string `json:"link"`
	ExpiresAt string `json:"expiresAt"`
}

// editLink is the edit page with a code, on the address other devices can use,
// as the lobby's is chosen, at the editor's port.
func (s *EditorServer) editLink(r *http.Request, shown string) string {
	address := s.players.reachableAddress(hostnameOf(r.Host))
	if address == "" {
		address = boxName()
	}
	return "http://" + address + portSuffix(s.port) + "/edit?code=" + normalizeEditCode(shown)
}
