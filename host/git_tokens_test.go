package main

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

var holderID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// A git token a client sends, as holder reads it: it takes only the one
// spelling of a token this box makes for a holder, and a token it makes for a
// holder reads back as that holder.
func FuzzGitTokenHolder(f *testing.F) {
	folder := filepath.Join(f.TempDir(), "box")
	if err := os.MkdirAll(folder, 0o700); err != nil {
		f.Fatal(err)
	}
	secret := "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n"
	if err := os.WriteFile(filepath.Join(folder, "git-secret"), []byte(secret), 0o600); err != nil {
		f.Fatal(err)
	}
	tokens, err := newGitTokens(folder)
	if err != nil {
		f.Fatal(err)
	}
	device, _ := tokens.token(tokenHolder{"o", "00000000-0000-4000-8000-000000000001"})
	editor, _ := tokens.token(tokenHolder{"e", "0123abcd-0000-4000-8000-00000000ffff"})
	for _, token := range []string{device, editor, "e" + device[1:], device[:len(device)-1] + "B", device + "\n", device[:len(device)-1], "o.00000000-0000-4000-8000-000000000001.", ""} {
		f.Add(token, false, "00000000-0000-4000-8000-000000000001")
	}
	f.Add("", true, "0123ABCD-0000-4000-8000-00000000FFFF")
	f.Fuzz(func(t *testing.T, token string, isEditor bool, id string) {
		if holder, ok := tokens.holder(token); ok {
			made, err := tokens.token(holder)
			if err != nil || made != token || (holder.kind != "o" && holder.kind != "e") || !holderID.MatchString(holder.id) {
				t.Fatalf("%q was taken for %+v, whose token is %q", token, holder, made)
			}
		}
		holder := tokenHolder{"o", id}
		if isEditor {
			holder.kind = "e"
		}
		made, err := tokens.token(holder)
		if err != nil {
			t.Fatal(err)
		}
		if found, ok := tokens.holder(made); ok != holderID.MatchString(id) || (ok && found != holder) {
			t.Fatalf("the token made for %+v, %q, reads as %+v (%v)", holder, made, found, ok)
		}
	})
}
