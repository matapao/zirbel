package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"unicode/utf16"
)

// applyOperations mirrors applyOperations in packages/core/operations.ts.
func applyOperations(base *Revision, operations []Operation) (*Content, error) {
	game := base.Game
	var background string
	objects := []SceneObject{}
	if base.Scene != nil {
		background = base.Scene.Background
		objects = append(objects, base.Scene.Objects...)
	}
	find := func(id string) int {
		return slices.IndexFunc(objects, func(object SceneObject) bool { return object.ID == id })
	}
	assets := append([]Asset{}, base.Assets...)
	findAsset := func(id string) int {
		return slices.IndexFunc(assets, func(asset Asset) bool { return asset.ID == id })
	}
	for _, operation := range operations {
		switch operation.Op {
		case "writeGame":
			// Only a game with its files replaces a folder game: one document alone would drop them.
			if game != nil && game.Files != nil && operation.Game.Files == nil {
				return nil, fail(http.StatusUnprocessableEntity, "This game is a folder of files, which this change would drop. Change it in a harness turn, or import a new build.")
			}
			game = operation.Game
		case "background":
			background = operation.Color
		case "add":
			if find(operation.Object.ID) >= 0 {
				return nil, fail(http.StatusConflict, "An object already uses that ID.")
			}
			objects = append(objects, *operation.Object)
		case "update":
			index := find(operation.ID)
			if index < 0 {
				return nil, fail(http.StatusConflict, "The target object is missing.")
			}
			merged, err := mergeChanges(objects[index], operation.Changes)
			if err != nil {
				return nil, err
			}
			objects[index] = merged
		case "remove":
			index := find(operation.ID)
			if index < 0 {
				return nil, fail(http.StatusConflict, "The target object is missing.")
			}
			objects = slices.Delete(objects, index, index+1)
		case "addAsset":
			if findAsset(operation.Asset.ID) >= 0 {
				return nil, fail(http.StatusConflict, "An asset already uses that ID.")
			}
			assets = append(assets, *operation.Asset)
		case "removeAsset":
			index := findAsset(operation.ID)
			if index < 0 {
				return nil, fail(http.StatusConflict, "The target asset is missing.")
			}
			assets = slices.Delete(assets, index, index+1)
		}
	}
	if len(assets) > 80 {
		return nil, fail(http.StatusBadRequest, "A project can reference up to 80 assets.")
	}
	preview := &Content{Game: game, Assets: assets}
	if base.Scene != nil {
		scene := &Scene{ID: base.Scene.ID, Background: background, Objects: objects}
		// scene.parse(...) in Node: the result must still be a valid scene.
		data, _ := jsJSON(scene)
		if err := checkContract("scene", data); err != nil {
			return nil, err
		}
		if err := normalizeScene(scene); err != nil {
			return nil, err
		}
		preview.Scene = scene
	}
	return preview, nil
}

// trimmedName applies Zod's trim and length check to the name in an update's changes.
func trimmedName(raw json.RawMessage) (json.RawMessage, error) {
	var name string
	_ = json.Unmarshal(raw, &name)
	name, err := trimmed("changes.name", name, 80)
	if err != nil {
		return nil, err
	}
	return jsJSON(name)
}

// mergeChanges is { ...object, ...changes }.
func mergeChanges(object SceneObject, changes map[string]json.RawMessage) (SceneObject, error) {
	data, err := json.Marshal(object)
	if err != nil {
		return object, err
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &fields); err != nil {
		return object, err
	}
	for key, value := range changes {
		if key == "name" {
			if value, err = trimmedName(value); err != nil {
				return object, err
			}
		}
		fields[key] = value
	}
	data, _ = json.Marshal(fields)
	var merged SceneObject
	if err := json.Unmarshal(data, &merged); err != nil {
		return object, fail(http.StatusBadRequest, "changes · Invalid input")
	}
	return merged, nil
}
func parseProposal(data []byte) (*Proposal, error) {
	var request Proposal
	if err := decodeContract("proposal", data, &request); err != nil {
		return nil, err
	}
	label, err := trimmed("label", request.Label, 120)
	if err != nil {
		return nil, err
	}
	request.Label = label
	for i, operation := range request.Operations {
		if operation.Op == "update" && len(operation.Changes) == 0 {
			return nil, fail(http.StatusBadRequest, "operations."+strconv.Itoa(i)+".changes · Provide at least one property.")
		}
		if operation.Asset != nil {
			normalizeSource(operation.Asset)
		}
		if operation.Object != nil {
			name, err := trimmed("object.name", operation.Object.Name, 80)
			if err != nil {
				return nil, err
			}
			operation.Object.Name = name
		}
		if err := normalizeGame(operation.Game); err != nil {
			return nil, err
		}
		// Zod trims a renamed object's name in the stored proposal too.
		if raw, ok := operation.Changes["name"]; ok {
			name, err := trimmedName(raw)
			if err != nil {
				return nil, err
			}
			operation.Changes["name"] = name
		}
	}
	return &request, nil
}

// truncateUTF16 is JavaScript's slice(0, n), cutting before a character that
// would cross the limit.
func truncateUTF16(text string, n int) string {
	length := 0
	for i, r := range text {
		if length += utf16.RuneLen(r); length > n {
			return text[:i]
		}
	}
	return text
}
