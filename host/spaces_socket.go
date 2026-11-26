package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// The spaces kernel's local socket as the host's own code speaks it,
// mirroring packages/server/spaces-socket.ts: JSON-RPC 2.0, one message a
// line, app.hello with the token first. The host provides no rules, so what
// the kernel asks of it is answered as no method of its own. Below it, the
// calls a room makes (spaces.ts's open, ticket, close and list).

const (
	spacesLine = 4 << 20         // the longest line read from the kernel
	spacesWait = 5 * time.Second // how long a call waits for its answer
)

// spacesError is a call the kernel refused: its word for why (data.code, such
// as full or expired), and its message.
type spacesError struct{ Code, Message string }

func (e *spacesError) Error() string { return e.Message }

type spacesReply struct {
	ID     *int64          `json:"id"`
	Method string          `json:"method"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
		Data    *struct {
			Code string `json:"code"`
		} `json:"data"`
	} `json:"error"`
}

type spacesSocket struct {
	conn    net.Conn
	write   sync.Mutex
	mu      sync.Mutex
	next    int64
	pending map[int64]chan spacesReply
	done    chan struct{}
}

// dialSpaces connects to unix:<path> or tcp:127.0.0.1:<port>, and says hello.
func dialSpaces(address, token string) (*spacesSocket, error) {
	network, target := "unix", strings.TrimPrefix(address, "unix:")
	if strings.HasPrefix(address, "tcp:") {
		network, target = "tcp", strings.TrimPrefix(address, "tcp:")
		if host, _, err := net.SplitHostPort(target); err != nil || host != "127.0.0.1" {
			return nil, errors.New("the spaces socket is unix:<path> or tcp:127.0.0.1:<port>")
		}
	} else if !strings.HasPrefix(address, "unix:") {
		return nil, errors.New("the spaces socket is unix:<path> or tcp:127.0.0.1:<port>")
	}
	ctx, cancel := context.WithTimeout(context.Background(), spacesWait)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(ctx, network, target)
	if err != nil {
		return nil, err
	}
	s := &spacesSocket{conn: conn, pending: map[int64]chan spacesReply{}, done: make(chan struct{})}
	go s.read()
	if _, err := s.call("app.hello", map[string]any{"token": token, "protocol": 1}); err != nil {
		s.close()
		return nil, err
	}
	return s, nil
}

func (s *spacesSocket) close() { _ = s.conn.Close() }

func (s *spacesSocket) send(message any) {
	data, _ := json.Marshal(message)
	s.write.Lock()
	defer s.write.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(spacesWait))
	if _, err := s.conn.Write(append(data, '\n')); err != nil {
		s.close()
	}
}

// call calls a method: its result, or a *spacesError.
func (s *spacesSocket) call(method string, params any) (json.RawMessage, error) {
	unavailable := &spacesError{Code: "unavailable", Message: "The spaces kernel is not running."}
	answer := make(chan spacesReply, 1)
	s.mu.Lock()
	select {
	case <-s.done:
		s.mu.Unlock()
		return nil, unavailable
	default:
	}
	s.next++
	id := s.next
	s.pending[id] = answer
	s.mu.Unlock()
	s.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	select {
	case reply := <-answer:
		if reply.Error != nil {
			code := "error"
			if reply.Error.Data != nil && reply.Error.Data.Code != "" {
				code = reply.Error.Data.Code
			}
			return nil, &spacesError{Code: code, Message: reply.Error.Message}
		}
		return reply.Result, nil
	case <-s.done:
		return nil, unavailable
	case <-time.After(spacesWait):
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return nil, &spacesError{Code: "unavailable", Message: "The spaces kernel did not answer."}
	}
}

func (s *spacesSocket) read() {
	defer func() {
		s.mu.Lock()
		close(s.done)
		s.mu.Unlock()
		s.close()
	}()
	lines := bufio.NewScanner(s.conn)
	lines.Buffer(make([]byte, 64<<10), spacesLine)
	for lines.Scan() {
		var reply spacesReply
		if json.Unmarshal(lines.Bytes(), &reply) != nil {
			continue
		}
		if reply.Method != "" {
			// A request of the kernel's (rules the host doesn't provide): no such method here.
			if reply.ID != nil {
				go s.send(map[string]any{"jsonrpc": "2.0", "id": *reply.ID,
					"error": map[string]any{"code": -32601, "message": "Zirbel provides no " + reply.Method + "."}})
			}
			continue
		}
		if reply.ID == nil {
			continue
		}
		s.mu.Lock()
		answer := s.pending[*reply.ID]
		delete(s.pending, *reply.ID)
		s.mu.Unlock()
		if answer != nil {
			answer <- reply
		}
	}
}

// spaceOpened is a room's new space: its id, the invitation its link holds,
// and its code when it has one.
type spaceOpened struct{ Space, Invite, Code string }

var spaceSecret = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// Open opens a space for a net game's room, for the player listener, with the
// binary lane.
func (s *Spaces) Open(participants int, code bool) (spaceOpened, error) {
	result, err := s.Call("space.open", map[string]any{"rules": nil, "listener": spacesListener,
		"members": map[string]int{"participants": participants, "observers": spacesObservers}, "code": code, "binary": true})
	if err != nil {
		return spaceOpened{}, err
	}
	var opened struct{ Space, Link, Code string }
	if err := decodeContract("spaces-opened", result, &opened); err != nil {
		return spaceOpened{}, err
	}
	_, fragment, _ := strings.Cut(opened.Link, "#")
	values, _ := url.ParseQuery(fragment)
	invite := values.Get("skalet.invite")
	if !spaceSecret.MatchString(invite) {
		s.Close(opened.Space)
		return spaceOpened{}, &spacesError{Code: "protocol", Message: "The spaces kernel gave a link without its invitation."}
	}
	return spaceOpened{opened.Space, invite, opened.Code}, nil
}

// Ticket is a one-time ticket into a space, for a name and a role.
func (s *Spaces) Ticket(space, name, role string) (string, error) {
	result, err := s.Call("space.ticket", map[string]string{"space": space, "name": name, "role": role})
	if err != nil {
		return "", err
	}
	var ticket struct{ Ticket string }
	if err := decodeContract("spaces-ticket", result, &ticket); err != nil {
		return "", err
	}
	return ticket.Ticket, nil
}

// Close ends a space; its members hear it closed.
func (s *Spaces) Close(space string) {
	go func() { _, _ = s.Call("space.close", map[string]string{"space": space}) }()
}

// spaceMembers are a space's participants (connected, or away within their
// grace), and whether any member is connected.
type spaceMembers struct {
	participants int
	connected    bool
}

// List is every space of the host's the kernel holds, by id.
func (s *Spaces) List() (map[string]spaceMembers, error) {
	result, err := s.Call("space.list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var listed []struct {
		Space   string
		Members []struct {
			Role      string
			Connected bool
		}
	}
	if err := decodeContract("spaces-list", result, &listed); err != nil {
		return nil, err
	}
	out := make(map[string]spaceMembers, len(listed))
	for _, item := range listed {
		members := spaceMembers{}
		for _, member := range item.Members {
			if member.Role == "participant" {
				members.participants++
			}
			members.connected = members.connected || member.Connected
		}
		out[item.Space] = members
	}
	return out, nil
}
