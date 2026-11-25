package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func statusOf(err error) int {
	var known *HTTPError
	if errors.As(err, &known) {
		return known.Status
	}
	return 0
}

func testPairing(t *testing.T) (*Pairing, *time.Time) {
	t.Helper()
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	pairing, err := NewPairing(filepath.Join(t.TempDir(), "box"), func() time.Time { return at })
	if err != nil {
		t.Fatal(err)
	}
	return pairing, &at
}

func TestCodesReadAsTypedAndDevicesAsTheirBrowsers(t *testing.T) {
	for _, typed := range [][2]string{{"abcd-efgh", "ABCD-EFGH"}, {" abcd efgh ", "ABCD-EFGH"}, {"ABCDEFGH", "ABCD-EFGH"},
		{"OIL0-0110", "0110-0110"}, {"ABCD-EFG", ""}, {"ABCD-EFGU", ""}, {"", ""}} {
		if got := normalizeCode(typed[0]); got != typed[1] {
			t.Errorf("normalizeCode(%q) = %q, want %q", typed[0], got, typed[1])
		}
	}
	for agent, want := range map[string]string{
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1": "Safari on iPhone",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36 Edg/140.0":    "Edge on Mac",
		"Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36":                       "Chrome on Android",
		"node": "A browser", "": "A browser",
	} {
		if got := deviceLabel(agent); got != want {
			t.Errorf("deviceLabel(%q) = %q, want %q", agent, got, want)
		}
	}
	token := strings.Repeat("a", 43)
	if sessionToken("other=1; zirbel_session="+token) != token || sessionToken("zirbel_session=short") != "" {
		t.Fatal("the session cookie is read only in the form the box makes")
	}
}

func TestACodePairsOneDeviceOnceWithinTenMinutes(t *testing.T) {
	pairing, at := testPairing(t)
	code, expires := pairing.CreateCode()
	if !codePattern.MatchString(strings.ReplaceAll(code, "-", "")) || expires != "2026-01-02T03:14:05.000Z" {
		t.Fatalf("code %q expires %q", code, expires)
	}
	token, err := pairing.Redeem(strings.ToLower(code), "192.168.1.9", "node")
	if err != nil || !sessionPattern.MatchString(token) {
		t.Fatalf("redeem: %q %v", token, err)
	}
	if _, err := pairing.Redeem(code, "192.168.1.9", "node"); statusOf(err) != http.StatusForbidden {
		t.Fatalf("a used code pairs again: %v", err)
	}
	late, _ := pairing.CreateCode()
	*at = at.Add(codeLifetime)
	if _, err := pairing.Redeem(late, "192.168.1.9", "node"); statusOf(err) != http.StatusForbidden {
		t.Fatalf("an expired code pairs: %v", err)
	}
	device, paired, err := pairing.Session("zirbel_session=" + token)
	if err != nil || !paired || device.Label != "A browser" {
		t.Fatalf("the paired session: %+v %v", device, err)
	}
	if _, paired, _ := pairing.Session("zirbel_session=" + strings.Repeat("b", 43)); paired {
		t.Fatal("an unknown session is paired")
	}
	// Its last use is written down at most once a minute.
	*at = at.Add(2 * time.Minute)
	if seen, _, _ := pairing.Session("zirbel_session=" + token); seen.LastSeen != isoTime(*at) {
		t.Fatalf("last seen %s, want %s", seen.LastSeen, isoTime(*at))
	}
	info, err := os.Stat(pairing.file)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("paired.json is not private: %v %v", info, err)
	}
}

func TestWrongCodesAreLimitedPerAddress(t *testing.T) {
	pairing, at := testPairing(t)
	code, _ := pairing.CreateCode()
	for range wrongCodes {
		if _, err := pairing.Redeem("ZZZZ-ZZZZ", "192.168.1.9", ""); statusOf(err) != http.StatusForbidden {
			t.Fatalf("a wrong code: %v", err)
		}
	}
	if _, err := pairing.Redeem(code, "192.168.1.9", ""); statusOf(err) != http.StatusTooManyRequests {
		t.Fatalf("an address past its wrong codes may try again: %v", err)
	}
	if _, err := pairing.Redeem(code, "192.168.1.10", ""); err != nil {
		t.Fatalf("another address is held back: %v", err)
	}
	*at = at.Add(time.Minute)
	if _, err := pairing.Redeem("ZZZZ-ZZZZ", "192.168.1.9", ""); statusOf(err) != http.StatusForbidden {
		t.Fatalf("a minute later the address may try again: %v", err)
	}
}

func TestABoxIsClaimedOnceAndStaysClaimedWhenItsDevicesGo(t *testing.T) {
	pairing, _ := testPairing(t)
	if claimable, _ := pairing.Claimable(); !claimable {
		t.Fatal("a new box can't be claimed")
	}
	if _, err := pairing.Claim("node"); err != nil {
		t.Fatal(err)
	}
	if _, err := pairing.Claim("node"); statusOf(err) != http.StatusConflict {
		t.Fatalf("a claimed box is claimed again: %v", err)
	}
	devices, _ := pairing.Devices("")
	if err := pairing.Revoke(devices[0].ID); err != nil {
		t.Fatal(err)
	}
	if claimable, _ := pairing.Claimable(); claimable {
		t.Fatal("a box whose devices were all removed can be claimed again")
	}
	if err := pairing.Revoke(devices[0].ID); statusOf(err) != http.StatusNotFound {
		t.Fatalf("an unknown device is revoked: %v", err)
	}
	if err := os.WriteFile(pairing.file, []byte(`{"version":1,"claimed":true,"devices":[{"id":"x"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := pairing.Count(); statusOf(err) != http.StatusInternalServerError {
		t.Fatalf("a damaged store is read: %v", err)
	}
}

func TestSwitchesStartOffAndKeepWhatChanges(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "box")
	settings, err := NewBoxSettings(folder)
	if err != nil {
		t.Fatal(err)
	}
	if switches, _ := settings.Read(); switches != (boxSwitches{Version: 1}) {
		t.Fatalf("defaults %+v", switches)
	}
	if _, err := settings.Update(func(next *boxSwitches) { next.ExternalMCP = true }); err != nil {
		t.Fatal(err)
	}
	again, _ := NewBoxSettings(folder)
	if switches, _ := again.Read(); !switches.ExternalMCP {
		t.Fatal("a change is not kept")
	}
	if err := os.WriteFile(filepath.Join(folder, "settings.json"), []byte(`{"version":1,"harnesses":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	broken, _ := NewBoxSettings(folder)
	if _, err := broken.Read(); statusOf(err) != http.StatusInternalServerError {
		t.Fatalf("incomplete settings are read: %v", err)
	}
	if nodeArch("amd64") != "x64" || nodeArch("arm") != "arm" ||
		!strings.Contains(harnessesUnavailable(boxCapabilities{Arch: "arm"}), "arm system") {
		t.Fatal("the architecture is not named as Node names it")
	}
}

func TestTheDoorLetsInTheBoxAndItsNetworkOnly(t *testing.T) {
	account := t.TempDir()
	box, err := NewBox(account, func() int { return 80 })
	if err != nil {
		t.Fatal(err)
	}
	open := func(method, path, from string) (*httptest.ResponseRecorder, boxAccess, bool, error) {
		r := httptest.NewRequestWithContext(t.Context(), method, path, http.NoBody)
		r.RemoteAddr = from
		w := httptest.NewRecorder()
		access, handled, err := box.door(w, r)
		return w, access, handled, err
	}
	if _, access, handled, err := open("GET", "/api/projects", "127.0.0.1:5000"); err != nil || handled || !access.local {
		t.Fatalf("the box itself: %+v %v %v", access, handled, err)
	}
	if _, _, _, err := open("GET", "/", "203.0.113.5:5000"); statusOf(err) != http.StatusForbidden {
		t.Fatalf("an address off the network: %v", err)
	}
	if w, _, handled, _ := open("GET", "/", "192.168.1.5:5000"); !handled || w.Code != http.StatusSeeOther || w.Header().Get("location") != "/pair" {
		t.Fatalf("an unpaired page: %d %s", w.Code, w.Header().Get("location"))
	}
	for path, status := range map[string]int{"/api/projects": http.StatusUnauthorized, "/mcp": http.StatusForbidden, "/turn-mcp": http.StatusNotFound} {
		if _, _, _, err := open("POST", path, "[fd00::5]:5000"); statusOf(err) != status {
			t.Errorf("%s from the network: %v, want %d", path, err, status)
		}
	}
	if w, _, handled, _ := open("GET", "/pair?code=abcd-efgh", "192.168.1.5:5000"); !handled || w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), `value="ABCD-EFGH"`) || !strings.Contains(w.Body.String(), "Claim this box") {
		t.Fatalf("the pairing page: %d", w.Code)
	}
	if !isLoopbackAddress("::ffff:127.0.0.1") || onBoxNetwork("8.8.8.8") || !onBoxNetwork("fe80::1") ||
		hostnameOf("[FE80::1]:8080") != "[fe80::1]" || hostnameOf("Zirbel.local") != "zirbel.local" || hostnameOf("10.0.0.2:80") != "10.0.0.2" {
		t.Fatal("addresses and host names are not read as Node reads them")
	}
	if info, err := os.Stat(filepath.Join(account, "box")); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the box folder is not private: %v %v", info, err)
	}
}

func TestASetupRequestWakesTheSetupServiceWhereThereIsOne(t *testing.T) {
	folder := t.TempDir()
	if err := wakeSetup(filepath.Join(folder, "no-service", "request")); err != nil {
		t.Fatalf("a box without the setup service fails the request: %v", err)
	}
	box, err := NewBox(folder, func() int { return 80 })
	if err != nil {
		t.Fatal(err)
	}
	box.setupRequest = filepath.Join(folder, "request")
	r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/box/setup", strings.NewReader(`{"requested":true}`))
	r.Header.Set("content-type", "application/json")
	w := httptest.NewRecorder()
	if err := box.setup(w, r, boxAccess{local: true}); err != nil || w.Code != http.StatusOK {
		t.Fatalf("setup: %d %v", w.Code, err)
	}
	if _, err := os.Stat(box.setupRequest); err != nil {
		t.Fatalf("the request wakes no service: %v", err)
	}
	if switches, _ := box.settings.Read(); !switches.SetupRequested {
		t.Fatal("the request is not kept in the settings")
	}
}

func TestThePairingFormTakesOnlyItsFields(t *testing.T) {
	read := func(contentType, body string) error {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/pair", strings.NewReader(body))
		r.Header.Set("content-type", contentType)
		_, err := pairForm(r)
		return err
	}
	for body, status := range map[string]int{"code=ABCD-EFGH": 0, "claim=1": 0, "claim=2": 400, "other=1": 400,
		"code=" + strings.Repeat("A", 41): 400, "code=" + strings.Repeat("A", 1100): 413} {
		if got := statusOf(read("application/x-www-form-urlencoded", body)); got != status {
			t.Errorf("%.20s: %d, want %d", body, got, status)
		}
	}
	if statusOf(read("application/json", "{}")) != http.StatusUnsupportedMediaType {
		t.Fatal("a form of another kind is read")
	}
}
