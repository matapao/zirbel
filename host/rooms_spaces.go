package main

import (
	"errors"
	"net/http"
	"regexp"
	"time"
)

// A net game's room plays over a space of the spaces kernel (spaces.go),
// mirroring Rooms.withSpace, spaceTicket, proven and spaces in
// packages/core/rooms.ts: the room's code is its space's, its tickets seat the
// room's players, a proof says who of them a page is, and the room ends with
// its space.

// spacesSweep is how often the kernel's spaces are listed: their members for
// the lobby, and the rooms whose space ended.
const spacesSweep = 2 * time.Second

// UseSpaces gives the rooms the kernel, which a net game's room plays over
// while it runs, and lists its spaces until ctx's rooms are disposed.
func (rs *Rooms) UseSpaces(kernel *Spaces) {
	rs.kernel = kernel
	kernel.OnReset(func() { rs.sweepSpaces(nil, time.Time{}) })
	rs.done.Go(func() {
		ticker := time.NewTicker(spacesSweep)
		defer ticker.Stop()
		for {
			select {
			case <-rs.stop:
				return
			case <-ticker.C:
				if !kernel.Available() || !rs.anySpace() {
					continue
				}
				since := time.Now()
				if listed, err := kernel.List(); err == nil {
					rs.sweepSpaces(listed, since)
				}
			}
		}
	})
}

func (rs *Rooms) anySpace() bool {
	for _, room := range rs.list() {
		if room.spaceOf() != nil {
			return true
		}
	}
	return false
}

func (r *Room) spaceOf() *roomSpace {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.space
}

// sweepSpaces takes the kernel's list: a room's members as it counts them, and
// the end of every room whose space it no longer has; nil: the kernel went,
// with every space. since is when the list was asked for: a space opened while
// it was on its way, which it can't have, stays.
func (rs *Rooms) sweepSpaces(listed map[string]spaceMembers, since time.Time) {
	for _, room := range rs.list() {
		room.mu.Lock()
		space, opened := room.space, room.spaceOpened
		room.mu.Unlock()
		if space == nil || (listed != nil && !opened.Before(since)) {
			continue
		}
		members, ok := listed[space.ID]
		if !ok {
			rs.Close(room.ID)
			continue
		}
		room.mu.Lock()
		room.members = members
		room.mu.Unlock()
	}
}

// spaceCodeTries is how many codes a net game's room tries for its space,
// each refused as another space's, before it gives up.
const spaceCodeTries = 8

// spaceProof is a proof as the kernel makes one: one of its secrets.
var spaceProof = regexp.MustCompile(`^[A-Za-z0-9_-]{16,100}$`)

// WithSpace opens a space for a net game's shared room while the kernel runs,
// with a code where the room would have one: the room plays over it, and the
// code the host chose is its session's and its space's. A code the kernel
// refuses as another space's gives way to another. A room the kernel can't
// give a space is closed.
func (rs *Rooms) WithSpace(room *Room) (*Room, error) {
	kernel := rs.kernel
	if room.Solo || !isNet(room.Release.Manifest.Simulation) || room.spaceOf() != nil || kernel == nil || !kernel.Available() {
		return room, nil
	}
	coded := room.starter != "" || room.Access == "lan"
	for tries := 1; ; tries++ {
		code := ""
		if coded {
			rs.mu.Lock()
			code = rs.freeCode()
			rs.opening[code] = true
			rs.mu.Unlock()
		}
		opened, err := kernel.Open(room.Release.Manifest.Players.Max, code)
		rs.mu.Lock()
		delete(rs.opening, code)
		open := err == nil && rs.rooms[room.ID] == room
		if open {
			room.mu.Lock()
			room.space, room.Code, room.spaceOpened = &roomSpace{ID: opened.Space, Invite: opened.Invite}, code, time.Now()
			room.mu.Unlock()
		}
		rs.mu.Unlock()
		var refused *spacesError
		switch {
		case open:
			return room, nil
		case err == nil:
			kernel.Close(opened.Space)
			return nil, fail(http.StatusNotFound, "This room has closed.")
		case errors.As(err, &refused) && refused.Code == "taken" && tries < spaceCodeTries:
			continue
		}
		rs.Close(room.ID)
		if _, known := errors.AsType[*HTTPError](err); known {
			return nil, err
		}
		return nil, fail(http.StatusServiceUnavailable, "Multiplayer isn't available on this host now. Try again soon.")
	}
}

// Proven reports whether a proof a page made on its own connection to a
// room's space names a member of that space, as the kernel says; the proof is
// used up. A space's id, in every link, is no credential.
func (rs *Rooms) Proven(room *Room, proof string) (bool, error) {
	space := room.spaceOf()
	if space == nil || rs.kernel == nil || !spaceProof.MatchString(proof) {
		return false, nil
	}
	_, err := rs.kernel.Member(space.ID, proof)
	var refused *spacesError
	if errors.As(err, &refused) && refused.Code == "unavailable" {
		return false, fail(http.StatusServiceUnavailable, "Multiplayer isn't available on this host now.")
	}
	return err == nil, nil
}

// SpaceTicket is a one-time ticket into a room's space for someone: in role,
// or a player's place while one is free and else an observer's.
func (rs *Rooms) SpaceTicket(room *Room, name, role string) (string, error) {
	space := room.spaceOf()
	if space == nil || rs.kernel == nil {
		return "", fail(http.StatusServiceUnavailable, "Multiplayer isn't available on this host now.")
	}
	roles := []string{"participant", "observer"}
	if role != "" {
		roles = []string{role}
	}
	for _, asked := range roles {
		ticket, err := rs.kernel.Ticket(space.ID, name, asked)
		if err == nil {
			return ticket, nil
		}
		var refused *spacesError
		switch {
		case errors.As(err, &refused) && refused.Code == "unavailable":
			return "", fail(http.StatusServiceUnavailable, "Multiplayer isn't available on this host now.")
		case !errors.As(err, &refused) || refused.Code != "full":
			return "", fail(http.StatusGone, "This session has ended.")
		}
	}
	if role == "participant" {
		return "", fail(http.StatusConflict, "All player seats are reserved.")
	}
	return "", fail(http.StatusConflict, "This session is full.")
}
