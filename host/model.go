package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"zirbel/contracts"
)

// The project model mirrors packages/sdk/contracts.ts, with fields in schema
// order. Files written here are read by the Node editor and the other way round.
type Revision struct {
	ID           string  `json:"id"`
	Parent       *string `json:"parent"`
	RestoredFrom string  `json:"restoredFrom,omitempty"`
	Label        string  `json:"label"`
	Date         string  `json:"date"`
	Scene        *Scene  `json:"scene,omitempty"`
	Game         *Game   `json:"game,omitempty"`
	Assets       []Asset `json:"assets"`
}
type Attachment struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Intent     string `json:"intent"`
	Media      string `json:"media"`
	Transcript string `json:"transcript"`
	Original   string `json:"original,omitempty"`
}
type Note struct {
	ID           string          `json:"id"`
	Text         string          `json:"text"`
	Date         string          `json:"date"`
	Branch       string          `json:"branch"`
	References   []Reference     `json:"references"`
	Attachments  []string        `json:"attachments"`
	Role         string          `json:"role,omitempty"`
	Usage        json.RawMessage `json:"usage,omitempty"`
	DesignPrompt string          `json:"designPrompt,omitempty"`
}
type Bounds struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Reference is an instance or region reference; MarshalJSON writes only the
// fields of its type, as the strict Zod union requires.
type Reference struct {
	Type     string        `json:"type"`
	SceneID  string        `json:"sceneId"`
	Revision string        `json:"revision"`
	Object   *SceneObject  `json:"object,omitempty"`
	Bounds   *Bounds       `json:"bounds,omitempty"`
	Objects  []SceneObject `json:"objects,omitempty"`
}

func (r Reference) MarshalJSON() ([]byte, error) {
	if r.Type == "instance" {
		return jsJSON(struct {
			Type     string       `json:"type"`
			SceneID  string       `json:"sceneId"`
			Revision string       `json:"revision"`
			Object   *SceneObject `json:"object"`
		}{r.Type, r.SceneID, r.Revision, r.Object})
	}
	objects := r.Objects
	if objects == nil {
		objects = []SceneObject{}
	}
	return jsJSON(struct {
		Type     string        `json:"type"`
		SceneID  string        `json:"sceneId"`
		Revision string        `json:"revision"`
		Bounds   *Bounds       `json:"bounds"`
		Objects  []SceneObject `json:"objects"`
	}{r.Type, r.SceneID, r.Revision, r.Bounds, objects})
}

type Project struct {
	Version     int               `json:"version"`
	ID          string            `json:"id"`
	Title       string            `json:"title"`
	Template    string            `json:"template,omitempty"`
	Branches    map[string]string `json:"branches"`
	Revisions   []Revision        `json:"revisions"`
	Notes       []Note            `json:"notes"`
	Attachments []Attachment      `json:"attachments"`
	Upstream    string            `json:"upstream,omitempty"`
	Imported    bool              `json:"imported,omitempty"`
}
type Operation struct {
	Op      string                     `json:"op"`
	Game    *Game                      `json:"game,omitempty"`
	Object  *SceneObject               `json:"object,omitempty"`
	ID      string                     `json:"id,omitempty"`
	Changes map[string]json.RawMessage `json:"changes,omitempty"`
	Color   string                     `json:"color,omitempty"`
	Asset   *Asset                     `json:"asset,omitempty"`
}
type Proposal struct {
	BaseRevision string      `json:"baseRevision"`
	Branch       string      `json:"branch"`
	Label        string      `json:"label"`
	Operations   []Operation `json:"operations"`
	ID           string      `json:"id"`
	ProjectID    string      `json:"projectId"`
	Date         string      `json:"date"`
}

// Results in the key order the Node editor writes them; MCP clients receive
// them as JSON text, so the order is part of the response.
type proposalResult struct {
	Proposal *Proposal `json:"proposal"`
	Preview  *Preview  `json:"preview"`
}
type commitResult struct {
	Revision *Revision `json:"revision"`
	Branch   string    `json:"branch"`
}

// Preview is the candidate revision content of a proposal.
type Preview struct {
	Game   *Game   `json:"game,omitempty"`
	Scene  *Scene  `json:"scene,omitempty"`
	Assets []Asset `json:"assets"`
}

func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// trimmed applies Zod's .trim().min(1).max(n) to a field that Zod transforms.
// Zod trims like JavaScript and counts code points.
func trimmed(field, value string, max int) (string, error) {
	value = contracts.Trim(value)
	// A string has at most as many code points as bytes, so count only when the bytes exceed the limit.
	if value == "" || (len(value) > max && utf8.RuneCountInString(value) > max) {
		return "", fail(http.StatusBadRequest, field+" · Expected 1 to "+strconv.Itoa(max)+" characters")
	}
	return value, nil
}

// normalizeSource keeps the source URL as Zod's url check leaves it.
func normalizeSource(asset *Asset) {
	if source, ok := contracts.ParseURL(asset.Source); ok {
		asset.Source = source.Value
	}
}

// insideWorld is the refinement on a region reference's bounds in sceneReference.
func insideWorld(reference Reference) error {
	if b := reference.Bounds; b != nil && (b.X+b.Width > worldWidth || b.Y+b.Height > worldHeight) {
		return fail(http.StatusBadRequest, "references.bounds · Invalid input")
	}
	return nil
}
func normalizeScene(scene *Scene) error {
	if scene == nil {
		return nil
	}
	if scene.Objects == nil {
		scene.Objects = []SceneObject{}
	}
	seen := map[string]bool{}
	for i := range scene.Objects {
		object := &scene.Objects[i]
		name, err := trimmed("scene.objects.name", object.Name, 80)
		if err != nil {
			return err
		}
		object.Name = name
		if seen[object.ID] {
			return fail(http.StatusBadRequest, "scene.objects · Object IDs must be unique.")
		}
		seen[object.ID] = true
	}
	return nil
}
func normalizeGame(game *Game) error {
	if game == nil {
		return nil
	}
	html, err := trimmed("game.html", game.HTML, 400_000)
	if err != nil {
		return err
	}
	game.HTML = html
	if game.MaxPlayers == 0 {
		game.MaxPlayers = 1
	}
	return nil
}

// normalizeProject applies what project.parse does beyond the JSON Schema.
func normalizeProject(p *Project) error {
	title, err := trimmed("title", p.Title, 80)
	if err != nil {
		return err
	}
	p.Title = title
	if p.Notes == nil {
		p.Notes = []Note{}
	}
	if p.Attachments == nil {
		p.Attachments = []Attachment{}
	}
	for i := range p.Revisions {
		revision := &p.Revisions[i]
		if revision.Assets == nil {
			revision.Assets = []Asset{}
		}
		for j := range revision.Assets {
			normalizeSource(&revision.Assets[j])
		}
		if err := normalizeScene(revision.Scene); err != nil {
			return err
		}
		if err := normalizeGame(revision.Game); err != nil {
			return err
		}
	}
	for i := range p.Notes {
		note := &p.Notes[i]
		if note.References == nil {
			note.References = []Reference{}
		}
		for _, reference := range note.References {
			if err := insideWorld(reference); err != nil {
				return err
			}
		}
		if note.Attachments == nil {
			note.Attachments = []string{}
		}
	}
	return nil
}
