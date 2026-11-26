package main

import (
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type Room struct {
	ID            string
	Invite        string
	DocumentKey   string
	InviteExpires time.Time
	Release       *Release
	Solo          bool
	Access        string // "local" or "lan"
	Development   bool   // a LAN room pinned to an editor revision
	Code          string // a session's code (sessions.go); empty for other rooms
	Session       string // the lobby's name for it: for its list alone, never enough to join
	Started       time.Time
	starter       string // the address that started it from the lobby; empty for the owner's rooms

	mu        sync.Mutex
	sim       simulation
	order     []string
	seats     map[string]*seat
	pending   map[string]ticket
	tick      int64
	activity  time.Time
	closed    bool
	gamePages sync.Map // origin -> *gamePageEntry
	// space is a net game's space in the spaces kernel, which its players are
	// members of and its own netcode plays over (none alone, or without the
	// kernel), and members its participants and whether any is connected, as
	// the kernel last listed them (rooms_spaces.go).
	space   *roomSpace
	members spaceMembers
}

// roomSpace is a room's space: its id, and the invitation in its link.
type roomSpace struct{ ID, Invite string }

func newRoom(release *Release, solo bool, access string, development bool) *Room {
	now := time.Now()
	return &Room{
		ID: hex.EncodeToString(randomBytes(6)), Session: hex.EncodeToString(randomBytes(6)), Invite: secret(), DocumentKey: secret(),
		InviteExpires: now.Add(inviteLifetime), Release: release, Solo: solo, Access: access, Development: development, Started: now,
		sim: newSimulation(release, solo), seats: map[string]*seat{}, pending: map[string]ticket{}, activity: now,
	}
}
func encode(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}
func errorMessage(code, message string) []byte {
	return encode(struct {
		Type    string `json:"type"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}{"error", code, message})
}

type summary struct {
	ID          string          `json:"id"`
	Manifest    json.RawMessage `json:"manifest"`
	Solo        bool            `json:"solo"`
	Development bool            `json:"development"`
	Access      string          `json:"access"`
	Seats       []SeatInfo      `json:"seats"`
	Status      string          `json:"status"`
	Code        string          `json:"code,omitempty"`
}

// seated returns the seats in join order. order and seats change together,
// but a missing entry is skipped rather than trusted.
func (r *Room) seated() []*seat {
	list := make([]*seat, 0, len(r.order))
	for _, id := range r.order {
		if s := r.seats[id]; s != nil {
			list = append(list, s)
		}
	}
	return list
}
func (r *Room) seatList() []SeatInfo {
	seats := make([]SeatInfo, 0, len(r.order))
	for _, s := range r.seated() {
		seats = append(seats, s.info)
	}
	return seats
}
func (r *Room) Summary() summary {
	r.mu.Lock()
	defer r.mu.Unlock()
	seats := r.seatList()
	status := "waiting"
	if r.closed {
		status = "closed"
	} else if r.connectedLocked() || r.members.connected {
		status = "active"
	}
	return summary{r.ID, r.Release.ManifestRaw, r.Solo, r.Development, r.Access, seats, status, r.Code}
}

// MayView: an invitation, a held seat or a seat's own, or for a room with a
// space that space's id, which is in every link.
func (r *Room) MayView(credential string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.prune()
	if r.closed {
		return false
	}
	if same(credential, r.Invite) && time.Now().Before(r.InviteExpires) {
		return true
	}
	if r.space != nil && same(credential, r.space.ID) {
		return true
	}
	if _, ok := r.pending[credential]; ok {
		return true
	}
	for _, s := range r.seats {
		if same(s.resume, credential) {
			return true
		}
	}
	return false
}
func (r *Room) capacity(role string) int {
	if role == "spectator" {
		return 4
	}
	if r.Solo {
		return 1
	}
	return r.Release.Manifest.Players.Max
}
func (r *Room) used(role string) int {
	count := 0
	for _, s := range r.seats {
		if s.info.Role == role {
			count++
		}
	}
	return count
}
func (r *Room) Reserve(invite, name, role string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return "", fail(http.StatusNotFound, "This room has closed.")
	}
	if !same(invite, r.Invite) || !time.Now().Before(r.InviteExpires) {
		return "", fail(http.StatusForbidden, "This invitation is invalid or expired.")
	}
	if r.Solo && role != "player" {
		return "", fail(http.StatusForbidden, "This is a local playtest.")
	}
	r.prune()
	return r.hold(name, role, ticketLifetime)
}

// Seat holds a seat for someone the lobby lets in, without the invitation
// (which may have expired): role, or when it is empty a player's while one is
// free and else a spectator's. Its ticket is a one-time credential.
func (r *Room) Seat(name, role string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return "", fail(http.StatusNotFound, "This room has closed.")
	}
	r.prune()
	if role == "" {
		role = "spectator"
		if r.Solo || r.free("player") {
			role = "player"
		}
	}
	return r.hold(name, role, seatTicketLifetime)
}

// free reports a seat of role that is neither taken nor reserved.
func (r *Room) free(role string) bool {
	held := 0
	for _, item := range r.pending {
		if item.role == role {
			held++
		}
	}
	return r.used(role)+held < r.capacity(role)
}

// hold reserves a free seat of role for name: the ticket that takes it.
func (r *Room) hold(name, role string, lifetime time.Duration) (string, error) {
	if !r.free(role) {
		if role == "player" {
			return "", fail(http.StatusConflict, "All player seats are reserved.")
		}
		return "", fail(http.StatusConflict, "The spectator seats are full.")
	}
	key := secret()
	r.pending[key] = ticket{name, role, time.Now().Add(lifetime)}
	r.activity = time.Now()
	return key, nil
}

// players counts the player seats taken.
func (r *Room) players() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.space != nil {
		return r.members.participants
	}
	return r.used("player")
}

type hello struct {
	Credential string `json:"credential"`
	ReleaseID  string `json:"releaseId"`
}

// Connect admits a peer with a ticket or a resume credential and returns its seat ID.
func (r *Room) Connect(input hello, peer Peer) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || input.ReleaseID != r.Release.Manifest.ReleaseID {
		peer.Send(errorMessage("protocol", "This connection uses a different release."))
		return ""
	}
	r.prune()
	var current *seat
	for _, s := range r.seats {
		if same(s.resume, input.Credential) {
			current = s
		}
	}
	if pass, ok := r.pending[input.Credential]; current == nil && ok && r.used(pass.role) < r.capacity(pass.role) {
		delete(r.pending, input.Credential)
		id := newID()
		current = &seat{info: SeatInfo{id, pass.name, pass.role, true}, resume: secret()}
		r.seats[id] = current
		r.order = append(r.order, id)
		if pass.role == "player" && r.sim != nil {
			r.sim.add(id)
		}
	}
	if current == nil {
		peer.Send(errorMessage("expired", "This seat has expired. Join again from your invitation."))
		return ""
	}
	previous := current.peer
	current.peer = peer
	if previous != nil {
		previous.Close(4001)
	}
	current.info.Connected = true
	current.expires = time.Time{}
	r.activity = time.Now()
	peer.Send(encode(struct {
		Type      string   `json:"type"`
		Version   int      `json:"version"`
		ReleaseID string   `json:"releaseId"`
		Seat      SeatInfo `json:"seat"`
		Resume    string   `json:"resume"`
		Ack       int64    `json:"ack"`
	}{"welcome", protocolVersion, r.Release.Manifest.ReleaseID, current.info, current.resume, current.ack}))
	r.broadcast()
	return current.info.ID
}

// clientMessage holds every variant of contracts/client-message.schema.json,
// so one decode serves the handshake and later messages.
type clientMessage struct {
	Type       string          `json:"type"`
	Credential string          `json:"credential"`
	ReleaseID  string          `json:"releaseId"`
	Sequence   float64         `json:"sequence"` // the schema allows 2, 2.0 or 2e0
	Action     json.RawMessage `json:"action"`
}

func (r *Room) Message(id string, peer Peer, input clientMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.seats[id]
	if s == nil || s.peer != peer || r.closed {
		return
	}
	switch input.Type {
	case "resync":
		r.snapshot(s)
		return
	case "leave":
		r.remove(s)
		peer.Close(1000)
		r.broadcast()
		return
	case "action":
	default:
		peer.Send(errorMessage("protocol", "The connection is already established."))
		return
	}
	if s.info.Role != "player" || r.sim == nil {
		peer.Send(errorMessage("forbidden", "This seat cannot send game actions."))
		return
	}
	sequence := int64(input.Sequence)
	if sequence <= s.ack {
		peer.Send(errorMessage("stale-action", "This action was already received."))
		return
	}
	s.ack = sequence
	r.activity = time.Now()
	if rejection := r.sim.apply(id, input.Action); rejection != "" {
		peer.Send(errorMessage("invalid-action", rejection))
		r.snapshot(s)
		return
	}
	if _, ok := r.sim.(*tessellate); ok {
		r.broadcast()
	}
}
func (r *Room) Disconnected(id string, peer Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.seats[id]
	if s == nil || s.peer != peer {
		return
	}
	s.peer = nil
	s.info.Connected = false
	s.expires = time.Now().Add(seatGrace)
	if r.sim != nil {
		r.sim.suspend(id)
	}
	r.broadcast()
}

// snapshotBody encodes the part of a snapshot every seat shares. Only ack
// differs per seat, so a broadcast encodes seats and state once.
func (r *Room) snapshotBody() []byte {
	var state any
	if r.sim != nil {
		state = r.sim.snapshot()
	}
	return encode(struct {
		Seats []SeatInfo `json:"seats"`
		State any        `json:"state"`
	}{r.seatList(), state})
}
func (r *Room) sendSnapshot(s *seat, body []byte) {
	if s.peer == nil {
		return
	}
	message := make([]byte, 0, int64(len(body))+48) // in 64 bits, where the sum can't wrap
	message = append(message, `{"type":"snapshot","tick":`...)
	message = strconv.AppendInt(message, r.tick, 10)
	message = append(message, `,"ack":`...)
	message = strconv.AppendInt(message, s.ack, 10)
	message = append(message, ',')
	message = append(message, body[1:]...) // body is {"seats":...,"state":...}
	s.peer.Send(message)
}
func (r *Room) snapshot(s *seat) { r.sendSnapshot(s, r.snapshotBody()) }
func (r *Room) broadcast() {
	r.tick++
	body := r.snapshotBody()
	for _, s := range r.seated() {
		r.sendSnapshot(s, body)
	}
}
func (r *Room) remove(s *seat) {
	delete(r.seats, s.info.ID)
	for i, id := range r.order {
		if id == s.info.ID {
			r.order = append(r.order[:i], r.order[i+1:]...)
			break
		}
	}
	if s.info.Role == "player" && r.sim != nil {
		r.sim.remove(s.info.ID)
	}
}
func (r *Room) prune() {
	now := time.Now()
	for key, item := range r.pending {
		if item.expires.Before(now) {
			delete(r.pending, key)
		}
	}
	removed := false
	for _, s := range r.seated() {
		if !s.expires.IsZero() && s.expires.Before(now) {
			r.remove(s)
			removed = true
		}
	}
	if removed {
		r.broadcast()
	}
}
func (r *Room) connectedLocked() bool {
	for _, s := range r.seats {
		if s.info.Connected {
			return true
		}
	}
	return false
}

// step runs one 50 ms tick and reports whether the room stays open.
func (r *Room) step() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.prune()
	// A room with a space lives as long as its space: the kernel ends one
	// nobody plays in (the rooms' sweep).
	if r.space != nil {
		return !r.closed
	}
	now := time.Now()
	// A shared room stays open as long as its invitation is valid; a lobby
	// session, whose invitation nobody holds, only while it is played.
	if !r.connectedLocked() && now.Sub(r.activity) > idleLimit && (r.Solo || r.starter != "" || !now.Before(r.InviteExpires)) {
		return false
	}
	if r.sim != nil && r.sim.tick(tickInterval.Seconds()) {
		r.broadcast()
	}
	return !r.closed
}
func (r *Room) close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	closed := encode(struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}{"closed", "The owner ended this room."})
	for _, s := range r.seats {
		if s.peer != nil {
			s.peer.Send(closed)
			s.peer.Close(1000)
		}
	}
	r.seats, r.order, r.pending = map[string]*seat{}, nil, map[string]ticket{}
}
func (r *Room) Connected() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.connectedLocked()
}
