package main

import (
	"regexp"
	"unicode/utf16"
)

// Controls mirrors gameControls in packages/sdk/game.ts (and
// packages/sdk/controls.ts): the keyboard codes a game's zirbel.json gives the
// inputs of the standard gamepad layout, which the game frame presses as a
// keyboard would. Keys are P1's; Players gives each place (P1 to P8) its own
// keys, and the name and colour of what it drives.
type Controls struct {
	Keys    map[string]string `json:"keys,omitempty"`
	Players []ControlPlayer   `json:"players,omitempty"`
}

// ControlPlayer is one place's keys, name and colour, each where given.
type ControlPlayer struct {
	Keys  map[string]string `json:"keys,omitempty"`
	Name  string            `json:"name,omitempty"`
	Color string            `json:"color,omitempty"`
}

// controlInputs mirrors CONTROL_INPUTS, keyCode KEY_CODE, placeColor
// PLACE_COLOR, and the rest the limits beside them.
var (
	controlInputs = map[string]bool{"a": true, "b": true, "x": true, "y": true, "lb": true, "rb": true, "lt": true, "rt": true,
		"select": true, "start": true, "ls": true, "rs": true, "up": true, "down": true, "left": true, "right": true, "home": true}
	keyCode    = regexp.MustCompile(`^[A-Za-z0-9]{1,24}$`)
	placeColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

const (
	maxPlaces = 8
	placeName = 24
)

// describedControls mirrors describedGame's controls in game-files.ts
// (checkedControls in controls.ts): any game's controls.keys, an object of
// known inputs and their codes, at least one; and its controls.players, 1 to
// 8 objects whose keys, name and color are right where given (other fields
// aside). Each part is kept only where it is right; neither leaves the game
// without controls.
func describedControls(encoded string, present bool) *Controls {
	controls, ok := manifestOf(encoded, present)["controls"].(map[string]any)
	if !ok {
		return nil
	}
	keys, _ := checkedKeys(controls["keys"])
	players, _ := checkedPlayers(controls["players"])
	if keys == nil && players == nil {
		return nil
	}
	return &Controls{Keys: keys, Players: players}
}

// checkedKeys mirrors checkedKeys in controls.ts.
func checkedKeys(value any) (map[string]string, bool) {
	keys, ok := value.(map[string]any)
	if !ok || len(keys) == 0 {
		return nil, false
	}
	checked := map[string]string{}
	for input, value := range keys {
		code, ok := value.(string)
		if !controlInputs[input] || !ok || !keyCode.MatchString(code) {
			return nil, false
		}
		checked[input] = code
	}
	return checked, true
}

// checkedPlayers mirrors checkedControls' players in controls.ts.
func checkedPlayers(value any) ([]ControlPlayer, bool) {
	list, ok := value.([]any)
	if !ok || len(list) == 0 || len(list) > maxPlaces {
		return nil, false
	}
	players := make([]ControlPlayer, 0, len(list))
	for _, item := range list {
		fields, ok := item.(map[string]any)
		if !ok {
			return nil, false
		}
		player := ControlPlayer{}
		if raw, given := fields["keys"]; given {
			if player.Keys, ok = checkedKeys(raw); !ok {
				return nil, false
			}
		}
		if raw, given := fields["name"]; given {
			// As JavaScript counts a string: in UTF-16 code units.
			name, ok := raw.(string)
			if length := len(utf16.Encode([]rune(name))); !ok || length == 0 || length > placeName {
				return nil, false
			}
			player.Name = name
		}
		if raw, given := fields["color"]; given {
			color, ok := raw.(string)
			if !ok || !placeColor.MatchString(color) {
				return nil, false
			}
			player.Color = color
		}
		players = append(players, player)
	}
	return players, true
}
