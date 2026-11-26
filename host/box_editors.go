package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
	"unicode/utf8"
)

// A box's editors of one game (--box), mirroring packages/server/box-editors.ts:
// each game's edit code, and the sessions of the devices that redeemed one. A
// game has one code at a time, six characters shown as XXX-XXX, which several
// people may use until it expires a week after it was made or the owner stops
// it; a new code replaces the old, and the devices already editing stay. An
// editor's session is a cookie of 32 random bytes, apart from a paired
// device's; the account folder keeps the codes and only each session's SHA-256
// (box/editors.json, beside paired.json), with the name the device gave and
// when it began and was last seen. Its page is box_editpage.go, what an editor
// may do box_editor_access.go.

// editAlphabet has no 0, 1, I or O, which read as one another.
const editAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

const (
	editCodeLifetime = 7 * 24 * time.Hour
	editorsPerGame   = 64
	editorNameLength = 24   // code points, as Zod counts them
	editorsKept      = 4096 // codes, and editors, the file keeps at most
	editorCookie     = "zirbel_editor"
	// endEditorCookie ends an editor's session on a device, when it pairs as an owner.
	endEditorCookie = editorCookie + "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
)

var (
	editCodePattern = regexp.MustCompile(`^[2-9A-HJ-NP-Z]{6}$`)
	errEditCode     = fail(http.StatusForbidden, "That code doesn't open a game.")
	errEditorsFull  = fail(http.StatusConflict, "This game has as many editors as it keeps. Remove one first.")
	errNoEditor     = fail(http.StatusNotFound, "That device doesn't edit this game.")
	errWrongCodes   = fail(http.StatusTooManyRequests, "Too many wrong codes. Wait a minute and try again.")
	errEditorsStore = fail(http.StatusInternalServerError, "The game editors could not be read.")
	errEditingEnded = fail(http.StatusUnauthorized, "This device’s edit access has ended. Ask the box’s owner for a new edit code.")
)

// editCode is a game's code as box/editors.json keeps it: plain, for the owner sees it again.
type editCode struct {
	Project   string `json:"project"`
	Code      string `json:"code"`
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt"`
}

// gameEditor is a device that edits one game, by the hash of its session.
type gameEditor struct {
	ID        string `json:"id"`
	Project   string `json:"project"`
	Name      string `json:"name"`
	TokenHash string `json:"tokenHash"`
	Since     string `json:"since"`
	LastSeen  string `json:"lastSeen"`
}

// editorsStore is box/editors.json.
type editorsStore struct {
	Version int          `json:"version"`
	Codes   []editCode   `json:"codes"`
	Editors []gameEditor `json:"editors"`
}

// editCodeView is a code as the API shows it.
type editCodeView struct {
	Code      string `json:"code"`
	ExpiresAt string `json:"expiresAt"`
}

// editorView is an editor as the API shows it: no token hash.
type editorView struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Since    string `json:"since"`
	LastSeen string `json:"lastSeen"`
}

// Editors keeps the codes, the editors and the wrong codes tried.
type Editors struct {
	mu    sync.Mutex
	file  string
	now   func() time.Time
	wrong codeTries
}

func NewEditors(folder string, now func() time.Time) (*Editors, error) {
	if err := privateDirectory(folder); err != nil {
		return nil, err
	}
	return &Editors{file: filepath.Join(folder, "editors.json"), now: now, wrong: codeTries{now: now, tries: map[string]wrongTries{}}}, nil
}

// normalizeEditCode reads a code as a person types it: any case, with or
// without its dash or spaces. Empty when it is not a code.
func normalizeEditCode(input string) string {
	plain := codeText(input)
	if !editCodePattern.MatchString(plain) {
		return ""
	}
	return plain
}

// shownEditCode is a plain code as people see it: XXX-XXX.
func shownEditCode(plain string) string {
	if len(plain) != 6 {
		return ""
	}
	return plain[:3] + "-" + plain[3:]
}

func randomEditCode() string {
	plain := randomBytes(6)
	for i, b := range plain {
		plain[i] = editAlphabet[b%byte(len(editAlphabet))] // 256 is a multiple of 32: every letter as likely
	}
	return string(plain)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// editorToken is the editor session a Cookie header carries, in the form this box makes.
func editorToken(cookie string) string { return cookieToken(cookie, editorCookie) }

// live reports whether a code is still good at a time.
func (c editCode) live(at time.Time) bool {
	expires, err := time.Parse(time.RFC3339Nano, c.ExpiresAt)
	return err == nil && expires.After(at)
}

func (c editCode) view() editCodeView { return editCodeView{shownEditCode(c.Code), c.ExpiresAt} }

// CreateCode makes the game's code, in place of the one it had.
func (e *Editors) CreateCode(project string) (editCodeView, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	store, err := e.read()
	if err != nil {
		return editCodeView{}, err
	}
	at := e.now()
	taken := map[string]bool{}
	codes := make([]editCode, 0, len(store.Codes)+1)
	for _, code := range store.Codes {
		if code.Project != project && code.live(at) {
			codes = append(codes, code)
			taken[code.Code] = true
		}
	}
	plain := randomEditCode()
	for taken[plain] { // another game's code now: a code opens one game
		plain = randomEditCode()
	}
	made := editCode{project, plain, isoTime(at), isoTime(at.Add(editCodeLifetime))}
	codes = append(codes, made)
	store.Codes = codes
	return made.view(), e.write(store)
}

// Code is the game's code, and whether it has one that is good.
func (e *Editors) Code(project string) (editCodeView, bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	store, err := e.read()
	if err != nil {
		return editCodeView{}, false, err
	}
	for _, code := range store.Codes {
		if code.Project == project && code.live(e.now()) {
			return code.view(), true, nil
		}
	}
	return editCodeView{}, false, nil
}

// Stop ends the game's code; the devices already editing stay.
func (e *Editors) Stop(project string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	store, err := e.read()
	if err != nil {
		return err
	}
	store.Codes = without(store.Codes, func(code editCode) bool { return code.Project == project })
	return e.write(store)
}

// Redeem makes the device that sent a good code an editor of its game, by the
// name it gave: its session's token and the game. A device that edited a game
// on the session cookie it sends edits this one instead.
func (e *Editors) Redeem(input, name, address, cookie string) (token, project string, err error) {
	// The form has checked it; the store never keeps a name it can't read.
	if name == "" {
		return "", "", fail(http.StatusBadRequest, "Too small: expected string to have >=1 characters")
	}
	if utf8.RuneCountInString(name) > editorNameLength {
		return "", "", fail(http.StatusBadRequest, "Too big: expected string to have <=24 characters")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.wrong.blocked(address) {
		return "", "", errWrongCodes
	}
	store, err := e.read()
	if err != nil {
		return "", "", err
	}
	at := e.now()
	typed := []byte(normalizeEditCode(input))
	// Every good code is compared, in constant time, whichever matches.
	for _, code := range store.Codes {
		if subtle.ConstantTimeCompare([]byte(code.Code), typed) == 1 && code.live(at) {
			project = code.Project
		}
	}
	if project == "" {
		e.wrong.wrong(address)
		return "", "", errEditCode
	}
	if old := editorToken(cookie); old != "" {
		store.Editors = without(store.Editors, func(editor gameEditor) bool { return sameHash(editor.TokenHash, hashToken(old)) })
	}
	count := 0
	for _, editor := range store.Editors {
		if editor.Project == project {
			count++
		}
	}
	if count >= editorsPerGame {
		return "", "", errEditorsFull
	}
	token = base64.RawURLEncoding.EncodeToString(randomBytes(32))
	stamp := isoTime(at)
	store.Editors = append(store.Editors, gameEditor{newID(), project, name, hashToken(token), stamp, stamp})
	return token, project, e.write(store)
}

func sameHash(stored, hash string) bool {
	return subtle.ConstantTimeCompare([]byte(stored), []byte(hash)) == 1
}

// Session is the editor a Cookie header's editor session belongs to, and
// whether there is one; its last use is noted.
func (e *Editors) Session(cookie string) (editor gameEditor, editing bool, err error) {
	token := editorToken(cookie)
	if token == "" {
		return editor, false, nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	store, err := e.read()
	if err != nil {
		return editor, false, err
	}
	hash, found := hashToken(token), -1
	for i, known := range store.Editors {
		if sameHash(known.TokenHash, hash) {
			found = i
		}
	}
	if found < 0 {
		return editor, false, nil
	}
	if seen, err := time.Parse(time.RFC3339Nano, store.Editors[found].LastSeen); err != nil || e.now().Sub(seen) > seenEvery {
		store.Editors[found].LastSeen = isoTime(e.now())
		if err := e.write(store); err != nil {
			return editor, false, err
		}
	}
	return store.Editors[found], true, nil
}

// Editor is an editor by its id, while its session lasts.
func (e *Editors) Editor(id string) (editor gameEditor, found bool, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	store, err := e.read()
	if err != nil {
		return editor, false, err
	}
	for _, known := range store.Editors {
		if known.ID == id {
			return known, true, nil
		}
	}
	return editor, false, nil
}

// End ends the editor's session a Cookie header carries, if it carries one.
func (e *Editors) End(cookie string) error {
	token := editorToken(cookie)
	if token == "" {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	store, err := e.read()
	if err != nil {
		return err
	}
	hash := hashToken(token)
	kept := without(store.Editors, func(editor gameEditor) bool { return sameHash(editor.TokenHash, hash) })
	if len(kept) == len(store.Editors) {
		return nil
	}
	store.Editors = kept
	return e.write(store)
}

// List is the devices that edit the game, the first first.
func (e *Editors) List(project string) ([]editorView, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	store, err := e.read()
	if err != nil {
		return nil, err
	}
	list := []editorView{}
	for _, editor := range store.Editors {
		if editor.Project == project {
			list = append(list, editorView{editor.ID, editor.Name, editor.Since, editor.LastSeen})
		}
	}
	return list, nil
}

// Remove ends a device's editing of the game at once.
func (e *Editors) Remove(project, id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	store, err := e.read()
	if err != nil {
		return err
	}
	kept := without(store.Editors, func(editor gameEditor) bool { return editor.Project == project && editor.ID == id })
	if len(kept) == len(store.Editors) {
		return errNoEditor
	}
	store.Editors = kept
	return e.write(store)
}

// Forget drops a removed game's code and editors.
func (e *Editors) Forget(project string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	store, err := e.read()
	if err != nil {
		return err
	}
	store.Codes = without(store.Codes, func(code editCode) bool { return code.Project == project })
	store.Editors = without(store.Editors, func(editor gameEditor) bool { return editor.Project == project })
	return e.write(store)
}

// without is items but those drop matches, in a new slice.
func without[T any](items []T, drop func(T) bool) []T {
	kept := make([]T, 0, len(items))
	for _, item := range items {
		if !drop(item) {
			kept = append(kept, item)
		}
	}
	return kept
}

func (e *Editors) read() (editorsStore, error) {
	data, err := os.ReadFile(e.file)
	if errors.Is(err, os.ErrNotExist) {
		return editorsStore{Version: 1, Codes: []editCode{}, Editors: []gameEditor{}}, nil
	}
	if err != nil {
		return editorsStore{}, err
	}
	var store editorsStore
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields() // a strict object, its items too
	if decoder.Decode(&store) != nil || decoder.More() || store.Version != 1 || store.Codes == nil || store.Editors == nil || hasNull(data) ||
		len(store.Codes) > editorsKept || len(store.Editors) > editorsKept {
		return editorsStore{}, errEditorsStore
	}
	for _, code := range store.Codes {
		if !idPattern.MatchString(code.Project) || !editCodePattern.MatchString(code.Code) || !isoStamp.MatchString(code.CreatedAt) ||
			!isoStamp.MatchString(code.ExpiresAt) {
			return editorsStore{}, errEditorsStore
		}
	}
	for _, editor := range store.Editors {
		if !idPattern.MatchString(editor.ID) || !idPattern.MatchString(editor.Project) || editor.Name == "" ||
			utf8.RuneCountInString(editor.Name) > editorNameLength || !tokenHashText.MatchString(editor.TokenHash) ||
			!isoStamp.MatchString(editor.Since) || !isoStamp.MatchString(editor.LastSeen) {
			return editorsStore{}, errEditorsStore
		}
	}
	return store, nil
}

// write keeps the store, without the codes that have expired.
func (e *Editors) write(store editorsStore) error {
	at := e.now()
	store.Codes = without(store.Codes, func(code editCode) bool { return !code.live(at) })
	data, err := json.Marshal(store)
	if err != nil {
		return err
	}
	return atomicWrite(e.file, data)
}
