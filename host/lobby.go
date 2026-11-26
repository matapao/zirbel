package main

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// The lobby, mirroring the Node host: anyone who reaches a player listener
// sees the games the owner offers and the sessions being played, starts a
// session of an offered game and joins one by its code (sessions.go). The
// owner offers releases through the editor API; the list is lobby.json in
// the data directory. Its routes are lobby_routes.go.

// Lobby keeps the offered releases and the wrong codes guests try.
type Lobby struct {
	rooms    *Rooms
	releases *Releases
	file     string
	// editorAt, on a box: its editor's address on the host name a device
	// reached the lobby by, where the lobby links to its pairing page for those
	// who own the box and to its edit page for those with a game's edit code.
	editorAt func(host string) string
	// link is the lobby's address for other devices on the network
	// (Players.LobbyLink), set once the players are.
	link func(host string) *string

	mu      sync.Mutex
	offered []string             // release IDs, in the order they were offered
	known   map[string]lobbyGame // what the lobby shows of a release, read once: a stored release never changes
	codes   codeTries
}

// lobbyFile is lobby.json (contracts/lobby-file.schema.json).
type lobbyFile struct {
	Version int      `json:"version"`
	Offered []string `json:"offered"`
}

// lobbyGame is an offered game as the lobby lists it.
type lobbyGame struct {
	Release     string      `json:"release"`
	Title       string      `json:"title"`
	Players     playerRange `json:"players"`
	Multiplayer bool        `json:"multiplayer"`
	game        string      // its gameId: one release per game is offered
}

// lobbySession is a session as the lobby lists it: never its code or seats.
type lobbySession struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Players int    `json:"players"`
	Max     int    `json:"max"`
	Started string `json:"started"`
}

type lobbyState struct {
	Games    []lobbyGame    `json:"games"`
	Sessions []lobbySession `json:"sessions"`
	Pair     *string        `json:"pair"` // the box's pairing page; null elsewhere
	Edit     *string        `json:"edit"` // the box's edit page; null elsewhere
	// Link is the lobby's address for other devices on the network, as the
	// owner's side names it (Players.LobbyLink), on the LAN listener; null
	// elsewhere. The TV page's QR codes hold it.
	Link *string `json:"link"`
}

// The sentence the host stops with, word for word as the Node host says it.
var errLobbyUnreadable = errors.New("lobby.json in the data directory is not a lobby; move it aside to start with an empty one.") //nolint:staticcheck // printed as it is

func NewLobby(root string, rooms *Rooms, releases *Releases) (*Lobby, error) {
	l := &Lobby{rooms: rooms, releases: releases, file: filepath.Join(root, "lobby.json"), offered: []string{},
		known: map[string]lobbyGame{}, codes: codeTries{now: time.Now, tries: map[string]wrongTries{}}}
	data, err := os.ReadFile(l.file)
	if errors.Is(err, os.ErrNotExist) {
		return l, nil
	}
	if err != nil {
		return nil, err
	}
	var stored lobbyFile
	if decodeContract("lobby-file", data, &stored) != nil {
		return nil, errLobbyUnreadable
	}
	// The schema's refinement: a release is offered once.
	for _, id := range stored.Offered {
		if slices.Contains(l.offered, id) {
			return nil, errLobbyUnreadable
		}
		l.offered = append(l.offered, id)
	}
	return l, nil
}

// game is what the lobby shows of a stored release. The caller holds l.mu.
func (l *Lobby) game(id string) (lobbyGame, error) {
	if known, ok := l.known[id]; ok {
		return known, nil
	}
	release, err := l.releases.Read(id)
	if err != nil {
		return lobbyGame{}, err
	}
	return l.remember(release), nil
}

// remember keeps what the lobby shows of a release. The caller holds l.mu.
func (l *Lobby) remember(release *Release) lobbyGame {
	m := release.Manifest
	known := lobbyGame{Release: m.ReleaseID, Title: m.Title, Players: m.Players, Multiplayer: multiplayer(release), game: m.GameID}
	l.known[m.ReleaseID] = known
	return known
}

// Offered lists the offered release IDs.
func (l *Lobby) Offered() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.offered)
}

// Offer puts a release in the lobby, in place of another of its game, or takes
// it out, and returns the new list.
func (l *Lobby) Offer(id string, offered bool) ([]string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	next := slices.DeleteFunc(slices.Clone(l.offered), func(item string) bool { return item == id })
	if offered {
		release, err := l.releases.Read(id)
		if err != nil {
			return nil, err
		}
		if !release.Manifest.Permissions.Play {
			return nil, fail(http.StatusForbidden, "The creator has disabled play for this release.")
		}
		added := l.remember(release)
		next = slices.DeleteFunc(next, func(item string) bool {
			other, err := l.game(item)
			return err == nil && other.game == added.game
		})
		next = append(next, id)
	}
	data, err := jsJSON(lobbyFile{1, next})
	if err != nil {
		return nil, err
	}
	if err := atomicWrite(l.file, data); err != nil {
		return nil, err
	}
	l.offered = next
	return slices.Clone(next), nil
}

// State is the lobby on the listener for access, reached by the host name
// host: the offered games by title, and its sessions, newest first.
func (l *Lobby) State(access, host string) lobbyState {
	l.mu.Lock()
	games := make([]lobbyGame, 0, len(l.offered))
	for _, id := range l.offered {
		// A release this host cannot read is left out rather than failing the lobby.
		if game, err := l.game(id); err == nil {
			games = append(games, game)
		}
	}
	l.mu.Unlock()
	slices.SortStableFunc(games, func(a, b lobbyGame) int { return byTitle(a.Title, b.Title) })
	sessions := []lobbySession{}
	for _, room := range l.rooms.Sessions(access) {
		sessions = append(sessions, lobbySession{room.Session, room.Release.Manifest.Title, room.players(),
			room.Release.Manifest.Players.Max, isoTime(room.Started)})
	}
	var pair, edit *string
	if l.editorAt != nil {
		pairing, editing := l.editorAt(host)+"/pair", l.editorAt(host)+"/edit"
		pair, edit = &pairing, &editing
	}
	var link *string
	if access == "lan" && l.link != nil {
		link = l.link(host)
	}
	return lobbyState{games, sessions, pair, edit, link}
}

// byTitle orders titles as a reader does: case aside, then by case.
func byTitle(a, b string) int {
	if order := strings.Compare(strings.ToLower(a), strings.ToLower(b)); order != 0 {
		return order
	}
	return strings.Compare(a, b)
}

// Start opens a session of an offered release for the guest at address, and
// seats them in it: the room and their ticket.
func (l *Lobby) Start(id, name, access, address string) (*Room, string, error) {
	l.mu.Lock()
	offered := slices.Contains(l.offered, id)
	l.mu.Unlock()
	if !offered {
		return nil, "", fail(http.StatusNotFound, "That game is not in the lobby.")
	}
	// Refused before the release is read, and again as the room opens.
	if err := l.rooms.SessionLimits(address); err != nil {
		return nil, "", err
	}
	release, err := l.releases.Read(id)
	if err != nil {
		return nil, "", err
	}
	room, err := l.rooms.OpenSession(release, access, address)
	if err != nil {
		return nil, "", err
	}
	ticket, err := room.Seat(name, "player")
	if err != nil {
		l.rooms.Close(room.ID)
	}
	return room, ticket, err
}

// Join seats the guest at address in the session with that code.
func (l *Lobby) Join(input, name, access, address string) (*Room, string, error) {
	l.mu.Lock()
	if l.codes.blocked(address) {
		l.mu.Unlock()
		return nil, "", fail(http.StatusTooManyRequests, "Too many wrong codes. Wait a minute and try again.")
	}
	var room *Room
	if code := sessionCode(input); code != "" {
		room = l.rooms.Session(code, access)
	}
	if room == nil {
		l.codes.wrong(address)
	}
	l.mu.Unlock()
	if room == nil {
		return nil, "", fail(http.StatusNotFound, "No session has that code.")
	}
	ticket, err := room.Seat(name, "")
	return room, ticket, err
}
