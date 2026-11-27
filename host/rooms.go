package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Constants and behaviour mirror packages/core/rooms.ts.
const (
	protocolVersion = 1
	seatGrace       = 90 * time.Second
	inviteLifetime  = 4 * time.Hour
	idleLimit       = 20 * time.Minute
	ticketLifetime  = 30 * time.Second
	tickInterval    = 50 * time.Millisecond
	maxRooms        = 24
)

func randomBytes(n int) []byte {
	data := make([]byte, n)
	if _, err := rand.Read(data); err != nil {
		panic(err)
	}
	return data
}
func secret() string { return base64.RawURLEncoding.EncodeToString(randomBytes(24)) }
func newID() string {
	b := randomBytes(16)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
func same(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// Peer is one WebSocket connection. Send must not block.
type Peer interface {
	Send(message []byte)
	Close(code int)
}
type SeatInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Role      string `json:"role"`
	Connected bool   `json:"connected"`
}
type seat struct {
	info    SeatInfo
	resume  string
	peer    Peer
	ack     int64
	expires time.Time // zero while connected
}
type ticket struct {
	name, role string
	expires    time.Time
}

// Rooms owns every open room and their shared 50 ms tick.
type Rooms struct {
	mu    sync.Mutex
	rooms map[string]*Room
	order []string
	stop  chan struct{}
	done  sync.WaitGroup
	// kernel is the spaces kernel a net game's room plays over (rooms_spaces.go).
	kernel *Spaces
	// opening are the codes chosen for spaces the kernel is opening: no
	// other room gets one meanwhile.
	opening map[string]bool
}

func NewRooms() *Rooms {
	rooms := &Rooms{rooms: map[string]*Room{}, opening: map[string]bool{}, stop: make(chan struct{})}
	rooms.done.Add(1)
	go func() {
		defer rooms.done.Done()
		ticker := time.NewTicker(tickInterval)
		defer ticker.Stop()
		for {
			select {
			case <-rooms.stop:
				return
			case <-ticker.C:
				for _, room := range rooms.list() {
					if !room.step() {
						rooms.Close(room.ID)
					}
				}
			}
		}
	}()
	return rooms
}
func (rs *Rooms) list() []*Room {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	list := make([]*Room, 0, len(rs.order))
	for _, id := range rs.order {
		if room := rs.rooms[id]; room != nil {
			list = append(list, room)
		}
	}
	return list
}

// Create opens a shared room. The host keeps only what players need: the
// release's embedded runtime copy is dropped, since the host serves its own.
func (rs *Rooms) Create(release *Release, access string) (*Room, error) {
	return rs.Open(release, false, access, false)
}

// opening is how a room is opened: by the owner, or from the lobby by the
// guest at starter.
type opening struct {
	solo, development bool
	access            string
	starter           string // the address that started a lobby session; empty for the owner's rooms
}

// Open mirrors Rooms.create in packages/core/rooms.ts, including solo
// playtests and development rooms.
// A net game's shared room gets its space as it opens (WithSpace).
func (rs *Rooms) Open(release *Release, solo bool, access string, development bool) (*Room, error) {
	if solo && access == "lan" {
		return nil, fail(http.StatusBadRequest, "Solo playtests use the local player service.")
	}
	room, err := rs.open(release, opening{solo: solo, development: development, access: access})
	if err != nil {
		return nil, err
	}
	return rs.WithSpace(room)
}

// OpenSession starts a lobby session of an offered release for the guest at
// starter: a shared room with a code, or a solo room for one played alone.
func (rs *Rooms) OpenSession(release *Release, solo bool, access, starter string) (*Room, error) {
	return rs.open(release, opening{solo: solo, access: access, starter: starter})
}

func (rs *Rooms) open(release *Release, how opening) (*Room, error) {
	if (!how.solo || how.starter != "") && !release.Manifest.Permissions.Play {
		return nil, fail(http.StatusUnprocessableEntity, "The creator has disabled play for this release.")
	}
	room, evicted, err := rs.add(release, how)
	if evicted != nil {
		evicted.close()
	}
	return room, err
}

// add registers a new room under one lock. At the limit it makes way by taking
// out the oldest solo playtest nobody is playing (those are not listed in
// Share), which the caller closes after the lock is released.
func (rs *Rooms) add(release *Release, how opening) (room, evicted *Room, err error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if how.starter != "" {
		if err := rs.sessionLimits(how.starter); err != nil {
			return nil, nil, err
		}
	}
	if len(rs.rooms) >= maxRooms {
		for _, id := range rs.order {
			if idle := rs.rooms[id]; idle != nil && idle.Solo && !idle.Connected() {
				evicted = rs.take(id)
				break
			}
		}
		if evicted == nil {
			return nil, nil, fail(http.StatusTooManyRequests, "Close an existing room before starting another.")
		}
	}
	playable := *release
	playable.files, playable.canonical = nil, nil
	room = newRoom(&playable, how.solo, how.access, how.development)
	room.starter = how.starter
	// A session has a code: a multiplayer room started from the lobby, or one
	// the owner opened on the LAN. A net game's goes to its space as that
	// opens (WithSpace).
	if !how.solo && multiplayer(release) && !isNet(release.Manifest.Simulation) && (how.starter != "" || how.access == "lan") {
		room.Code = rs.freeCode()
	}
	rs.rooms[room.ID] = room
	rs.order = append(rs.order, room.ID)
	return room, evicted, nil
}

// take removes a room from the table and returns it. The caller holds rs.mu
// and closes the room after releasing it.
func (rs *Rooms) take(id string) *Room {
	room := rs.rooms[id]
	delete(rs.rooms, id)
	for i, item := range rs.order {
		if item == id {
			rs.order = append(rs.order[:i], rs.order[i+1:]...)
			break
		}
	}
	return room
}
func (rs *Rooms) Get(id string) (*Room, error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if room := rs.rooms[id]; room != nil {
		return room, nil
	}
	return nil, fail(http.StatusNotFound, "This room does not exist or has closed.")
}
func (rs *Rooms) Close(id string) {
	rs.mu.Lock()
	room := rs.take(id)
	rs.mu.Unlock()
	if room != nil {
		room.close()
		if space := room.spaceOf(); space != nil && rs.kernel != nil {
			rs.kernel.Close(space.ID)
		}
	}
}

// List summarizes the shared rooms; solo playtests stay private to the editor.
func (rs *Rooms) List() []summary {
	list := []summary{}
	for _, room := range rs.list() {
		if !room.Solo {
			list = append(list, room.Summary())
		}
	}
	return list
}

// Session finds the open session with a code on the listener for access.
func (rs *Rooms) Session(code, access string) *Room {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for _, room := range rs.rooms {
		if room.Code != "" && same(room.Code, code) && room.Access == access {
			return room
		}
	}
	return nil
}

// Sessions are the open sessions with a code on the listener for access,
// newest first.
func (rs *Rooms) Sessions(access string) []*Room {
	list := []*Room{}
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for i := len(rs.order) - 1; i >= 0; i-- {
		if room := rs.rooms[rs.order[i]]; room != nil && room.Code != "" && room.Access == access {
			list = append(list, room)
		}
	}
	return list
}

// SpaceRoom is the room a space is of, on the listener for access: for a link
// the kernel formed, which names the space alone.
func (rs *Rooms) SpaceRoom(space, access string) (string, error) {
	for _, room := range rs.list() {
		if s := room.spaceOf(); s != nil && s.ID == space && room.Access == access {
			return room.ID, nil
		}
	}
	return "", fail(http.StatusNotFound, "This session has ended.")
}

// CloseProject ends every room playing a release of the project.
func (rs *Rooms) CloseProject(projectID string) {
	for _, room := range rs.list() {
		if room.Release.Manifest.GameID == projectID {
			rs.Close(room.ID)
		}
	}
}
func (rs *Rooms) Dispose() {
	close(rs.stop)
	rs.done.Wait()
	for _, room := range rs.list() {
		rs.Close(room.ID)
	}
}
