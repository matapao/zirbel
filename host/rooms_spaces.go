package main

import (
	"errors"
	"net/http"
	"time"
)

// A net game's room plays over a space of the spaces kernel (spaces.go),
// mirroring Rooms.withSpace, spaceTicket and spaces in packages/core/rooms.ts:
// the space's code is the room's, its tickets seat the room's players, and the
// room ends with its space.

// spacesSweep is how often the kernel's spaces are listed: their members for
// the lobby, and the rooms whose space ended.
const spacesSweep = 2 * time.Second

// UseSpaces gives the rooms the kernel, which a net game's room plays over
// while it runs, and lists its spaces until ctx's rooms are disposed.
func (rs *Rooms) UseSpaces(kernel *Spaces) {
	rs.kernel = kernel
	kernel.OnReset(func() { rs.sweepSpaces(nil) })
	rs.done.Add(1)
	go func() {
		defer rs.done.Done()
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
				if listed, err := kernel.List(); err == nil {
					rs.sweepSpaces(listed)
				}
			}
		}
	}()
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
// with every space.
func (rs *Rooms) sweepSpaces(listed map[string]spaceMembers) {
	for _, room := range rs.list() {
		space := room.spaceOf()
		if space == nil {
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

// WithSpace opens a space for a net game's shared room while the kernel runs,
// with a code where the room would have one: the room plays over it, and its
// code is the session's. A room the kernel can't give one is closed. A space
// whose code another room has (the kernel draws its own) is given back.
func (rs *Rooms) WithSpace(room *Room) (*Room, error) {
	kernel := rs.kernel
	if room.Solo || !isNet(room.Release.Manifest.Simulation) || room.spaceOf() != nil || kernel == nil || !kernel.Available() {
		return room, nil
	}
	code := room.starter != "" || room.Access == "lan"
	for tries := 0; ; tries++ {
		opened, err := kernel.Open(room.Release.Manifest.Players.Max, code)
		if err != nil {
			rs.Close(room.ID)
			var known *HTTPError
			if errors.As(err, &known) {
				return nil, err
			}
			return nil, fail(http.StatusServiceUnavailable, "Multiplayer isn't available on this host now. Try again soon.")
		}
		rs.mu.Lock()
		taken := false
		for _, other := range rs.rooms {
			taken = taken || (opened.Code != "" && other.Code == opened.Code)
		}
		open := rs.rooms[room.ID] == room
		if open && (!taken || tries >= 3) {
			room.mu.Lock()
			room.space, room.Code = &roomSpace{ID: opened.Space, Invite: opened.Invite}, opened.Code
			room.mu.Unlock()
		}
		rs.mu.Unlock()
		switch {
		case !open:
			kernel.Close(opened.Space)
			return nil, fail(http.StatusNotFound, "This room has closed.")
		case taken && tries < 3:
			kernel.Close(opened.Space)
		default:
			return room, nil
		}
	}
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
