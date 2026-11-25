package main

import (
	"encoding/json"
	"errors"
	"html"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The box's door and its own routes (--box), mirroring packages/server/box-routes.ts.
// The editor listens on every interface, and a request from the box itself
// behaves as without box mode. A request from elsewhere must come from the
// box's own network, and then needs a paired device's session for everything
// but /pair, where a device pairs with a one-time code (or claims a box no
// device has paired with yet), and /mcp while external MCP access is on,
// which checks its own project grant.

// Box is a box's pairing, switches and what it is.
type Box struct {
	pairing      *Pairing
	settings     *BoxSettings
	capabilities boxCapabilities
	port         func() int
	// setupRequest is the file that wakes the box's setup service (pi/setup):
	// a systemd path unit starts the service when it appears.
	setupRequest string
}

func NewBox(account string, port func() int) (*Box, error) {
	folder := account + string(os.PathSeparator) + "box"
	pairing, err := NewPairing(folder, time.Now)
	if err != nil {
		return nil, err
	}
	settings, err := NewBoxSettings(folder)
	if err != nil {
		return nil, err
	}
	return &Box{pairing: pairing, settings: settings, capabilities: detectCapabilities(), port: port,
		setupRequest: env("ZIRBEL_SETUP_REQUEST", "/run/zirbel-setup/request")}, nil
}

// wakeSetup wakes the setup service, which removes the file when it is done. A
// box without the service has no folder for it, and the request stays in the
// settings only.
func wakeSetup(file string) error {
	// The service's group reads the file; its path is the box's own configuration.
	err := os.WriteFile(file, nil, 0o660) // #nosec G304 G306 G703 -- a fixed path from the box's environment, empty
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// boxAccess is who sent a request: the box itself, or a paired device by its
// id (none for a project grant's /mcp request).
type boxAccess struct {
	local  bool
	device string
}

// boxName is the box's name on its network: its host name, in mDNS's .local.
func boxName() string {
	name, _ := os.Hostname()
	name = strings.ToLower(strings.Split(name, ".")[0])
	if name == "" {
		name = "zirbel"
	}
	return name + ".local"
}

// boxNetworks lists the networks of the box's interfaces other than loopback.
func boxNetworks() []*net.IPNet {
	networks := []*net.IPNet{}
	interfaces, _ := net.Interfaces()
	for _, item := range interfaces {
		if item.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, _ := item.Addrs()
		for _, address := range addresses {
			if network, ok := address.(*net.IPNet); ok {
				networks = append(networks, network)
			}
		}
	}
	return networks
}

// boxHosts are the host names a request may reach the box by: loopback, its
// .local and plain names and its addresses now, IPv6 bracketed.
func boxHosts() []string {
	// Its plain name too, which many home routers resolve for the devices that can't look up .local names.
	hosts := []string{"localhost", "127.0.0.1", "[::1]", boxName(), strings.TrimSuffix(boxName(), ".local")}
	for _, network := range boxNetworks() {
		if network.IP.To4() != nil {
			hosts = append(hosts, network.IP.To4().String())
		} else {
			hosts = append(hosts, "["+network.IP.String()+"]")
		}
	}
	return hosts
}

var (
	mappedIPv4   = regexp.MustCompile(`^::ffff:(\d+\.)`)
	privateIPv4  = regexp.MustCompile(`^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|169\.254\.)`)
	privateIPv6  = regexp.MustCompile(`(?i)^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):`)
	loopbackIPv4 = regexp.MustCompile(`^127\.`)
)

func plainAddress(address string) string { return mappedIPv4.ReplaceAllString(address, "$1") }

func isLoopbackAddress(address string) bool {
	peer := plainAddress(address)
	return peer == "::1" || loopbackIPv4.MatchString(peer)
}

// onBoxNetwork: an address that is private, link-local or unique-local, or
// inside the prefix of one of the box's interfaces (a home network's global
// IPv6 addresses).
func onBoxNetwork(address string) bool {
	peer := plainAddress(address)
	if isLoopbackAddress(peer) || privateIPv4.MatchString(peer) || privateIPv6.MatchString(peer) {
		return true
	}
	ip := net.ParseIP(peer)
	for _, network := range boxNetworks() {
		if ip != nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

// remoteAddress is the address a request came from, without its port.
func remoteAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (b *Box) pairLink(code string) string {
	port := ""
	if b.port() != 80 {
		port = ":" + strconv.Itoa(b.port())
	}
	return "http://" + boxName() + port + "/pair?code=" + url.QueryEscape(code)
}

// door decides a request's access, or answers it itself (handled).
func (b *Box) door(w http.ResponseWriter, r *http.Request) (access boxAccess, handled bool, err error) {
	address := remoteAddress(r)
	local := isLoopbackAddress(address)
	if !local && !onBoxNetwork(address) {
		return access, false, fail(http.StatusForbidden, "This box answers only its own network.")
	}
	pathname := r.URL.EscapedPath()
	if pathname == "/pair" {
		return access, true, b.pairRoute(w, r, address)
	}
	if local {
		return boxAccess{local: true}, false, nil
	}
	// A turn's own MCP server is for the harness on the box alone.
	if pathname == "/turn-mcp" {
		return access, false, fail(http.StatusNotFound, "Route does not exist.")
	}
	if pathname == "/mcp" {
		switches, err := b.settings.Read()
		if err != nil {
			return access, false, err
		}
		if !switches.ExternalMCP {
			return access, false, fail(http.StatusForbidden, "External MCP access is off on this box.")
		}
		return access, false, nil
	}
	device, paired, err := b.pairing.Session(r.Header.Get("cookie"))
	if err != nil {
		return access, false, err
	}
	if paired {
		return boxAccess{device: device.ID}, false, nil
	}
	if r.Method == http.MethodGet && !strings.HasPrefix(pathname, "/api/") {
		redirect(w, "/pair")
		return access, true, nil
	}
	return access, false, fail(http.StatusUnauthorized, "Pair this device with the box first.")
}

func redirect(w http.ResponseWriter, location string) {
	w.Header().Set("location", location)
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(http.StatusSeeOther)
}

// pairRoute is the pairing page: a code, or while no device has ever paired, a one-click claim.
func (b *Box) pairRoute(w http.ResponseWriter, r *http.Request, address string) error {
	if r.Method == http.MethodGet {
		_, paired, err := b.pairing.Session(r.Header.Get("cookie"))
		if err != nil {
			return err
		}
		if paired {
			redirect(w, "/")
			return nil
		}
		claimable, err := b.pairing.Claimable()
		if err != nil {
			return err
		}
		pairPage(w, http.StatusOK, claimable, normalizeCode(r.URL.Query().Get("code")), "")
		return nil
	}
	if r.Method != http.MethodPost {
		return fail(http.StatusMethodNotAllowed, "Open the pairing page.")
	}
	if err := checkOrigin(r, true); err != nil {
		return err
	}
	typed := ""
	token, err := func() (string, error) {
		form, err := pairForm(r)
		if err != nil {
			return "", err
		}
		typed = form.Get("code")
		agent := r.Header.Get("user-agent")
		if form.Has("claim") {
			return b.pairing.Claim(agent)
		}
		return b.pairing.Redeem(typed, address, agent)
	}()
	if err != nil {
		var known *HTTPError
		status, message := http.StatusInternalServerError, "The server could not complete that request."
		if errors.As(err, &known) {
			status, message = known.Status, known.Message
		}
		claimable, readErr := b.pairing.Claimable()
		if readErr != nil {
			return readErr
		}
		pairPage(w, status, claimable, normalizeCode(typed), message)
		return nil
	}
	w.Header().Set("set-cookie", sessionCookie+"="+token+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000")
	redirect(w, "/")
	return nil
}

// pairForm reads the pairing form as Node's pairForm does: at most 1024
// characters, and only code (up to 40 characters) and claim ("1").
func pairForm(r *http.Request) (url.Values, error) {
	if media, _, _ := mime.ParseMediaType(r.Header.Get("content-type")); media != "application/x-www-form-urlencoded" {
		return nil, fail(http.StatusUnsupportedMediaType, "Send the pairing form.")
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 4*1024+1))
	if err != nil || utf16Length(string(data)) > 1024 {
		return nil, fail(http.StatusRequestEntityTooLarge, "The pairing form is too long.")
	}
	form, err := url.ParseQuery(string(data))
	if err != nil {
		return nil, fail(http.StatusBadRequest, "Invalid input")
	}
	for key, values := range form {
		value := values[len(values)-1] // the last one, as Object.fromEntries keeps it
		switch {
		case key == "code" && utf16Length(value) <= 40:
		case key == "claim" && value == "1":
		case key == "code":
			return nil, fail(http.StatusBadRequest, "code · Too big: expected string to have <=40 characters")
		case key == "claim":
			return nil, fail(http.StatusBadRequest, "claim · Invalid input: expected \"1\"")
		default:
			return nil, fail(http.StatusBadRequest, "Unrecognized key: \""+key+"\"")
		}
		form.Set(key, value)
	}
	return form, nil
}

// pairPage writes the pairing page as the Node editor does. Its values are
// escaped by html.EscapeString, which writes &amp;, &lt; and &gt; where Node
// writes numeric references: the page with a code is the same character for
// character, and an error with one of those characters says the same.
func pairPage(w http.ResponseWriter, status int, claimable bool, code, problem string) {
	claim := ""
	if claimable {
		claim = `<form method="post"><input type="hidden" name="claim" value="1">
    <p>No device is paired with this box yet. The first one to claim it can pair others.</p>
    <button>Claim this box</button></form><p class="or">or pair with a code</p>`
	}
	alert := ""
	if problem != "" {
		alert = `<p class="error" role="alert">` + html.EscapeString(problem) + `</p>`
	}
	html := `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Pair with Zirbel</title><style>body{font:16px system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.2rem;color:#1d2b24}
h1{font-size:1.5rem}input,button{font:inherit;padding:.6rem .8rem;border-radius:.5rem;border:1px solid #8a9a90}
input{width:100%;box-sizing:border-box;letter-spacing:.15em;text-transform:uppercase}button{margin-top:.8rem;background:#274336;color:#fff;border:0}
.error{color:#a3271f}.or{color:#5c6b62;margin-top:1.6rem}</style></head><body><h1>Pair this device with Zirbel</h1>
` + alert + claim + `<form method="post">
<label for="code">Pairing code, from a device already paired or the box's setup</label>
<input id="code" name="code" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX" value="` + html.EscapeString(code) + `" required>
<button>Pair this device</button></form></body></html>`
	header := w.Header()
	header.Set("content-type", "text/html; charset=utf-8")
	header.Set("cache-control", "no-store")
	// A form posted under no-referrer carries the origin "null": this page's own forms carry its origin.
	header.Set("referrer-policy", "same-origin")
	header.Set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.WriteHeader(status)
	// Not XSS: every value in the page is escaped, and the page has its own CSP.
	// nosemgrep: go.lang.security.audit.xss.no-direct-write-to-responsewriter.no-direct-write-to-responsewriter
	_, _ = w.Write([]byte(html)) // #nosec G705 -- every value in the page is escaped, and the page has its own CSP
}

// boxSettingsView is what a paired device or the box itself sees of the switches.
type boxSettingsView struct {
	Harnesses      bool `json:"harnesses"`
	ExternalMCP    bool `json:"externalMcp"`
	Onboarded      bool `json:"onboarded"`
	SetupRequested bool `json:"setupRequested"`
}

func viewOf(switches boxSwitches) boxSettingsView {
	return boxSettingsView{switches.Harnesses, switches.ExternalMCP, switches.Onboarded, switches.SetupRequested}
}

// health is what the workspace knows of the box, in /api/health.
func (b *Box) health() (map[string]any, error) {
	switches, err := b.settings.Read()
	if err != nil {
		return nil, err
	}
	return map[string]any{"harnesses": switches.Harnesses, "externalMcp": switches.ExternalMCP, "onboarded": switches.Onboarded,
		"setupRequested": switches.SetupRequested, "canRunHarnesses": b.capabilities.Harnesses,
		"harnessesUnavailable": harnessesUnavailable(b.capabilities), "memoryMB": b.capabilities.MemoryMB, "name": boxName()}, nil
}

// serve answers the box's own API, /api/pairing… and /api/box/…; handled says whether it did.
func (b *Box) serve(w http.ResponseWriter, r *http.Request, access boxAccess, resource, pathID, action, tail string) (bool, error) {
	method := r.Method
	if method != http.MethodGet {
		if err := checkOrigin(r, !access.local); err != nil {
			return true, err
		}
	}
	switch {
	case resource == "pairing" && pathID == "" && action == "" && tail == "" && method == http.MethodPost:
		code, expiresAt := b.pairing.CreateCode()
		// The Go host draws no QR codes; the editor shows the link and the code.
		reply(w, http.StatusCreated, map[string]any{"code": code, "url": b.pairLink(code), "expiresAt": expiresAt, "qr": nil})
		return true, nil
	case resource == "pairing" && pathID == "devices" && action == "" && tail == "" && method == http.MethodGet:
		devices, err := b.pairing.Devices(access.device)
		return true, send(w, http.StatusOK, map[string]any{"devices": devices}, err)
	case resource == "pairing" && pathID == "devices" && action != "" && tail == "" && method == http.MethodDelete:
		if !deviceIDText.MatchString(action) {
			return true, fail(http.StatusBadRequest, "Invalid string: must match pattern /^[a-z0-9-]{1,80}$/")
		}
		return true, send(w, http.StatusOK, map[string]any{}, b.pairing.Revoke(action))
	case resource != "box" || action != "" || tail != "":
		return false, nil
	case pathID == "status" && method == http.MethodGet:
		return true, b.status(w, access)
	case pathID == "settings" && method == http.MethodGet:
		switches, err := b.settings.Read()
		return true, send(w, http.StatusOK, viewOf(switches), err)
	case pathID == "settings" && method == http.MethodPut:
		return true, b.change(w, r)
	case pathID == "setup" && method == http.MethodPost:
		return true, b.setup(w, r, access)
	}
	return false, nil
}

func (b *Box) status(w http.ResponseWriter, access boxAccess) error {
	if !access.local {
		return fail(http.StatusForbidden, "Only the box itself reads its status.")
	}
	paired, err := b.pairing.Count()
	if err != nil {
		return err
	}
	claimable, err := b.pairing.Claimable()
	if err != nil {
		return err
	}
	switches, err := b.settings.Read()
	return send(w, http.StatusOK, map[string]any{"box": true, "paired": paired, "claimable": claimable,
		"settings": viewOf(switches), "capabilities": b.capabilities}, err)
}

// change reads settingsChange, a strict object of optional booleans.
func (b *Box) change(w http.ResponseWriter, r *http.Request) error {
	data, err := readBody(r, 4096)
	if err != nil {
		return err
	}
	var input struct {
		Harnesses   *bool `json:"harnesses"`
		ExternalMCP *bool `json:"externalMcp"`
		Onboarded   *bool `json:"onboarded"`
	}
	if err := strictKeys(data, "harnesses", "externalMcp", "onboarded"); err != nil {
		return fail(http.StatusBadRequest, "Invalid input")
	}
	if json.Unmarshal(data, &input) != nil || hasNull(data) {
		return fail(http.StatusBadRequest, "Invalid input: expected boolean")
	}
	if input.Harnesses != nil && *input.Harnesses && !b.capabilities.Harnesses {
		return fail(http.StatusConflict, harnessesUnavailable(b.capabilities))
	}
	switches, err := b.settings.Update(func(next *boxSwitches) {
		if input.Harnesses != nil {
			next.Harnesses = *input.Harnesses
		}
		if input.ExternalMCP != nil {
			next.ExternalMCP = *input.ExternalMCP
		}
		if input.Onboarded != nil {
			next.Onboarded = *input.Onboarded
		}
	})
	return send(w, http.StatusOK, viewOf(switches), err)
}

func (b *Box) setup(w http.ResponseWriter, r *http.Request, access boxAccess) error {
	data, err := readBody(r, 1024)
	if err != nil {
		return err
	}
	var input struct {
		Requested *bool `json:"requested"`
	}
	if strictKeys(data, "requested") != nil || json.Unmarshal(data, &input) != nil || input.Requested == nil {
		return fail(http.StatusBadRequest, "requested · Invalid input: expected boolean")
	}
	if !*input.Requested && !access.local {
		return fail(http.StatusForbidden, "Only the box itself ends its setup.")
	}
	if _, err := b.settings.Update(func(next *boxSwitches) { next.SetupRequested = *input.Requested }); err != nil {
		return err
	}
	if *input.Requested {
		if err := wakeSetup(b.setupRequest); err != nil {
			return err
		}
	}
	reply(w, http.StatusOK, map[string]bool{"setupRequested": *input.Requested})
	return nil
}

// hasNull reports a key whose value is null: Zod's optional booleans refuse it.
func hasNull(data []byte) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return true
	}
	for _, raw := range fields {
		if string(raw) == "null" {
			return true
		}
	}
	return false
}
