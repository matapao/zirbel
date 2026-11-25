package main

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// playerHost is the name the player is reached by: on a box, the one the
// device reached the editor by; loopback otherwise.
func (s *EditorServer) playerHost(r *http.Request) string {
	if s.box == nil {
		return "127.0.0.1"
	}
	return hostnameOf(r.Host)
}

func (s *EditorServer) solo(w http.ResponseWriter, r *http.Request, release *Release) error {
	room, err := s.rooms.Open(release, true, "local", false)
	if err != nil {
		return err
	}
	link := roomLink("http://"+s.playerHost(r)+":"+strconv.Itoa(s.players.local.port), room)
	reply(w, http.StatusCreated, map[string]string{"link": link, "id": room.ID})
	return nil
}
func (s *EditorServer) developmentRoom(w http.ResponseWriter, r *http.Request, projectID string) error {
	data, err := readBody(r, 512_000)
	if err != nil {
		return err
	}
	input, err := objectFields(data)
	if err != nil {
		return err
	}
	branch, base, err := input.scope(true)
	if err != nil {
		return err
	}
	release, err := s.Package(projectID, branch, "", Permissions{Play: true}, false, false, "")
	if err != nil {
		return err
	}
	if release.Manifest.SourceRevision != base {
		return fail(http.StatusConflict, "The branch changed. Refresh before sharing.")
	}
	if release.Manifest.Simulation == nil {
		return fail(http.StatusUnprocessableEntity, "Enable multiplayer in the game before sharing a development room.")
	}
	if s.players.lanHost == "" && len(LANAddresses()) == 0 {
		return fail(http.StatusConflict, "Connect the host to your local network to share a development room.")
	}
	if _, err := s.players.StartLAN(r.Context()); err != nil {
		return err
	}
	if _, err := s.projects.Read(projectID); err != nil {
		return err
	}
	room, err := s.rooms.Open(release, false, "lan", true)
	if err != nil {
		return err
	}
	described, err := s.players.Describe(r.Context(), room, s.playerHost(r))
	return send(w, http.StatusCreated, described, err)
}
func (s *EditorServer) serveGrants(w http.ResponseWriter, r *http.Request, projectID, tail string) error {
	switch {
	case r.Method == http.MethodPost && tail == "":
		data, err := readBody(r, 512_000)
		if err != nil {
			return err
		}
		var input struct {
			Write *bool    `json:"write"`
			Hours *float64 `json:"hours"`
		}
		if strictKeys(data, "write", "hours") != nil || json.Unmarshal(data, &input) != nil || input.Write == nil || input.Hours == nil {
			return fail(http.StatusBadRequest, "Invalid grant request.")
		}
		created, err := s.mcp.Create(projectID, *input.Write, *input.Hours)
		return send(w, http.StatusCreated, created, err)
	case r.Method == http.MethodPost:
		if err := safeID(tail); err != nil {
			return err
		}
		return send(w, http.StatusOK, map[string]any{}, s.mcp.Revoke(projectID, tail))
	case r.Method == http.MethodGet:
		list, err := s.mcp.List(projectID)
		return send(w, http.StatusOK, list, err)
	}
	return fail(http.StatusNotFound, "Editor route does not exist.")
}
func (s *EditorServer) serveReleases(w http.ResponseWriter, r *http.Request, pathID, action string) error {
	get, post := r.Method == http.MethodGet, r.Method == http.MethodPost
	switch {
	case get && pathID == "":
		list, err := s.ListReleases()
		return send(w, http.StatusOK, list, err)
	case post && pathID == "import":
		data, err := readBody(r, PortableFileLimit)
		if err != nil {
			return err
		}
		release, err := s.releases.ImportData(data)
		if err != nil {
			return err
		}
		reply(w, http.StatusCreated, release.ManifestRaw)
		return nil
	case post && pathID != "" && action == "play":
		release, err := s.releases.Read(pathID)
		if err != nil {
			return err
		}
		if !release.Manifest.Permissions.Play {
			return fail(http.StatusForbidden, "The creator has disabled play for this release.")
		}
		return s.solo(w, r, release)
	case get && pathID != "" && action == "download":
		release, err := s.releases.Read(pathID)
		if err != nil {
			return err
		}
		if !release.Manifest.Permissions.Download {
			return fail(http.StatusForbidden, "The creator has disabled downloads.")
		}
		bytesReply(w, release.canonical, "application/json; charset=utf-8", map[string]string{"content-disposition": `attachment; filename="zirbel-release.json"`})
		return nil
	case post && pathID != "" && action == "remix":
		p, err := s.Remix(pathID)
		return send(w, http.StatusCreated, p, err)
	}
	return fail(http.StatusNotFound, "Editor route does not exist.")
}
func (s *EditorServer) serveRooms(w http.ResponseWriter, r *http.Request, pathID, action string) error {
	get, post := r.Method == http.MethodGet, r.Method == http.MethodPost
	switch {
	case get && pathID == "":
		reply(w, http.StatusOK, s.rooms.List())
		return nil
	case post && pathID == "":
		data, err := readBody(r, 512_000)
		if err != nil {
			return err
		}
		var input struct {
			ReleaseID *string `json:"releaseId"`
			LAN       *bool   `json:"lan"`
		}
		if strictKeys(data, "releaseId", "lan") != nil || json.Unmarshal(data, &input) != nil || input.ReleaseID == nil || input.LAN == nil || safeID(*input.ReleaseID) != nil {
			return fail(http.StatusBadRequest, "Invalid room request.")
		}
		release, err := s.releases.Read(*input.ReleaseID)
		if err != nil {
			return err
		}
		if !release.Manifest.Permissions.Play {
			return fail(http.StatusForbidden, "The creator has disabled play for this release.")
		}
		access := "local"
		if *input.LAN {
			if _, err := s.players.StartLAN(r.Context()); err != nil {
				return err
			}
			access = "lan"
		}
		room, err := s.rooms.Open(release, false, access, false)
		if err != nil {
			return err
		}
		described, err := s.players.Describe(r.Context(), room, s.playerHost(r))
		return send(w, http.StatusCreated, described, err)
	case get && pathID != "" && action == "link":
		room, err := s.rooms.Get(pathID)
		if err != nil {
			return err
		}
		described, err := s.players.Describe(r.Context(), room, s.playerHost(r))
		return send(w, http.StatusOK, described, err)
	case post && pathID != "" && action == "close":
		s.rooms.Close(pathID)
		reply(w, http.StatusOK, map[string]any{})
		return nil
	}
	return fail(http.StatusNotFound, "Editor route does not exist.")
}
