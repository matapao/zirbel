package main

import (
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Lobby sessions, mirroring the Node host: a multiplayer session's short
// code, which a guest types to join it, and the limits on what guests start.
// The lobby itself, its offered games and its routes, is lobby.go.

// sessionAlphabet leaves out 0, O, 1 and I, which read as one another.
const sessionAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

const (
	sessionCodeLength = 4
	lobbySessions     = 16   // open lobby sessions on the host
	sessionsPerGuest  = 3    // open lobby sessions one address started
	wrongSessionCodes = 10   // wrong codes an address may try in a minute
	countedAddresses  = 4096 // addresses whose wrong codes are counted at once
	// seatTicketLifetime is how long a seat the lobby gives keeps: the starter
	// sees the code first and goes in when the others have it.
	seatTicketLifetime = 5 * time.Minute
)

var (
	sessionCodePattern = regexp.MustCompile(`^[2-9A-HJ-NP-Z]{4}$`)
	sessionCodeSpacing = regexp.MustCompile(`[\t\n\f\r -]`)
	lowerLetter        = regexp.MustCompile(`[a-z]`)
)

// multiplayer: a release with a simulation (shared state, net-v2, the
// built-in games) is played together; one without it, alone.
func multiplayer(release *Release) bool { return release.Manifest.Simulation != nil }

// sessionCode reads a code as a person types it, as readCode in
// packages/core/lobby.ts does: any case, with spaces, line breaks or dashes
// anywhere. Only a to z are upper-cased, so no other letter turns into one of
// the code's. Empty when it cannot be a code.
func sessionCode(input string) string {
	plain := lowerLetter.ReplaceAllStringFunc(sessionCodeSpacing.ReplaceAllString(input, ""), strings.ToUpper)
	if !sessionCodePattern.MatchString(plain) {
		return ""
	}
	return plain
}

func randomSessionCode() string {
	// 32 letters divide 256, so each byte's low five bits pick one evenly.
	code := randomBytes(sessionCodeLength)
	for i, b := range code {
		code[i] = sessionAlphabet[b&31]
	}
	return string(code)
}

// freeCode is a code no open room has. The caller holds rs.mu.
func (rs *Rooms) freeCode() string {
	for {
		code, taken := randomSessionCode(), false
		for _, room := range rs.rooms {
			taken = taken || room.Code == code
		}
		if !taken {
			return code
		}
	}
}

// sessionLimits refuses a lobby session over the host's or the address's
// limit; the host's own loopback is its owner's, held to the host's alone.
// The caller holds rs.mu.
func (rs *Rooms) sessionLimits(starter string) error {
	open, theirs := 0, 0
	for _, room := range rs.rooms {
		if room.starter != "" {
			open++
		}
		if room.starter == starter {
			theirs++
		}
	}
	if open >= lobbySessions {
		return fail(http.StatusTooManyRequests, "The lobby is full. Join a session, or try again when one ends.")
	}
	if theirs >= sessionsPerGuest && !isLoopbackAddress(starter) {
		return fail(http.StatusTooManyRequests, "You have three sessions open. Join one, or wait until one ends.")
	}
	return nil
}

// SessionLimits checks the limits before a release is read for a session;
// OpenSession checks them again as it opens one.
func (rs *Rooms) SessionLimits(starter string) error {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.sessionLimits(starter)
}

// codeTries counts the wrong session codes per address in a minute.
type codeTries struct {
	now   func() time.Time
	tries map[string]wrongTries
}

// blocked: the address tried too many wrong codes this minute.
func (c *codeTries) blocked(address string) bool {
	tries, tried := c.tries[address]
	return tried && c.now().Sub(tries.since) < time.Minute && tries.count >= wrongSessionCodes
}

// wrong counts a wrong code from address; the minute starts at its first.
// At most countedAddresses are counted at once; the oldest make way.
func (c *codeTries) wrong(address string) {
	at := c.now()
	for other, tries := range c.tries {
		if at.Sub(tries.since) >= time.Minute {
			delete(c.tries, other)
		}
	}
	tries := c.tries[address]
	if tries.count == 0 {
		tries.since = at
	}
	tries.count++
	c.tries[address] = tries
	if len(c.tries) > countedAddresses {
		oldest := ""
		for other, counted := range c.tries {
			if other != address && (oldest == "" || counted.since.Before(c.tries[oldest].since)) {
				oldest = other
			}
		}
		delete(c.tries, oldest)
	}
}
