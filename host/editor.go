package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// EditorServer is the loopback editor: the workspace UI, its project API and
// the optional project MCP endpoint, mirroring editorRequest in
// packages/server/main.ts. Harness chat stays with the Node editor for now.
type EditorServer struct {
	*Editor
	rooms     *Rooms
	players   *Players
	mcp       *MCP // nil unless --enable-mcp or --box
	enableMCP bool // --enable-mcp: on a box, /mcp also answers while external MCP access is off, from the box itself
	box       *Box // nil unless --box
	files     map[string][]byte
	port      int
	boot      string
}

// mcpOn: the MCP endpoint answers with --enable-mcp, and on a box while its
// external MCP access is on.
func (s *EditorServer) mcpOn() bool {
	if s.mcp == nil {
		return false
	}
	if s.enableMCP || s.box == nil {
		return s.enableMCP
	}
	switches, err := s.box.settings.Read()
	return err == nil && switches.ExternalMCP
}

func (s *EditorServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	secure(w)
	if err := s.serve(w, r); err != nil {
		replyError(w, err)
	}
}
func (s *EditorServer) serve(w http.ResponseWriter, r *http.Request) error {
	hosts := []string{"127.0.0.1", "localhost"}
	if s.box != nil {
		hosts = boxHosts()
	}
	if err := checkHost(r, s.port, hosts); err != nil {
		return err
	}
	access := boxAccess{local: true}
	if s.box != nil {
		opened, handled, err := s.box.door(w, r)
		if err != nil || handled {
			return err
		}
		access = opened
	}
	pathname := r.URL.EscapedPath()
	mcpRequest := s.mcpOn() && pathname == "/mcp"
	// MCP authenticates each request by grant. Browsers supplying Origin must
	// still match; like Node, an empty Origin header counts as supplied.
	_, hasOrigin := r.Header["Origin"]
	if !mcpRequest || hasOrigin {
		if err := checkOrigin(r, false); err != nil {
			return err
		}
	}
	if mcpRequest {
		return s.serveMCP(w, r)
	}
	segments := strings.Split(pathname, "/")
	part := func(i int) string {
		if i < len(segments) {
			return segments[i]
		}
		return ""
	}
	if part(1) != "api" {
		if r.Method != http.MethodGet {
			return fail(http.StatusNotFound, "Route does not exist.")
		}
		player := "http://" + s.playerHost(r) + ":" + strconv.Itoa(s.players.local.port)
		w.Header().Set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src "+
			player+"; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		name := strings.TrimPrefix(pathname, "/")
		if name == "" {
			name = "index.html"
		}
		file, ok := s.files[name]
		if !ok {
			return fail(http.StatusNotFound, "File does not exist.")
		}
		bytesReply(w, file, typeFor(name), nil)
		return nil
	}
	if len(segments) > 6 {
		return fail(http.StatusNotFound, "Route does not exist.")
	}
	resource, pathID, action, tail := part(2), part(3), part(4), part(5)
	switch resource {
	case "health":
		if r.Method == http.MethodGet {
			health := map[string]any{"status": "ok", "pid": os.Getpid(), "boot": s.boot, "editor": loopback(s.port), "mcp": s.mcpOn(), "host": "go"}
			if s.box != nil {
				box, err := s.box.health()
				if err != nil {
					return err
				}
				health["box"] = box
			}
			reply(w, http.StatusOK, health)
			return nil
		}
	case "pairing", "box":
		if s.box != nil {
			if handled, err := s.box.serve(w, r, access, resource, pathID, action, tail); handled || err != nil {
				return err
			}
		}
	case "processors":
		// No harness in the Go editor yet; the workspace shows that none is signed in.
		if pathID == "" && r.Method == http.MethodGet {
			reply(w, http.StatusOK, map[string]any{"processors": []any{}})
			return nil
		}
	case "projects":
		return s.serveProjects(w, r, pathID, action, tail)
	case "releases":
		return s.serveReleases(w, r, pathID, action)
	case "rooms":
		return s.serveRooms(w, r, pathID, action)
	}
	return fail(http.StatusNotFound, "Editor route does not exist.")
}
func (s *EditorServer) serveMCP(w http.ResponseWriter, r *http.Request) error {
	credential := r.Header.Get("authorization")
	if _, err := s.mcp.Verify(credential); err != nil {
		return err
	}
	if r.Method != http.MethodPost {
		w.Header().Set("allow", "POST")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return nil
	}
	data, err := readBody(r, 512_000)
	if err != nil {
		return err
	}
	// The owner can revoke a grant while the body arrives; Handle checks again.
	result, err := s.mcp.Handle(data, credential)
	if errors.Is(err, errNotification) {
		w.WriteHeader(http.StatusAccepted)
		return nil
	}
	return send(w, http.StatusOK, result, err)
}

// fields is a JSON object request body, read the way the Zod objects in
// packages/server/main.ts read one: a missing key takes its default, and
// null or a value of the wrong type is refused.
type fields map[string]json.RawMessage

func objectFields(data []byte) (fields, error) {
	var input fields
	if json.Unmarshal(data, &input) != nil || input == nil {
		return nil, fail(http.StatusBadRequest, "Invalid request.")
	}
	return input, nil
}

// only refuses keys outside the allowed set, like z.strictObject.
func (f fields) only(allowed ...string) error {
	if key, found := unknownKey(f, allowed); found {
		return fail(http.StatusBadRequest, "Unrecognized key: "+key)
	}
	return nil
}

// id reads a required ID.
func (f fields) id(key string) (string, error) {
	var value *string
	if raw, ok := f[key]; !ok || json.Unmarshal(raw, &value) != nil || value == nil || safeID(*value) != nil {
		return "", fail(http.StatusBadRequest, key+" · Invalid ID")
	}
	return *value, nil
}

// optionalID reads id.optional() (fallback "") or id.default(fallback).
func (f fields) optionalID(key, fallback string) (string, error) {
	if _, ok := f[key]; !ok {
		return fallback, nil
	}
	return f.id(key)
}

// scope reads branch, which defaults to main, and baseRevision.
func (f fields) scope(needBase bool) (branch, base string, err error) {
	if branch, err = f.optionalID("branch", "main"); err != nil {
		return "", "", err
	}
	if needBase {
		base, err = f.id("baseRevision")
	} else {
		base, err = f.optionalID("baseRevision", "")
	}
	return branch, base, err
}

// text reads z.string().optional(): present reports whether the key was sent.
func (f fields) text(key string) (value string, present bool, err error) {
	raw, ok := f[key]
	if !ok {
		return "", false, nil
	}
	var text *string
	if json.Unmarshal(raw, &text) != nil || text == nil {
		return "", false, fail(http.StatusBadRequest, key+" · Invalid input")
	}
	return *text, true, nil
}

// permissions reads the distribution object: play, download and remix, all required.
func (f fields) permissions(key string) (Permissions, error) {
	var rights struct {
		Play     *bool `json:"play"`
		Download *bool `json:"download"`
		Remix    *bool `json:"remix"`
	}
	raw, ok := f[key]
	if !ok || strictKeys(raw, "play", "download", "remix") != nil || json.Unmarshal(raw, &rights) != nil ||
		rights.Play == nil || rights.Download == nil || rights.Remix == nil {
		return Permissions{}, fail(http.StatusBadRequest, key+" · Invalid input")
	}
	return Permissions{*rights.Play, *rights.Download, *rights.Remix}, nil
}

// unknownKey finds a key outside the allowed set, as z.strictObject reports one.
func unknownKey(fields map[string]json.RawMessage, allowed []string) (string, bool) {
	for key := range fields {
		if !contains(allowed, key) {
			return key, true
		}
	}
	return "", false
}

// strictKeys rejects keys outside the allowed set, like z.strictObject.
func strictKeys(data []byte, allowed ...string) error {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil {
		return errors.New("not an object")
	}
	if key, found := unknownKey(fields, allowed); found {
		return errors.New("unrecognized key " + key)
	}
	return nil
}
