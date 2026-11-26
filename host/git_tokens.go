package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// A box's git tokens, mirroring packages/server/git-tokens.ts: what a git
// client sends as its password for a paired device or an editor of one game.
// A token is derived from a secret the account folder keeps (box/git-secret),
// so the editor can show a device its token at any time, and both hosts agree
// on it: <kind>.<holder id>.<mac>, kind o for a paired device and e for an
// editor, mac the unpadded base64url of HMAC-SHA256(secret,
// "zirbel-git-token\n" + kind + "\n" + holder id). A token works while its
// device stays paired or its editor's session lasts.

var (
	tokenShape  = regexp.MustCompile(`^([oe])\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$`)
	secretShape = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// tokenHolder is whose a token is: a paired device (o) or an editor (e).
type tokenHolder struct{ kind, id string }

type gitTokens struct {
	mu   sync.Mutex // the secret is made once, on first use
	file string
}

func newGitTokens(folder string) (*gitTokens, error) {
	if err := privateDirectory(folder); err != nil {
		return nil, err
	}
	return &gitTokens{file: filepath.Join(folder, "git-secret")}, nil
}

func (t *gitTokens) secret() ([]byte, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	kept, err := os.ReadFile(t.file) // #nosec G304 -- the account folder's own file
	if text := strings.TrimSpace(string(kept)); err == nil && secretShape.MatchString(text) {
		return hex.DecodeString(text)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	made := randomBytes(32)
	return made, atomicWrite(t.file, []byte(hex.EncodeToString(made)+"\n"))
}

func (t *gitTokens) mac(holder tokenHolder) (string, error) {
	secret, err := t.secret()
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("zirbel-git-token\n" + holder.kind + "\n" + holder.id))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// token is a paired device's or an editor's token.
func (t *gitTokens) token(holder tokenHolder) (string, error) {
	mac, err := t.mac(holder)
	return holder.kind + "." + holder.id + "." + mac, err
}

// holder is whose a token is, if it is one this box made.
func (t *gitTokens) holder(token string) (tokenHolder, bool) {
	match := tokenShape.FindStringSubmatch(token)
	if match == nil {
		return tokenHolder{}, false
	}
	holder := tokenHolder{match[1], match[2]}
	expected, err := t.mac(holder)
	return holder, err == nil && subtle.ConstantTimeCompare([]byte(match[3]), []byte(expected)) == 1
}
