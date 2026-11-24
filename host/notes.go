package main

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
)

// referencesFor mirrors referencesFor in packages/core/projects.ts.
func referencesFor(base *Revision, references []Reference) ([]Reference, error) {
	result := []Reference{}
	for _, reference := range references {
		if base.Scene == nil || reference.SceneID != base.Scene.ID || reference.Revision != base.ID {
			return nil, fail(http.StatusConflict, "A selected reference belongs to another revision.")
		}
		if reference.Type == "instance" {
			var found *SceneObject
			for i := range base.Scene.Objects {
				if base.Scene.Objects[i].ID == reference.Object.ID {
					found = &base.Scene.Objects[i]
				}
			}
			if found == nil {
				return nil, fail(http.StatusConflict, "A selected object no longer exists.")
			}
			copy := *found
			reference.Object = &copy
		} else {
			b := reference.Bounds
			reference.Objects = []SceneObject{}
			for _, item := range base.Scene.Objects {
				if item.X >= b.X && item.X <= b.X+b.Width && item.Y >= b.Y && item.Y <= b.Y+b.Height {
					reference.Objects = append(reference.Objects, item)
				}
			}
		}
		result = append(result, reference)
	}
	return result, nil
}
func (s *Projects) AddNote(projectID string, data []byte) (*Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var input Note
	if err := decodeContract("note-input", data, &input); err != nil {
		return nil, err
	}
	for _, reference := range input.References {
		if err := insideWorld(reference); err != nil {
			return nil, err
		}
	}
	text, err := trimmed("text", input.Text, 4000)
	if err != nil {
		return nil, err
	}
	input.Text = text
	if input.DesignPrompt != "" {
		if input.DesignPrompt, err = trimmed("designPrompt", input.DesignPrompt, 3000); err != nil {
			return nil, err
		}
	}
	p, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	if _, err := head(p, input.Branch); err != nil {
		return nil, err
	}
	references := []Reference{}
	for _, reference := range input.References {
		revision := p.revision(reference.Revision)
		if revision == nil {
			return nil, fail(http.StatusNotFound, "Note refers to a missing revision.")
		}
		resolved, err := referencesFor(revision, []Reference{reference})
		if err != nil {
			return nil, err
		}
		references = append(references, resolved[0])
	}
	for _, id := range input.Attachments {
		found := false
		for _, item := range p.Attachments {
			found = found || item.ID == id
		}
		if !found {
			return nil, fail(http.StatusNotFound, "Note refers to a missing attachment.")
		}
	}
	input.ID, input.Date, input.References = newID(), now(), references
	if input.Attachments == nil {
		input.Attachments = []string{}
	}
	p.Notes = append(p.Notes, input)
	if _, err := s.save(p); err != nil {
		return nil, err
	}
	return &input, nil
}

// mediaMatches mirrors mediaMatches in packages/core/projects.ts.
func mediaMatchesAny(media string, data []byte) bool {
	switch media {
	case "video/mp4":
		return len(data) >= 8 && string(data[4:8]) == "ftyp"
	case "video/webm":
		return bytes.HasPrefix(data, []byte{26, 69, 223, 163})
	case "text/plain":
		return !bytes.Contains(data, []byte{0}) && !bytes.ContainsRune(bytes.ToValidUTF8(data, []byte("�")), '�')
	}
	return mediaMatches(media, data)
}
func (s *Projects) AddMedia(projectID string, data []byte) (*Attachment, error) {
	var input struct {
		Attachment
		Data string `json:"data"`
	}
	if err := decodeContract("media-upload", data, &input); err != nil {
		return nil, err
	}
	file, err := base64.StdEncoding.DecodeString(input.Data)
	if err != nil || !mediaMatchesAny(input.Media, file) {
		return nil, fail(http.StatusBadRequest, "The attachment does not match its media type.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	item := input.Attachment
	item.ID = newID()
	if item.Original != "" {
		found := false
		for _, media := range p.Attachments {
			found = found || media.ID == item.Original
		}
		if !found {
			return nil, fail(http.StatusNotFound, "The original attachment is missing.")
		}
	}
	if err := atomicWrite(filepath.Join(s.root, "media", item.ID), file); err != nil {
		return nil, err
	}
	p.Attachments = append(p.Attachments, item)
	if _, err := s.save(p); err != nil {
		return nil, err
	}
	return &item, nil
}
func (s *Projects) EditTranscript(projectID, attachmentID string, data []byte) (*Attachment, error) {
	var input struct {
		Transcript string `json:"transcript"`
		Intent     string `json:"intent"`
	}
	if err := decodeContract("transcript", data, &input); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.read(projectID)
	if err != nil {
		return nil, err
	}
	for i := range p.Attachments {
		if p.Attachments[i].ID == attachmentID {
			p.Attachments[i].Transcript, p.Attachments[i].Intent = input.Transcript, input.Intent
			next := p.Attachments[i]
			if _, err := s.save(p); err != nil {
				return nil, err
			}
			return &next, nil
		}
	}
	return nil, fail(http.StatusNotFound, "Attachment does not exist.")
}
func (s *Projects) ReadMedia(projectID, attachmentID string) (*Attachment, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.read(projectID)
	if err != nil {
		return nil, nil, err
	}
	for _, item := range p.Attachments {
		if item.ID == attachmentID {
			data, err := os.ReadFile(filepath.Join(s.root, "media", item.ID))
			return &item, data, err
		}
	}
	return nil, nil, fail(http.StatusNotFound, "Attachment does not exist.")
}
