package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// The box's pairing (--box), mirroring packages/server/box-pairing.ts: the
// one-time codes that pair a device, and the paired devices' sessions. A code
// lives in memory for ten minutes and pairs one device. A session is a cookie
// of 32 random bytes; the account folder keeps only its SHA-256 (box/paired.json),
// with a label for the device and when it was paired and last seen. A box no
// device has ever paired with may be claimed once, by the first device on its
// network (a box set up over Ethernet has no Bluetooth or hotspot for a code).

// codeAlphabet is Crockford's base32: no I, L, O or U, which read as others.
const codeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

const (
	codeLifetime  = 10 * time.Minute
	wrongCodes    = 10 // wrong codes an address may try in a minute
	pairedDevices = 64
	seenEvery     = time.Minute // how often a session's last use is written down
	sessionCookie = "zirbel_session"
)

var (
	codePattern    = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{8}$`)
	codeSpacing    = regexp.MustCompile(`[\s-]`)
	sessionPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	tokenHashText  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	deviceIDText   = regexp.MustCompile(`^[a-z0-9-]{1,80}$`)
	// isoStamp is z.iso.datetime(): UTC, with or without fractional seconds.
	isoStamp = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$`)
)

type pairedDevice struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	TokenHash string `json:"tokenHash"`
	CreatedAt string `json:"createdAt"`
	LastSeen  string `json:"lastSeen"`
}

// pairedStore is box/paired.json. Claimed: a device has been paired before.
type pairedStore struct {
	Version int            `json:"version"`
	Claimed bool           `json:"claimed"`
	Devices []pairedDevice `json:"devices"`
}

type pendingCode struct {
	hash    [32]byte
	expires time.Time
}
type wrongTries struct {
	since time.Time
	count int
}

// Pairing keeps the codes, the wrong tries and the paired devices.
type Pairing struct {
	mu    sync.Mutex
	file  string
	now   func() time.Time
	codes map[string]pendingCode
	wrong map[string]wrongTries
}

func NewPairing(folder string, now func() time.Time) (*Pairing, error) {
	if err := privateDirectory(folder); err != nil {
		return nil, err
	}
	return &Pairing{file: filepath.Join(folder, "paired.json"), now: now,
		codes: map[string]pendingCode{}, wrong: map[string]wrongTries{}}, nil
}

// isoTime is a time as Node's toISOString writes it.
func isoTime(at time.Time) string { return at.UTC().Format("2006-01-02T15:04:05.000Z") }

// normalizeCode reads a code as a person types it: any case, with or without its
// dash or spaces, O read as 0 and I or L as 1. Empty when it is not a code.
func normalizeCode(input string) string {
	plain := strings.NewReplacer("O", "0", "I", "1", "L", "1").Replace(codeSpacing.ReplaceAllString(strings.ToUpper(input), ""))
	if !codePattern.MatchString(plain) {
		return ""
	}
	return plain[:4] + "-" + plain[4:]
}

// deviceLabel is a short name for the device a browser runs on, from its User-Agent.
func deviceLabel(agent string) string {
	has := func(part string) bool { return strings.Contains(agent, part) }
	browser := "A browser"
	switch {
	case has("Edg/"):
		browser = "Edge"
	case has("Firefox/"):
		browser = "Firefox"
	case has("Chrome/"):
		browser = "Chrome"
	case has("Safari/"):
		browser = "Safari"
	}
	system := ""
	for _, known := range [][2]string{{"iPhone", "iPhone"}, {"iPad", "iPad"}, {"Android", "Android"}, {"CrOS", "ChromeOS"},
		{"Mac OS X", "Mac"}, {"Windows", "Windows"}, {"Linux", "Linux"}} {
		if has(known[0]) {
			system = known[1]
			break
		}
	}
	if system == "" {
		return browser
	}
	return browser + " on " + system
}

// sessionToken is the session a Cookie header carries, in the form this box makes.
func sessionToken(cookie string) string {
	for _, part := range strings.Split(cookie, ";") {
		name, value, _ := strings.Cut(strings.TrimSpace(part), "=")
		if name == sessionCookie && sessionPattern.MatchString(value) {
			return value
		}
	}
	return ""
}

func randomCode() string {
	plain := make([]byte, 8)
	for i := range plain {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(codeAlphabet))))
		if err != nil {
			panic(err)
		}
		plain[i] = codeAlphabet[n.Int64()]
	}
	return string(plain[:4]) + "-" + string(plain[4:])
}

// CreateCode makes a new one-time code, valid for ten minutes.
func (p *Pairing) CreateCode() (code string, expiresAt string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.prune()
	code = randomCode()
	expires := p.now().Add(codeLifetime)
	p.codes[newID()] = pendingCode{sha256.Sum256([]byte(code)), expires}
	return code, isoTime(expires)
}

// Redeem pairs the device that sent a pending code, once: its session's token.
func (p *Pairing) Redeem(input, address, agent string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	at := p.now()
	tries, tried := p.wrong[address]
	if tried && at.Sub(tries.since) < time.Minute && tries.count >= wrongCodes {
		return "", fail(http.StatusTooManyRequests, "Too many wrong codes. Wait a minute and try again.")
	}
	p.prune()
	code := normalizeCode(input)
	hash := sha256.Sum256([]byte(code))
	// Every pending code is compared, in constant time, whichever matches.
	found := ""
	for key, pending := range p.codes {
		if subtle.ConstantTimeCompare(pending.hash[:], hash[:]) == 1 && code != "" {
			found = key
		}
	}
	if found == "" {
		if !tried || at.Sub(tries.since) >= time.Minute {
			tries = wrongTries{since: at}
		}
		tries.count++
		p.wrong[address] = tries
		return "", fail(http.StatusForbidden, "That code is wrong or has expired. Get a new one from a paired device.")
	}
	token, err := p.pair(agent)
	if err == nil {
		delete(p.codes, found)
	}
	return token, err
}

// Claimable: no device was ever paired with the box. Once one has been, it stays
// closed, also after every device is removed; then only a code pairs.
func (p *Pairing) Claimable() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	store, err := p.read()
	return err == nil && !store.Claimed, err
}

// Claim pairs the first device, while the box can be claimed: its session's token.
func (p *Pairing) Claim(agent string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	store, err := p.read()
	if err != nil {
		return "", err
	}
	if store.Claimed {
		return "", fail(http.StatusConflict, "This box is already claimed. Get a code from a paired device.")
	}
	return p.pair(agent)
}

func (p *Pairing) pair(agent string) (string, error) {
	store, err := p.read()
	if err != nil {
		return "", err
	}
	if len(store.Devices) >= pairedDevices {
		return "", fail(http.StatusConflict, "This box has as many paired devices as it keeps. Remove one first.")
	}
	token := base64.RawURLEncoding.EncodeToString(randomBytes(32))
	sum := sha256.Sum256([]byte(token))
	stamp := isoTime(p.now())
	store.Devices = append(store.Devices, pairedDevice{ID: newID(), Label: deviceLabel(agent),
		TokenHash: hex.EncodeToString(sum[:]), CreatedAt: stamp, LastSeen: stamp})
	return token, p.write(store.Devices, true)
}

// Session is the paired device a Cookie header's session belongs to, and
// whether there is one; its last use is noted.
func (p *Pairing) Session(cookie string) (device pairedDevice, paired bool, err error) {
	token := sessionToken(cookie)
	if token == "" {
		return device, false, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	store, err := p.read()
	if err != nil {
		return device, false, err
	}
	hash := sha256.Sum256([]byte(token))
	found := -1
	for i, known := range store.Devices {
		stored, _ := hex.DecodeString(known.TokenHash)
		if subtle.ConstantTimeCompare(stored, hash[:]) == 1 {
			found = i
		}
	}
	if found < 0 {
		return device, false, nil
	}
	if seen, err := time.Parse(time.RFC3339Nano, store.Devices[found].LastSeen); err != nil || p.now().Sub(seen) > seenEvery {
		store.Devices[found].LastSeen = isoTime(p.now())
		if err := p.write(store.Devices, true); err != nil {
			return device, false, err
		}
	}
	return store.Devices[found], true, nil
}

// pairedView is a device as the API shows it: no token hash.
type pairedView struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	CreatedAt string `json:"createdAt"`
	LastSeen  string `json:"lastSeen"`
	Current   bool   `json:"current"`
}

func (p *Pairing) Devices(current string) ([]pairedView, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	store, err := p.read()
	if err != nil {
		return nil, err
	}
	devices := make([]pairedView, 0, len(store.Devices))
	for _, known := range store.Devices {
		devices = append(devices, pairedView{known.ID, known.Label, known.CreatedAt, known.LastSeen, known.ID == current})
	}
	return devices, nil
}

func (p *Pairing) Revoke(deviceID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	store, err := p.read()
	if err != nil {
		return err
	}
	kept := make([]pairedDevice, 0, len(store.Devices))
	for _, known := range store.Devices {
		if known.ID != deviceID {
			kept = append(kept, known)
		}
	}
	if len(kept) == len(store.Devices) {
		return fail(http.StatusNotFound, "That device is not paired.")
	}
	return p.write(kept, store.Claimed)
}

func (p *Pairing) Count() (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	store, err := p.read()
	return len(store.Devices), err
}

func (p *Pairing) prune() {
	at := p.now()
	for key, pending := range p.codes {
		if !pending.expires.After(at) {
			delete(p.codes, key)
		}
	}
	for address, tries := range p.wrong {
		if at.Sub(tries.since) >= time.Minute {
			delete(p.wrong, address)
		}
	}
}

var errPairedUnreadable = fail(http.StatusInternalServerError, "The paired devices could not be read.")

func (p *Pairing) read() (pairedStore, error) {
	data, err := os.ReadFile(p.file)
	if errors.Is(err, os.ErrNotExist) {
		return pairedStore{Version: 1, Devices: []pairedDevice{}}, nil
	}
	if err != nil {
		return pairedStore{}, err
	}
	var store pairedStore
	if strictKeys(data, "version", "claimed", "devices") != nil || json.Unmarshal(data, &store) != nil || store.Version != 1 ||
		store.Devices == nil || len(store.Devices) > pairedDevices {
		return pairedStore{}, errPairedUnreadable
	}
	for _, known := range store.Devices {
		if !idPattern.MatchString(known.ID) || utf16Length(known.Label) > 80 || !tokenHashText.MatchString(known.TokenHash) ||
			!isoStamp.MatchString(known.CreatedAt) || !isoStamp.MatchString(known.LastSeen) {
			return pairedStore{}, errPairedUnreadable
		}
	}
	return store, nil
}

func (p *Pairing) write(devices []pairedDevice, claimed bool) error {
	data, err := json.Marshal(pairedStore{Version: 1, Claimed: claimed, Devices: devices})
	if err != nil {
		return err
	}
	return atomicWrite(p.file, data)
}
