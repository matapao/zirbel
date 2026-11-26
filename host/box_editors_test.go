package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testEditors(t *testing.T) (*Editors, *time.Time) {
	t.Helper()
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	editors, err := NewEditors(filepath.Join(t.TempDir(), "box"), func() time.Time { return at })
	if err != nil {
		t.Fatal(err)
	}
	return editors, &at
}

func TestEditCodesAreSixUnambiguousCharactersReadAsTyped(t *testing.T) {
	for _, typed := range [][2]string{{"abc-def", "ABCDEF"}, {" abc def ", "ABCDEF"}, {"ABCDEF", "ABCDEF"}, {"a-b-c-d-e-f", "ABCDEF"},
		{"LUZ-987", "LUZ987"}, {"ABC-DE", ""}, {"ABC-DEFG", ""}, {"ABC-DE0", ""}, {"ABC-DE1", ""}, {"ABC-DEO", ""}, {"ABC-DEI", ""}, {"", ""}} {
		if got := normalizeEditCode(typed[0]); got != typed[1] {
			t.Errorf("normalizeEditCode(%q) = %q, want %q", typed[0], got, typed[1])
		}
	}
	seen := map[byte]bool{}
	for range 400 {
		code := randomEditCode()
		if !editCodePattern.MatchString(code) {
			t.Fatalf("a code of another form: %q", code)
		}
		for i := range len(code) {
			seen[code[i]] = true
		}
	}
	if len(seen) != len(editAlphabet) || len(editAlphabet) != 32 {
		t.Fatalf("the codes use %d of the alphabet's %d characters", len(seen), len(editAlphabet))
	}
	if shownEditCode("ABCDEF") != "ABC-DEF" || shownEditCode("") != "" {
		t.Fatal("a code is not shown as XXX-XXX")
	}
	token := strings.Repeat("a", 43)
	if editorToken("zirbel_session="+token) != "" || editorToken("a=1; zirbel_editor="+token) != token || editorToken("zirbel_editor=short") != "" {
		t.Fatal("the editor's cookie is read only in the form the box makes, apart from an owner's")
	}
}

func TestAnEditCodeLetsSeveralDevicesEditOneGameForAWeek(t *testing.T) {
	editors, at := testEditors(t)
	code, err := editors.CreateCode("garden")
	if err != nil || !strings.Contains(code.Code, "-") || code.ExpiresAt != "2026-01-09T03:04:05.000Z" {
		t.Fatalf("code %+v %v", code, err)
	}
	if shown, found, err := editors.Code("garden"); err != nil || !found || shown != code {
		t.Fatalf("the game's code: %v %v", shown, err)
	}
	first, game, err := editors.Redeem(strings.ToLower(code.Code), "Ada", "192.168.1.9", "")
	if err != nil || game != "garden" || !sessionPattern.MatchString(first) {
		t.Fatalf("redeem: %q %q %v", first, game, err)
	}
	// Reusable by several people until it expires.
	second, _, err := editors.Redeem(strings.ReplaceAll(code.Code, "-", " "), "Grace", "192.168.1.10", "")
	if err != nil {
		t.Fatal(err)
	}
	editor, editing, err := editors.Session("zirbel_editor=" + second)
	if err != nil || !editing || editor.Project != "garden" || editor.Name != "Grace" {
		t.Fatalf("the second session: %+v %v", editor, err)
	}
	if _, editing, _ := editors.Session("zirbel_session=" + second); editing {
		t.Fatal("an owner's cookie of an editor's token edits")
	}
	// Its last use is written down at most once a minute.
	*at = at.Add(2 * time.Minute)
	if seen, _, _ := editors.Session("zirbel_editor=" + first); seen.LastSeen != isoTime(*at) || seen.Since == seen.LastSeen {
		t.Fatalf("last seen %s, want %s", seen.LastSeen, isoTime(*at))
	}
	// The file keeps the code and each session's hash, never a session.
	data, err := os.ReadFile(editors.file)
	if err != nil || strings.Contains(string(data), first) || strings.Contains(string(data), second) ||
		!strings.Contains(string(data), hashToken(first)) {
		t.Fatalf("editors.json: %s %v", data, err)
	}
	if info, err := os.Stat(editors.file); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("editors.json is not private: %v %v", info, err)
	}
	*at = at.Add(editCodeLifetime)
	if _, _, err := editors.Redeem(code.Code, "Late", "192.168.1.11", ""); statusOf(err) != http.StatusForbidden {
		t.Fatalf("an expired code opens the game: %v", err)
	}
	if shown, found, _ := editors.Code("garden"); found {
		t.Fatalf("an expired code is shown: %+v", shown)
	}
	if _, editing, _ := editors.Session("zirbel_editor=" + first); !editing {
		t.Fatal("the devices editing went with the code")
	}
}

func TestANewCodeReplacesTheOldAndStoppingOneKeepsItsEditors(t *testing.T) {
	editors, _ := testEditors(t)
	old, _ := editors.CreateCode("garden")
	other, _ := editors.CreateCode("walk")
	token, _, err := editors.Redeem(old.Code, "Ada", "192.168.1.9", "")
	if err != nil {
		t.Fatal(err)
	}
	fresh, _ := editors.CreateCode("garden")
	if _, _, err := editors.Redeem(old.Code, "Grace", "192.168.1.9", ""); fresh.Code != old.Code && statusOf(err) != http.StatusForbidden {
		t.Fatalf("the replaced code opens the game: %v", err)
	}
	if _, game, err := editors.Redeem(other.Code, "Grace", "192.168.1.9", ""); err != nil || game != "walk" {
		t.Fatalf("another game's code went with it: %q %v", game, err)
	}
	if err := editors.Stop("garden"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := editors.Redeem(fresh.Code, "Grace", "192.168.1.9", ""); statusOf(err) != http.StatusForbidden {
		t.Fatalf("a stopped code opens the game: %v", err)
	}
	if shown, found, _ := editors.Code("garden"); found {
		t.Fatalf("a stopped code is shown: %+v", shown)
	}
	if _, editing, _ := editors.Session("zirbel_editor=" + token); !editing {
		t.Fatal("stopping the code ended the editing")
	}
	if err := editors.Stop("garden"); err != nil {
		t.Fatalf("stopping no code: %v", err)
	}
}

func TestTheOwnerRemovesAnEditorAndARemovedGameTakesItsEditors(t *testing.T) {
	editors, _ := testEditors(t)
	code, _ := editors.CreateCode("garden")
	token, _, _ := editors.Redeem(code.Code, "Ada", "192.168.1.9", "")
	listed, err := editors.List("garden")
	if err != nil || len(listed) != 1 || listed[0].Name != "Ada" || listed[0].Since != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("the editors: %+v %v", listed, err)
	}
	if others, _ := editors.List("walk"); len(others) != 0 {
		t.Fatalf("another game's editors: %+v", others)
	}
	if err := editors.Remove("walk", listed[0].ID); statusOf(err) != http.StatusNotFound {
		t.Fatalf("an editor is removed from another game: %v", err)
	}
	if err := editors.Remove("garden", listed[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, editing, _ := editors.Session("zirbel_editor=" + token); editing {
		t.Fatal("a removed editor still edits")
	}
	if err := editors.Remove("garden", listed[0].ID); statusOf(err) != http.StatusNotFound {
		t.Fatalf("a removed editor is removed again: %v", err)
	}
	// A device redeeming again, on its editor's session, edits the new game instead: it is listed once.
	again, _, _ := editors.Redeem(code.Code, "Ada", "192.168.1.9", "")
	walk, _ := editors.CreateCode("walk")
	moved, game, err := editors.Redeem(walk.Code, "Ada", "192.168.1.9", "zirbel_editor="+again)
	if err != nil || game != "walk" {
		t.Fatalf("redeeming another game's code: %v", err)
	}
	if left, _ := editors.List("garden"); len(left) != 0 {
		t.Fatalf("the device still edits the first game: %+v", left)
	}
	if err := editors.Forget("walk"); err != nil {
		t.Fatal(err)
	}
	if _, editing, _ := editors.Session("zirbel_editor=" + moved); editing {
		t.Fatal("an editor of a removed game still edits")
	}
	if _, _, err := editors.Redeem(walk.Code, "Ada", "192.168.1.9", ""); statusOf(err) != http.StatusForbidden {
		t.Fatalf("a removed game's code opens it: %v", err)
	}
}

func TestWrongEditCodesAreLimitedPerAddressAndAGameKeepsSoManyEditors(t *testing.T) {
	editors, at := testEditors(t)
	code, _ := editors.CreateCode("garden")
	for range wrongSessionCodes {
		if _, _, err := editors.Redeem("ZZZ-ZZZ", "Ada", "192.168.1.9", ""); statusOf(err) != http.StatusForbidden {
			t.Fatalf("a wrong code: %v", err)
		}
	}
	if _, _, err := editors.Redeem(code.Code, "Ada", "192.168.1.9", ""); statusOf(err) != http.StatusTooManyRequests {
		t.Fatalf("an address past its wrong codes may try again: %v", err)
	}
	*at = at.Add(time.Minute)
	for i := range editorsPerGame {
		if _, _, err := editors.Redeem(code.Code, "Ada", "192.168.1.9", ""); err != nil {
			t.Fatalf("editor %d: %v", i, err)
		}
	}
	if _, _, err := editors.Redeem(code.Code, "Ada", "192.168.1.10", ""); statusOf(err) != http.StatusConflict {
		t.Fatalf("a game past its editors takes another: %v", err)
	}
	for _, name := range []string{"", strings.Repeat("a", editorNameLength+1)} {
		if _, _, err := editors.Redeem(code.Code, name, "192.168.1.10", ""); statusOf(err) != http.StatusBadRequest {
			t.Errorf("the name %q is kept: %v", name, err)
		}
	}
	for _, damaged := range []string{`{"version":1,"codes":[],"editors":[{"id":"x"}]}`, `{"version":1,"codes":[]}`,
		`{"version":1,"codes":[],"editors":[],"more":1}`, `{"version":1,"codes":[{"project":"garden","code":"ABCDEF","createdAt":"2026-01-02T03:04:05.000Z","expiresAt":"2026-01-02T03:04:05.000Z","x":1}],"editors":[]}`,
		`{"version":2,"codes":[],"editors":[]}`} {
		if err := os.WriteFile(editors.file, []byte(damaged), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := editors.List("garden"); statusOf(err) != http.StatusInternalServerError {
			t.Errorf("a damaged store is read: %s %v", damaged, err)
		}
	}
}
