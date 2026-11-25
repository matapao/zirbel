package main

import (
	"errors"
	"net/http"
)

func (s *EditorServer) serveProjects(w http.ResponseWriter, r *http.Request, pathID, action, tail string) error {
	get, post := r.Method == http.MethodGet, r.Method == http.MethodPost
	if pathID == "" && get {
		list, err := s.projects.Summaries()
		return send(w, http.StatusOK, list, err)
	}
	if pathID == "" && post {
		data, err := readBody(r, 512_000)
		if err != nil {
			return err
		}
		input, err := objectFields(data)
		if err != nil {
			return err
		}
		title, present, err := input.text("title")
		if err := errors.Join(input.only("title"), err); err != nil {
			return err
		}
		if !present {
			title = "Untitled project"
		}
		p, err := s.projects.CreateGame(title, nil)
		return send(w, http.StatusCreated, p, err)
	}
	if pathID == "import-game" && post {
		data, err := readBody(r, PortableFileLimit)
		if err != nil {
			return err
		}
		p, err := s.projects.ImportGameFolder(data)
		return send(w, http.StatusCreated, p, err)
	}
	if pathID == "import" && post {
		data, err := readBody(r, PortableFileLimit)
		if err != nil {
			return err
		}
		p, err := s.projects.Import(data)
		return send(w, http.StatusCreated, p, err)
	}
	if err := safeID(pathID); err != nil {
		return err
	}
	projectID := pathID
	switch {
	case action == "" && get:
		p, err := s.projects.Read(projectID)
		return send(w, http.StatusOK, p, err)
	case action == "remove" && tail == "" && post:
		if err := s.projects.Remove(projectID); err != nil {
			return err
		}
		s.rooms.CloseProject(projectID)
		reply(w, http.StatusOK, map[string]any{})
		return nil
	case action == "title" && post:
		data, err := readBody(r, 512_000)
		if err != nil {
			return err
		}
		input, err := objectFields(data)
		if err != nil {
			return err
		}
		title, present, err := input.text("title")
		if err := errors.Join(input.only("title"), err); err != nil || !present {
			return fail(http.StatusBadRequest, "title · Invalid input")
		}
		p, err := s.projects.Rename(projectID, title)
		return send(w, http.StatusOK, p, err)
	case action == "proposals" && get:
		if tail != "" {
			staged, err := s.projects.Preview(projectID, tail)
			return send(w, http.StatusOK, staged, err)
		}
		branch := r.URL.Query().Get("branch")
		if branch == "" {
			branch = "main"
		}
		if err := safeID(branch); err != nil {
			return err
		}
		list, err := s.projects.Proposals(projectID, branch)
		return send(w, http.StatusOK, list, err)
	case action == "proposals" && post:
		data, err := readBody(r, 512_000)
		if err != nil {
			return err
		}
		staged, err := s.projects.Submit(projectID, data, nil)
		return send(w, http.StatusCreated, staged, err)
	case action == "discard" && post:
		if err := safeID(tail); err != nil {
			return err
		}
		return send(w, http.StatusOK, map[string]any{}, s.projects.Discard(projectID, tail))
	case action == "apply" && post:
		data, err := readBody(r, 512_000)
		if err != nil {
			return err
		}
		input, err := objectFields(data)
		if err != nil {
			return err
		}
		fork, err := input.optionalID("fork", "")
		if err := errors.Join(input.only("fork"), err, safeID(tail)); err != nil {
			return err
		}
		committed, err := s.projects.Commit(projectID, tail, fork)
		return send(w, http.StatusOK, committed, err)
	case action == "restore" && post:
		data, err := readBody(r, 512_000)
		if err != nil {
			return err
		}
		input, err := objectFields(data)
		if err != nil {
			return err
		}
		branch, base, err := input.scope(true)
		target, targetErr := input.id("target")
		if err := errors.Join(err, targetErr); err != nil {
			return err
		}
		p, err := s.projects.Restore(projectID, branch, base, target)
		return send(w, http.StatusOK, p, err)
	case action == "notes" && post:
		data, err := readBody(r, 512_000)
		if err != nil {
			return err
		}
		note, err := s.projects.AddNote(projectID, data)
		return send(w, http.StatusCreated, note, err)
	case action == "media" && post && tail == "":
		data, err := readBody(r, 25_000_000)
		if err != nil {
			return err
		}
		item, err := s.projects.AddMedia(projectID, data)
		return send(w, http.StatusCreated, item, err)
	case action == "media" && get && tail != "":
		if err := safeID(tail); err != nil {
			return err
		}
		item, data, err := s.projects.ReadMedia(projectID, tail)
		if err != nil {
			return err
		}
		bytesReply(w, data, item.Media, nil)
		return nil
	case action == "media" && post && tail != "":
		if err := safeID(tail); err != nil {
			return err
		}
		data, err := readBody(r, 512_000)
		if err != nil {
			return err
		}
		item, err := s.projects.EditTranscript(projectID, tail, data)
		return send(w, http.StatusOK, item, err)
	case action == "asset" && post:
		data, err := readBody(r, 7_500_000)
		if err != nil {
			return err
		}
		staged, err := s.projects.UploadAsset(projectID, data)
		return send(w, http.StatusCreated, staged, err)
	case action == "export" && get:
		data, err := s.projects.Export(projectID)
		if err != nil {
			return err
		}
		bytesReply(w, data, "application/json; charset=utf-8", map[string]string{"content-disposition": `attachment; filename="zirbel-project.json"`})
		return nil
	case action == "release" && post:
		data, err := readBody(r, 512_000)
		if err != nil {
			return err
		}
		input, err := objectFields(data)
		if err != nil {
			return err
		}
		branch, base, err := input.scope(false)
		permissions, permissionsErr := input.permissions("permissions")
		if err := errors.Join(err, permissionsErr); err != nil {
			return err
		}
		release, err := s.Package(projectID, branch, base, permissions, true, false, "")
		if err != nil {
			return err
		}
		reply(w, http.StatusCreated, release.ManifestRaw)
		return nil
	case action == "development-room" && post:
		return s.developmentRoom(w, r, projectID)
	case action == "playtest" && post:
		data, err := readBody(r, 512_000)
		if err != nil {
			return err
		}
		input, err := objectFields(data)
		if err != nil {
			return err
		}
		branch, base, err := input.scope(false)
		proposalID, proposalErr := input.optionalID("proposalId", "")
		if err := errors.Join(err, proposalErr); err != nil {
			return err
		}
		// Draft play stays on loopback. Delivery rights are checked when sharing or exporting.
		release, err := s.Package(projectID, branch, base, Permissions{true, true, true}, false, true, proposalID)
		if err != nil {
			return err
		}
		return s.solo(w, r, release)
	case action == "grants" && s.mcpOn():
		return s.serveGrants(w, r, projectID, tail)
	}
	return fail(http.StatusNotFound, "Editor route does not exist.")
}
