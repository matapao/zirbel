package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"zirbel/contracts"
	"zirbel/host/webfiles"
)

// PortableFileLimit matches PORTABLE_FILE_LIMIT in packages/sdk/contracts.ts.
const PortableFileLimit = 48_000_000

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,79}$`)

type Asset struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Author  string `json:"author"`
	Source  string `json:"source"`
	License string `json:"license"`
	Credit  string `json:"credit"`
	Hash    string `json:"hash"`
	Media   string `json:"media"`
}

type Permissions struct {
	Play     bool `json:"play"`
	Download bool `json:"download"`
	Remix    bool `json:"remix"`
}

// playerRange is written min first, as Releases.package writes it.
type playerRange struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

type Manifest struct {
	ReleaseID      string            `json:"releaseId"`
	GameID         string            `json:"gameId"`
	SourceRevision string            `json:"sourceRevision"`
	Title          string            `json:"title"`
	Template       string            `json:"template"` // empty for an authored game
	Simulation     *string           `json:"simulation"`
	Players        playerRange       `json:"players"`
	Capabilities   []string          `json:"capabilities"`
	Permissions    Permissions       `json:"permissions"`
	Assets         []Asset           `json:"assets"`
	Files          map[string]string `json:"files"`
}

// Field order follows the Zod schemas in packages/sdk: JSON.stringify of a
// parsed game or scene is what release hashes cover, and Go must match it.
type SceneObject struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	Name        string  `json:"name"`
	X           float64 `json:"x"`
	Y           float64 `json:"y"`
	Size        float64 `json:"size"`
	Color       string  `json:"color"`
	Description *string `json:"description,omitempty"`
	Health      *int    `json:"health,omitempty"`
	Power       *int    `json:"power,omitempty"`
	Requires    *string `json:"requires,omitempty"`
}

type Scene struct {
	ID         string        `json:"id"`
	Background string        `json:"background"`
	Objects    []SceneObject `json:"objects"`
}

type Game struct {
	HTML            string            `json:"html"`
	MaxPlayers      int               `json:"maxPlayers"`
	Net             bool              `json:"net,omitempty"`     // only true: the game brings its own netcode (zirbel-net)
	Adapter         string            `json:"adapter,omitempty"` // with net: one of its files, which its game page loads
	Controls        *Controls         `json:"controls,omitempty"`
	RegisterObjects *bool             `json:"registerObjects,omitempty"`
	Files           map[string]string `json:"files,omitempty"` // a built game's files by path, beside index.html
}

// Release keeps the raw manifest and scene so responses carry them unchanged.
type Release struct {
	Manifest    Manifest
	ManifestRaw json.RawMessage
	Scene       *Scene
	SceneRaw    json.RawMessage
	Game        *Game
	gameRaw     json.RawMessage
	sceneHash   string
	files       map[string]string
	Assets      map[string]string // asset hash -> base64
	canonical   []byte
}

type wireRelease struct {
	Manifest  json.RawMessage   `json:"manifest"`
	Scene     json.RawMessage   `json:"scene"`
	Game      json.RawMessage   `json:"game"`
	SceneHash string            `json:"sceneHash"`
	Files     map[string]string `json:"files"`
	Assets    map[string]string `json:"assets"`
}

// HTTPError carries the status the Node host would answer with.
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return e.Message }

func fail(status int, message string) error { return &HTTPError{status, message} }

// ParseRelease validates a release against contracts/release.schema.json and
// the refinements that JSON Schema cannot express.
func ParseRelease(data []byte) (*Release, error) {
	if err := checkContract("release", data); err != nil {
		return nil, err
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		return nil, fail(http.StatusBadRequest, "Invalid JSON.")
	}
	var wire wireRelease
	if err := json.Unmarshal(compact.Bytes(), &wire); err != nil {
		return nil, fail(http.StatusBadRequest, "Invalid release.")
	}
	release := &Release{ManifestRaw: wire.Manifest, SceneRaw: wire.Scene, gameRaw: wire.Game,
		sceneHash: wire.SceneHash, files: wire.Files, Assets: wire.Assets, canonical: compact.Bytes()}
	if err := json.Unmarshal(wire.Manifest, &release.Manifest); err != nil {
		return nil, fail(http.StatusBadRequest, "Invalid release manifest.")
	}
	if len(wire.Scene) > 0 {
		release.Scene = &Scene{}
		if err := json.Unmarshal(wire.Scene, release.Scene); err != nil {
			return nil, fail(http.StatusBadRequest, "Invalid scene.")
		}
	}
	if len(wire.Game) > 0 {
		release.Game = &Game{MaxPlayers: 1}
		if err := json.Unmarshal(wire.Game, release.Game); err != nil {
			return nil, fail(http.StatusBadRequest, "Invalid game.")
		}
	}
	// The schema checks lengths, trims and URLs; these are Zod refinements.
	if game := release.Game; game != nil {
		if _, entry := game.Files["index.html"]; entry || len(game.Files) > maxGameFiles {
			return nil, fail(http.StatusBadRequest, "game.files · Provide up to 1000 files besides index.html.")
		}
		if err := withinPlayers(game); err != nil {
			return nil, err
		}
		if err := ownAdapter(game); err != nil {
			return nil, err
		}
	}
	if m := release.Manifest; m.Players.Min > m.Players.Max {
		return nil, fail(http.StatusBadRequest, "manifest.players · min exceeds max")
	}
	if m := release.Manifest; m.Players.Max > sharedPlayers && !isNet(m.Simulation) {
		return nil, fail(http.StatusBadRequest, "manifest.players.max · A release for more than 4 players needs net.")
	}
	if release.Scene != nil {
		seen := map[string]bool{}
		for _, object := range release.Scene.Objects {
			if seen[object.ID] {
				return nil, fail(http.StatusBadRequest, "scene.objects · Object IDs must be unique.")
			}
			seen[object.ID] = true
		}
	}
	return release, nil
}

type settings struct {
	simulation   *string
	max          int
	capabilities string
}

func ptr(value string) *string { return &value }

// templates mirrors packages/games/templates.ts.
var templates = map[string]settings{
	"blank":         {nil, 1, ""},
	"mosslight":     {ptr("mosslight-v1"), 4, "multiplayer"},
	"tessellate":    {ptr("tessellate-v1"), 2, "multiplayer"},
	"lantern-quest": {nil, 1, "webgl"},
	"orbit-garden":  {nil, 1, "webgl"},
}

// runtimeSettings mirrors runtimeSettings in packages/core/releases.ts: an
// authored game declares its own players, a scene project runs its template.
func runtimeSettings(template string, game *Game) (settings, error) {
	if game != nil {
		if game.Net {
			return settings{ptr(netSimulation), game.MaxPlayers, "multiplayer"}, nil
		}
		if game.MaxPlayers > 1 {
			return settings{ptr("shared-state-v1"), game.MaxPlayers, "multiplayer"}, nil
		}
		return settings{nil, game.MaxPlayers, ""}, nil
	}
	if found, ok := templates[template]; ok {
		return found, nil
	}
	return settings{}, fail(http.StatusUnprocessableEntity, "This project has no game source yet.")
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Verify mirrors Releases.import: declared capabilities, content hash, the
// runtime build and every delivered asset must match.
func Verify(release *Release, runtime map[string]*webfiles.File) error {
	m := release.Manifest
	if release.Game == nil && release.Scene == nil {
		return fail(http.StatusUnprocessableEntity, "The release has no playable content.")
	}
	want, err := runtimeSettings(m.Template, release.Game)
	if err != nil {
		return err
	}
	if !sameSimulation(m.Simulation, want.simulation) || m.Players.Max != want.max || m.Players.Min != 1 ||
		strings.Join(m.Capabilities, ",") != want.capabilities {
		return fail(http.StatusUnprocessableEntity, "The package declares unsupported game capabilities.")
	}
	// The Node host hashes JSON.stringify of the parsed game or scene. Zirbel
	// writes releases with JSON.stringify, so the compact bytes are the same.
	content := release.gameRaw
	if len(content) == 0 {
		content = release.SceneRaw
	}
	if digest(content) != release.sceneHash {
		return fail(http.StatusUnprocessableEntity, "The game content hash does not match.")
	}
	if len(release.files) != len(runtime) || len(m.Files) != len(runtime) {
		return fail(http.StatusUnprocessableEntity, "The package has unsupported runtime files.")
	}
	for name, file := range runtime {
		data, ok := release.files[name]
		decoded, err := base64.StdEncoding.DecodeString(data)
		if !ok || err != nil || m.Files[name] != file.Hash || digest(decoded) != file.Hash {
			return fail(http.StatusUnprocessableEntity, "This package requires a verified build of the matching Zirbel runtime.")
		}
	}
	assets, err := deliveryAssets(m.Assets)
	if err != nil {
		return err
	}
	gameFiles := gameFileHashes(release.Game)
	declared := map[string]bool{}
	for _, asset := range assets {
		declared[asset.Hash] = true
	}
	for _, hash := range gameFiles {
		declared[hash] = true
	}
	if len(release.Assets) != len(declared) {
		return fail(http.StatusUnprocessableEntity, "The package has undeclared assets.")
	}
	for _, asset := range assets {
		data, ok := release.Assets[asset.Hash]
		if !ok {
			return fail(http.StatusUnprocessableEntity, "An asset file is missing.")
		}
		if _, err := decodeAsset(asset, data); err != nil {
			return err
		}
	}
	for _, hash := range gameFiles {
		if _, err := gameFileBytes(hash, release.Assets); err != nil {
			return err
		}
	}
	return nil
}

func sameSimulation(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// deliveryAssets mirrors deliveryAssets and checkDeliveryRights in packages/core/projects.ts.
func deliveryAssets(assets []Asset) ([]Asset, error) {
	unique := map[string]Asset{}
	order := []string{}
	for _, asset := range assets {
		if asset.License == "unknown" || asset.License == "local-only" {
			return nil, fail(http.StatusUnprocessableEntity, "Resolve the delivery rights for "+asset.Name+".")
		}
		if asset.License != "CC0-1.0" && contracts.Trim(asset.Credit) == "" {
			return nil, fail(http.StatusUnprocessableEntity, "Add the required credit for "+asset.Name+".")
		}
		// Contracts accept only sources new URL() parses, as Zod does.
		source, ok := contracts.ParseURL(asset.Source)
		if !ok {
			return nil, fail(http.StatusBadRequest, "The source URL for "+asset.Name+" is invalid.")
		}
		if source.Credentials {
			return nil, fail(http.StatusUnprocessableEntity, "Remove account credentials from the source URL for "+asset.Name+".")
		}
		if previous, ok := unique[asset.Hash]; ok && previous.Media != asset.Media {
			return nil, fail(http.StatusUnprocessableEntity, "Conflicting media types for "+asset.Name+".")
		}
		if _, ok := unique[asset.Hash]; !ok {
			order = append(order, asset.Hash)
		}
		unique[asset.Hash] = asset
	}
	result := make([]Asset, 0, len(order))
	for _, hash := range order {
		result = append(result, unique[hash])
	}
	return result, nil
}

func mediaMatches(media string, data []byte) bool {
	switch media {
	case "image/png":
		return bytes.HasPrefix(data, []byte{137, 80, 78, 71, 13, 10, 26, 10})
	case "image/jpeg":
		return bytes.HasPrefix(data, []byte{255, 216, 255})
	case "image/webp":
		return len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP"
	}
	return false
}

// Releases stores verified releases in <data>/releases, like the Node host.
type Releases struct {
	dir     string
	runtime map[string]*webfiles.File
}

func NewReleases(root string, runtime map[string]*webfiles.File) (*Releases, error) {
	dir := filepath.Join(root, "releases")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Releases{dir, runtime}, nil
}

func (r *Releases) path(id string) (string, error) {
	if !idPattern.MatchString(id) {
		return "", fail(http.StatusBadRequest, "Invalid release ID.")
	}
	return filepath.Join(r.dir, id+".json"), nil
}

// Import imports a release file named on the command line.
func (r *Releases) Import(file string) error {
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() || info.Size() > PortableFileLimit {
		return errors.New("import a release file under 48 MB")
	}
	data, err := os.ReadFile(file) // #nosec G304 -- the operator names this file with --import
	if err != nil {
		return err
	}
	_, err = r.ImportData(data)
	return err
}

// store saves a verified release unless that ID already holds a different one.
func (r *Releases) store(release *Release) (*Release, error) {
	path, err := r.path(release.Manifest.ReleaseID)
	if err != nil {
		return nil, err
	}
	existing, err := r.Read(release.Manifest.ReleaseID)
	var missing *HTTPError
	switch {
	case err == nil:
		if !sameRelease(existing, release) {
			return nil, fail(http.StatusConflict, "That release ID already identifies a different package.")
		}
		return existing, nil
	case errors.As(err, &missing) && missing.Status == http.StatusNotFound:
		return release, atomicWrite(path, release.canonical)
	default:
		// Never overwrite a stored release this host cannot read.
		return nil, err
	}
}

// sameRelease compares releases as parsed JSON, like the Node host: a host
// that re-serializes a release may write its keys in another order.
func sameRelease(a, b *Release) bool {
	if bytes.Equal(a.canonical, b.canonical) {
		return true
	}
	left, errLeft := contracts.Decode(a.canonical)
	right, errRight := contracts.Decode(b.canonical)
	return errLeft == nil && errRight == nil && contracts.Equal(left, right)
}

func (r *Releases) Read(id string) (*Release, error) {
	path, err := r.path(id)
	if err != nil {
		return nil, err
	}
	data, err := readFile(path)
	if err != nil {
		return nil, err
	}
	release, err := ParseRelease(data)
	if err != nil {
		return nil, err
	}
	if release.Manifest.ReleaseID != id {
		return nil, fail(http.StatusUnprocessableEntity, "The stored release ID does not match its filename.")
	}
	return release, nil
}

func atomicWrite(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(temp.Name()) }() // #nosec G703 -- a temporary file we just created
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path) // #nosec G703 -- callers build path from the data directory and a validated ID
}
