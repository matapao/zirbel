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
}

func NewRooms() *Rooms {
	rooms := &Rooms{rooms: map[string]*Room{}, stop: make(chan struct{})}
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

// Open mirrors Rooms.create in packages/core/rooms.ts, including solo
// playtests and development rooms.
func (rs *Rooms) Open(release *Release, solo bool, access string, development bool) (*Room, error) {
	if !solo && !release.Manifest.Permissions.Play {
		return nil, fail(http.StatusUnprocessableEntity, "The creator has disabled play for this release.")
	}
	if solo && access == "lan" {
		return nil, fail(http.StatusBadRequest, "Solo playtests use the local player service.")
	}
	room, evicted, err := rs.add(release, solo, access, development)
	if evicted != nil {
		evicted.close()
	}
	return room, err
}

// add registers a new room under one lock. At the limit it makes way by taking
// out the oldest solo playtest nobody is playing (those are not listed in
// Share), which the caller closes after the lock is released.
func (rs *Rooms) add(release *Release, solo bool, access string, development bool) (room, evicted *Room, err error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
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
	room = newRoom(&playable, solo, access, development)
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
