package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The MCP contract test holds write_files to the Node host's on both; this
// holds it to the 36 MB a game may hold in all, which is too much to send to
// both hosts on every run.
func TestStageFilesHoldsAGameTo36MB(t *testing.T) {
	store, err := NewProjects(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	hash, err := store.storeAsset(make([]byte, gameBytes-20))
	if err != nil {
		t.Fatal(err)
	}
	p, err := store.CreateGame("Big", &Game{HTML: "<p>big</p>", MaxPlayers: 1, Files: map[string]string{"big.bin": hash}}, ownerIdent)
	if err != nil {
		t.Fatal(err)
	}
	stage := func(size int) error {
		text := strings.Repeat("x", size)
		_, err := store.StageFiles(p.ID, &writeFilesArgs{BaseRevision: p.Branches["main"], Label: "More",
			Files: []fileChange{{Path: "more.txt", Text: &text}}}, ownerIdent)
		return err
	}
	if err := stage(20); err == nil || err.Error() != "The game would be larger than a game can be (36 MB)." {
		t.Fatalf("a game over 36 MB was staged: %v", err)
	}
	if err := stage(5); err != nil {
		t.Fatalf("a game within 36 MB was refused: %v", err)
	}
	if err := os.Remove(filepath.Join(store.root, "assets", hash)); err != nil {
		t.Fatal(err)
	}
	if err := stage(1); err == nil || err.Error() != "An asset file is missing." {
		t.Fatalf("a game whose file is gone was staged: %v", err)
	}
}

func TestChangeBytesNeedsTextOrBase64(t *testing.T) {
	if _, err := changeBytes(fileChange{Path: "a.txt"}); err == nil {
		t.Fatal("a change with neither text nor base64 wrote a file")
	}
	broken := "eA="
	if _, err := changeBytes(fileChange{Path: "a.txt", Base64: &broken}); err == nil {
		t.Fatal("a change with broken base64 wrote a file")
	}
}
