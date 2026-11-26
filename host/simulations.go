package main

import (
	"bytes"
	"encoding/json"
	"math"
	"slices"
	"unicode/utf16"

	"zirbel/contracts"
)

// simulation mirrors the Simulation interface in packages/games/simulations.ts.
// Rooms call it with the room lock held.
type simulation interface {
	add(seat string)
	remove(seat string)
	suspend(seat string)
	apply(seat string, action json.RawMessage) string // a rejection message, or ""
	tick(dt float64) bool
	snapshot() any
}

func newSimulation(release *Release, solo bool) simulation {
	if release.Manifest.Simulation == nil {
		return nil
	}
	switch *release.Manifest.Simulation {
	case "shared-state-v1":
		return &sharedState{states: map[string]json.RawMessage{}}
	case "mosslight-v1":
		return newMosslight(release.Scene)
	case "tessellate-v1":
		return newTessellate(solo)
	}
	return nil
}

// utf16Length counts like a JavaScript string's length.
func utf16Length(text string) int {
	n := 0
	for _, r := range text {
		n += utf16.RuneLen(r)
	}
	return n
}

// boundedJSON mirrors boundedJson in packages/sdk/bounded.ts.
func boundedJSON(value any, depth int, remaining *int) bool {
	if depth > 8 {
		return false
	}
	*remaining--
	if *remaining < 0 {
		return false
	}
	switch v := value.(type) {
	case string:
		return utf16Length(v) <= 2048
	case nil, bool:
		return true
	case json.Number:
		f, err := v.Float64()
		return err == nil && !math.IsInf(f, 0) && !math.IsNaN(f)
	case []any:
		if len(v) > *remaining {
			return false
		}
		for _, item := range v {
			if !boundedJSON(item, depth+1, remaining) {
				return false
			}
		}
		return true
	case map[string]any:
		for key, item := range v {
			if utf16Length(key) > 128 || !boundedJSON(item, depth+1, remaining) {
				return false
			}
		}
		return true
	}
	return false
}

// compactState checks a shared-state value and returns its compact JSON, which
// keeps the sender's key order like the Node host does.
func compactState(raw json.RawMessage) (json.RawMessage, bool) {
	value, err := contracts.Decode(raw)
	remaining := 256
	if err != nil || !boundedJSON(value, 0, &remaining) {
		return nil, false
	}
	var out bytes.Buffer
	if json.Compact(&out, raw) != nil || utf16Length(out.String()) > 4096 {
		return nil, false
	}
	return out.Bytes(), true
}

type sharedState struct {
	order   []string
	states  map[string]json.RawMessage
	changed bool
}

func (s *sharedState) add(string)     {}
func (s *sharedState) suspend(string) {}
func (s *sharedState) remove(seat string) {
	if _, ok := s.states[seat]; !ok {
		return
	}
	delete(s.states, seat)
	for i, id := range s.order {
		if id == seat {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}
func (s *sharedState) apply(seat string, action json.RawMessage) string {
	state, ok := compactState(action)
	if !ok {
		return "Send a compact JSON state."
	}
	if _, exists := s.states[seat]; !exists {
		s.order = append(s.order, seat)
	}
	s.states[seat] = state
	s.changed = true
	return ""
}
func (s *sharedState) tick(float64) bool {
	changed := s.changed
	s.changed = false
	return changed
}
func (s *sharedState) snapshot() any { return orderedObject{s.order, s.states} }

// orderedObject marshals a JSON object in insertion order.
type orderedObject struct {
	keys   []string
	values map[string]json.RawMessage
}

func (o orderedObject) MarshalJSON() ([]byte, error) { //nolint:unparam // json.Marshaler requires the error result
	var out bytes.Buffer
	out.WriteByte('{')
	for i, key := range o.keys {
		if i > 0 {
			out.WriteByte(',')
		}
		name, _ := json.Marshal(key)
		out.Write(name)
		out.WriteByte(':')
		out.Write(o.values[key])
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

// strictFields decodes a JSON object whose keys must be exactly the given set.
func strictFields(raw json.RawMessage, keys ...string) (map[string]json.RawMessage, bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil || len(fields) != len(keys) {
		return nil, false
	}
	for _, key := range keys {
		if _, ok := fields[key]; !ok {
			return nil, false
		}
	}
	return fields, true
}

func literal(raw json.RawMessage, want string) bool {
	var value string
	return json.Unmarshal(raw, &value) == nil && value == want
}

// number decodes a JSON number; null is not a number (Go would decode it as 0).
func number(raw json.RawMessage) (float64, bool) {
	var value *float64
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return 0, false
	}
	return *value, true
}

const worldWidth, worldHeight = 960.0, 600.0

type explorer struct {
	ID     string  `json:"id"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Color  string  `json:"color"`
	Score  int     `json:"score"`
	dx, dy float64
}

type light struct {
	id   string
	x, y float64
}

type mosslight struct {
	spawnX, spawnY float64
	lights         []light
	explorers      []*explorer
	collected      []string
}

func newMosslight(scene *Scene) *mosslight {
	game := &mosslight{spawnX: 240, spawnY: 340}
	if scene == nil {
		return game
	}
	spawned := false
	for _, object := range scene.Objects {
		if object.Kind == "spawn" && !spawned {
			game.spawnX, game.spawnY, spawned = object.X, object.Y, true
		}
		if object.Kind == "crystal" {
			game.lights = append(game.lights, light{object.ID, object.X, object.Y})
		}
	}
	return game
}

func (g *mosslight) find(seat string) *explorer {
	for _, player := range g.explorers {
		if player.ID == seat {
			return player
		}
	}
	return nil
}

func (g *mosslight) add(seat string) {
	color := "#ffffff"
	for _, candidate := range []string{"#e6fa9e", "#a5dcf1", "#edabcb", "#edbf87"} {
		used := false
		for _, player := range g.explorers {
			used = used || player.Color == candidate
		}
		if !used {
			color = candidate
			break
		}
	}
	if existing := g.find(seat); existing != nil {
		*existing = explorer{ID: seat, X: g.spawnX + float64(len(g.explorers))*18, Y: g.spawnY, Color: color}
		return
	}
	g.explorers = append(g.explorers, &explorer{ID: seat, X: g.spawnX + float64(len(g.explorers))*18, Y: g.spawnY, Color: color})
}

func (g *mosslight) remove(seat string) {
	for i, player := range g.explorers {
		if player.ID == seat {
			g.explorers = append(g.explorers[:i], g.explorers[i+1:]...)
			return
		}
	}
}

func (g *mosslight) suspend(seat string) {
	if player := g.find(seat); player != nil {
		player.dx, player.dy = 0, 0
	}
}

func (g *mosslight) apply(seat string, action json.RawMessage) string {
	fields, ok := strictFields(action, "type", "x", "y")
	player := g.find(seat)
	if !ok || player == nil || !literal(fields["type"], "move") {
		return "Use a valid movement vector."
	}
	x, okX := number(fields["x"])
	y, okY := number(fields["y"])
	if !okX || !okY || x < -1 || x > 1 || y < -1 || y > 1 {
		return "Use a valid movement vector."
	}
	length := math.Max(1, math.Hypot(x, y))
	player.dx, player.dy = x/length, y/length
	return ""
}

func (g *mosslight) tick(dt float64) bool {
	changed := false
	for _, player := range g.explorers {
		if player.dx == 0 && player.dy == 0 {
			continue
		}
		x := math.Max(24, math.Min(worldWidth-24, player.X+player.dx*155*dt))
		y := math.Max(30, math.Min(worldHeight-18, player.Y+player.dy*155*dt))
		changed = changed || x != player.X || y != player.Y
		player.X, player.Y = x, y
		for _, item := range g.lights {
			if slices.Contains(g.collected, item.id) || math.Hypot(x-item.x, y-item.y) >= 23 {
				continue
			}
			g.collected = append(g.collected, item.id)
			player.Score++
		}
	}
	return changed
}

func (g *mosslight) snapshot() any {
	explorers := make([]explorer, 0, len(g.explorers))
	for _, player := range g.explorers {
		explorers = append(explorers, *player)
	}
	collected := append([]string{}, g.collected...)
	return struct {
		Explorers []explorer `json:"explorers"`
		Collected []string   `json:"collected"`
		Total     int        `json:"total"`
		Finished  bool       `json:"finished"`
	}{explorers, collected, len(g.lights), len(g.lights) > 0 && len(g.collected) == len(g.lights)}
}

var tileLines = [8][3]int{{0, 1, 2}, {3, 4, 5}, {6, 7, 8}, {0, 3, 6}, {1, 4, 7}, {2, 5, 8}, {0, 4, 8}, {2, 4, 6}}

type tessellate struct {
	board  [9]*string
	order  []string
	turn   *string
	winner *string
	draw   bool
	solo   bool
}

func newTessellate(solo bool) *tessellate { return &tessellate{solo: solo} }

func (g *tessellate) clear() {
	g.board = [9]*string{}
	g.winner, g.draw, g.turn = nil, false, nil
	if len(g.order) == 2 {
		g.turn = new(g.order[0])
	}
}

func (g *tessellate) place(seat string, cell int) {
	g.board[cell] = new(seat)
	for _, line := range tileLines {
		if owns(g.board[line[0]], seat) && owns(g.board[line[1]], seat) && owns(g.board[line[2]], seat) {
			g.winner = new(seat)
		}
	}
	full := true
	for _, value := range g.board {
		full = full && value != nil
	}
	g.draw = g.winner == nil && full
	g.turn = nil
	if g.winner == nil && !g.draw {
		for _, candidate := range g.order {
			if candidate != seat {
				g.turn = new(candidate)
				break
			}
		}
	}
}

func owns(cell *string, seat string) bool { return cell != nil && *cell == seat }

func (g *tessellate) add(seat string) {
	g.order = append(g.order, seat)
	if g.solo {
		g.order = append(g.order, "bot")
	}
	if len(g.order) == 2 {
		g.clear()
	}
}

func (g *tessellate) remove(seat string) {
	kept := g.order[:0]
	for _, candidate := range g.order {
		if candidate != seat && candidate != "bot" {
			kept = append(kept, candidate)
		}
	}
	g.order = kept
	g.clear()
}

func (g *tessellate) suspend(string) {}

func (g *tessellate) apply(seat string, action json.RawMessage) string {
	if fields, ok := strictFields(action, "type"); ok && literal(fields["type"], "reset") {
		if (g.winner != nil || g.draw) && slices.Contains(g.order, seat) {
			g.clear()
			return ""
		}
	}
	fields, ok := strictFields(action, "type", "cell")
	value, isNumber := number(fields["cell"])
	if !ok || !literal(fields["type"], "place") || !isNumber || value != math.Trunc(value) || value < 0 || value > 8 {
		return "Choose an open tile."
	}
	cell := int(value)
	if g.turn == nil || *g.turn != seat {
		return "Wait for your turn."
	}
	if g.board[cell] != nil {
		return "That tile is occupied."
	}
	g.place(seat, cell)
	if g.turn != nil && *g.turn == "bot" {
		for _, next := range []int{4, 0, 8, 2, 6, 1, 3, 5, 7} {
			if g.board[next] == nil {
				g.place("bot", next)
				break
			}
		}
	}
	return ""
}

func (g *tessellate) tick(float64) bool { return false }

func (g *tessellate) snapshot() any {
	return struct {
		Board  [9]*string `json:"board"`
		Order  []string   `json:"order"`
		Turn   *string    `json:"turn"`
		Winner *string    `json:"winner"`
		Draw   bool       `json:"draw"`
		Solo   bool       `json:"solo"`
	}{g.board, append([]string{}, g.order...), g.turn, g.winner, g.draw, g.solo}
}
