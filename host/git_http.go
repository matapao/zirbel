package main

import (
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"net/http/cgi" // #nosec G504 -- Go has left out the Proxy header since 1.6.3, and the backend gets two headers alone
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Git over HTTP on the editor's listener, mirroring packages/server/git-http.ts:
// /git/<project>.git, smart HTTP alone, served by `git http-backend` as CGI.
// The machine the editor runs on (on a box, the box itself) clones and pushes
// every game without credentials; from a box's network a git client sends a
// git token (a paired device's, for every game; an editor's, for its game) or
// a project grant (its game; pushes with a write grant alone), as its Basic
// password or a bearer token. A push is checked by the host's own pre-receive
// hook (git_hook.go) before any ref moves. The git store in AGENTS.md is the design.

// pushBytes is what a push may bring in all.
const pushBytes = 128 * 1024 * 1024

const signIn = "Sign in with this device’s git token: the editor shows it in Clone with git."

var (
	gitRoute     = regexp.MustCompile(`^/git/([a-z0-9][a-z0-9_-]{0,79})\.git/(info/refs|git-upload-pack|git-receive-pack)$`)
	grantToken   = regexp.MustCompile(`^[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$`)
	bearerToken  = regexp.MustCompile(`^Bearer (\S+)$`)
	basicToken   = regexp.MustCompile(`^Basic ([A-Za-z0-9+/=]+)$`)
	gitProtocol  = regexp.MustCompile(`^[A-Za-z0-9=:,._-]{1,200}$`)
	errSignIn    = fail(http.StatusUnauthorized, signIn)
	errOtherGame = fail(http.StatusForbidden, "This credential reaches another game.")
)

// gitAccess is who may use a game over git: one game or all, whether to push,
// and whether as a project grant, whose pushes move the branches the game has
// and make none (git_hook.go).
type gitAccess struct {
	game   string
	write  bool
	author ident
	grant  bool
}

// credential is the token a git client sent: a Basic password, or a bearer token.
func credential(header string) string {
	if match := bearerToken.FindStringSubmatch(header); match != nil {
		return match[1]
	}
	match := basicToken.FindStringSubmatch(header)
	if match == nil {
		return ""
	}
	// As Buffer.from(…, 'base64') reads it: up to the first "=", without a last character that makes no byte.
	encoded, _, _ := strings.Cut(match[1], "=")
	if len(encoded)%4 == 1 {
		encoded = encoded[:len(encoded)-1]
	}
	decoded, _ := base64.RawStdEncoding.DecodeString(encoded) // every character is base64's, and no padding is left
	text := string(decoded)
	return text[strings.IndexByte(text, ':')+1:]
}

func (s *EditorServer) gitAccess(r *http.Request, access boxAccess) (gitAccess, error) {
	if access.local {
		return gitAccess{write: true, author: ownerIdent}, nil
	}
	token := credential(r.Header.Get("authorization"))
	if grantToken.MatchString(token) {
		if s.box != nil {
			switches, err := s.box.settings.Read()
			if err != nil {
				return gitAccess{}, err
			}
			if !switches.ExternalMCP {
				return gitAccess{}, fail(http.StatusForbidden, "External MCP access is off on this box.")
			}
		}
		if s.mcp == nil {
			return gitAccess{}, fail(http.StatusUnauthorized, "A current project grant is required.")
		}
		g, err := s.mcp.Verify("Bearer " + token)
		if err != nil {
			return gitAccess{}, err
		}
		return gitAccess{game: g.ProjectID, write: g.Write, author: grantAuthor(g.ID), grant: true}, nil
	}
	if holder, ok := s.tokenHolder(token); ok && s.box != nil {
		if holder.kind == "o" {
			devices, err := s.box.pairing.Devices("")
			if err != nil {
				return gitAccess{}, err
			}
			for _, device := range devices {
				if device.ID == holder.id {
					return gitAccess{write: true, author: newIdent(device.Label, "device."+device.ID+"@zirbel.invalid")}, nil
				}
			}
		} else {
			editor, found, err := s.box.editors.Editor(holder.id)
			if err != nil {
				return gitAccess{}, err
			}
			if found {
				return gitAccess{game: editor.Project, write: true, author: newIdent(editor.Name, "editor."+editor.ID+"@zirbel.invalid")}, nil
			}
		}
	}
	// A browser's session, which the door read.
	if access.device != "" {
		return gitAccess{write: true, author: authorOf(access)}, nil
	}
	if access.game != "" {
		return gitAccess{game: access.game, write: true, author: authorOf(access)}, nil
	}
	return gitAccess{}, errSignIn
}

func (s *EditorServer) tokenHolder(token string) (tokenHolder, bool) {
	if s.tokens == nil || token == "" {
		return tokenHolder{}, false
	}
	return s.tokens.holder(token)
}

// serveGit serves /git/…: handled says whether the request was git's.
func (s *EditorServer) serveGit(w http.ResponseWriter, r *http.Request, access boxAccess) (bool, error) {
	pathname := r.URL.EscapedPath()
	if !strings.HasPrefix(pathname, "/git/") {
		return false, nil
	}
	match := gitRoute.FindStringSubmatch(pathname)
	service := ""
	if match != nil {
		service = match[2]
		if service == "info/refs" {
			service = r.URL.Query().Get("service")
		}
	}
	if match == nil || (service != "git-upload-pack" && service != "git-receive-pack") {
		return true, fail(http.StatusNotFound, "Git serves /git/<game>.git over smart HTTP alone.")
	}
	method := http.MethodPost
	if match[2] == "info/refs" {
		method = http.MethodGet
	}
	if r.Method != method {
		w.Header().Set("allow", method)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return true, nil
	}
	who, err := s.gitAccess(r, access)
	if err != nil {
		if known := (*HTTPError)(nil); errors.As(err, &known) && known.Status == http.StatusUnauthorized {
			w.Header().Set("www-authenticate", `Basic realm="Zirbel", charset="UTF-8"`)
		}
		return true, err
	}
	projectID := match[1]
	if !s.projects.Has(projectID) {
		return true, fail(http.StatusNotFound, "Project does not exist.")
	}
	if who.game != "" && who.game != projectID {
		return true, errOtherGame
	}
	if service == "git-receive-pack" && !who.write {
		return true, fail(http.StatusForbidden, "This grant fetches only: pushing needs a write grant.")
	}
	return true, s.backend(w, r, "/"+projectID+".git/"+match[2], who)
}

// statusWriter notes the status a response was given.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// backend runs git http-backend for one request, its CGI answer as the response.
func (s *EditorServer) backend(w http.ResponseWriter, r *http.Request, path string, who gitAccess) error {
	program, err := exec.LookPath("git")
	if err != nil {
		return err
	}
	settings := [][2]string{{"http.receivepack", "true"}, {"receive.denyNonFastForwards", "true"}, {"receive.denyDeletes", "true"},
		{"receive.fsckObjects", "true"}, {"receive.maxInputSize", strconv.Itoa(pushBytes)}, {"receive.autogc", "false"},
		{"transfer.hideRefs", "refs/zirbel"}, {"core.hooksPath", s.hooks}}
	root := filepath.Join(s.projects.root, "git")
	env := []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "PATH_INFO=" + path, "REQUEST_METHOD=" + r.Method,
		"QUERY_STRING=" + r.URL.RawQuery, "CONTENT_TYPE=" + r.Header.Get("content-type"), "REMOTE_ADDR=" + remoteAddress(r),
		"REMOTE_USER=" + who.author.name, "GIT_CONFIG_COUNT=" + strconv.Itoa(len(settings))}
	if who.grant {
		env = append(env, "ZIRBEL_GIT_GRANT=1")
	}
	if protocol := r.Header.Get("git-protocol"); gitProtocol.MatchString(protocol) {
		env = append(env, "GIT_PROTOCOL="+protocol)
	}
	for i, setting := range settings {
		env = append(env, "GIT_CONFIG_KEY_"+strconv.Itoa(i)+"="+setting[0], "GIT_CONFIG_VALUE_"+strconv.Itoa(i)+"="+setting[1])
	}
	// The backend sees the headers it reads alone. A chunked body (a large push) is read to its end, as git
	// http-backend does without a CONTENT_LENGTH.
	request := r.Clone(r.Context())
	request.Header = http.Header{}
	for _, name := range []string{"Content-Type", "Content-Encoding"} {
		if value := r.Header.Get(name); value != "" {
			request.Header.Set(name, value)
		}
	}
	if len(request.TransferEncoding) > 0 {
		request.TransferEncoding, request.ContentLength = nil, -1
	}
	stderr := &tailWriter{}
	written := &statusWriter{ResponseWriter: w}
	handler := &cgi.Handler{Path: program, Args: []string{"http-backend"}, Dir: root, Root: "/git",
		Env: gitEnvironment(env...), Stderr: stderr, Logger: log.Default()}
	handler.ServeHTTP(written, request)
	if said := strings.TrimSpace(stderr.String()); said != "" && (written.status == 0 || written.status >= 500) {
		lines := strings.Split(said, "\n")
		log.Print("git http-backend: " + lines[len(lines)-1])
	}
	return nil
}
