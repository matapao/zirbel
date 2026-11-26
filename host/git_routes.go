package main

import (
	"net/http"
)

// The editor API's git routes, mirroring packages/server/git-routes.ts: a
// revision in full (GET /api/projects/<id>/revisions/<revision>), the clone
// command with this device's git token (GET /api/projects/<id>/clone), an
// import from a public repository (POST /api/projects/import-git) and an
// update from a game's source (POST /api/projects/<id>/update-from-source).
// Who a commit the host makes names as its author is here too
// (packages/server/authors.ts): the person or agent who asked, with Zirbel
// committing.

// authorOf is the machine the editor runs on (on a box, the box itself), a
// box's paired device, or an editor of one game.
func authorOf(access boxAccess) ident {
	if access.game != "" {
		return newIdent(firstOf(access.name, "Editor"), "editor."+access.editor+"@zirbel.invalid")
	}
	if access.device != "" {
		return newIdent(firstOf(access.name, "Owner"), "device."+access.device+"@zirbel.invalid")
	}
	return ownerIdent
}

// grantAuthor is an agent with a project grant, over MCP or git.
func grantAuthor(grant string) ident {
	return newIdent("MCP grant "+grant[:min(len(grant), 8)], "grant."+grant+"@zirbel.invalid")
}

type cloneCommand struct {
	URL     string `json:"url"`
	Command string `json:"command"`
	Token   string `json:"token,omitempty"`
}

// clone is the clone command for a game, on the host name the request came
// by: with this device's git token off the box.
func (s *EditorServer) clone(r *http.Request, access boxAccess, projectID string) (cloneCommand, error) {
	at := hostnameOf(r.Host) + portSuffix(s.port)
	address := "http://" + at + "/git/" + projectID + ".git"
	var holder *tokenHolder
	switch {
	case access.local:
	case access.game != "":
		holder = &tokenHolder{"e", access.editor}
	case access.device != "":
		holder = &tokenHolder{"o", access.device}
	}
	if holder == nil || s.tokens == nil {
		return cloneCommand{URL: address, Command: "git clone " + address}, nil
	}
	token, err := s.tokens.token(*holder)
	return cloneCommand{address, "git clone http://zirbel:" + token + "@" + at + "/git/" + projectID + ".git", token}, err
}

// serveGitRoutes answers the git routes of /api/projects: handled says whether it did.
func (s *EditorServer) serveGitRoutes(w http.ResponseWriter, r *http.Request, access boxAccess, pathID, action, tail string) (bool, error) {
	get, post := r.Method == http.MethodGet, r.Method == http.MethodPost
	if pathID == "import-git" && action == "" && post {
		if err := checkOrigin(r, !access.local); err != nil {
			return true, err
		}
		data, err := readBody(r, 8192)
		if err != nil {
			return true, err
		}
		p, err := s.projects.ImportGit(data)
		return true, send(w, http.StatusCreated, p, err)
	}
	if pathID == "" {
		return false, nil
	}
	switch {
	case action == "revisions" && tail != "" && get:
		if err := safeID(pathID); err != nil {
			return true, err
		}
		if err := safeID(tail); err != nil {
			return true, err
		}
		revision, err := s.projects.Revision(pathID, tail)
		return true, send(w, http.StatusOK, revision, err)
	case action == "clone" && tail == "" && get:
		if _, err := s.projects.Read(pathID); err != nil {
			return true, err
		}
		command, err := s.clone(r, access, pathID)
		return true, send(w, http.StatusOK, command, err)
	case action == "update-from-source" && tail == "" && post:
		if err := checkOrigin(r, !access.local); err != nil {
			return true, err
		}
		if err := safeID(pathID); err != nil {
			return true, err
		}
		data, err := readBody(r, 4096)
		if err != nil {
			return true, err
		}
		updated, err := s.projects.UpdateFromSource(pathID, data, authorOf(access))
		return true, send(w, http.StatusOK, updated, err)
	}
	return false, nil
}
