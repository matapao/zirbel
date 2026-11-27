package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"zirbel/contracts"
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

// spacesReply is the kernel's answer to a call: its result, or why it refused.
type spacesReply struct {
	result  json.RawMessage
	refused *spacesError
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
	if tcp, ok := strings.CutPrefix(address, "tcp:"); ok {
		network, target = "tcp", tcp
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
		if reply.refused != nil {
			return nil, reply.refused
		}
		return reply.result, nil
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
		answer, call, reply, ok := kernelLine(lines.Bytes())
		switch {
		case !ok:
		case answer != nil:
			go s.send(answer)
		default:
			s.mu.Lock()
			waiting := s.pending[call]
			delete(s.pending, call)
			s.mu.Unlock()
			if waiting != nil {
				waiting <- reply
			}
		}
	}
}

// kernelLine reads a line of the kernel's as message in spaces-socket.ts
// does, with JSON.parse's reading (names as they are, the last of duplicate
// ones, every number a double): a request of the kernel's (a string method),
// answered as no method of the host's when its id is given (answer); else the
// reply to the call its number names; else nothing (ok false).
func kernelLine(line []byte) (answer map[string]any, call int64, reply spacesReply, ok bool) {
	value, err := contracts.Decode(line)
	message, isObject := value.(map[string]any)
	if err != nil || !isObject {
		return nil, 0, spacesReply{}, false
	}
	if method, isRequest := message["method"].(string); isRequest {
		if id := message["id"]; id != nil {
			return map[string]any{"jsonrpc": "2.0", "id": id,
				"error": map[string]any{"code": -32601, "message": "Zirbel provides no " + method + "."}}, 0, spacesReply{}, true
		}
		return nil, 0, spacesReply{}, false
	}
	id, isNumber := message["id"].(json.Number)
	number, err := strconv.ParseFloat(string(id), 64)
	// The calls are numbered from 1, each a double's whole number.
	if !isNumber || err != nil || number != math.Trunc(number) || number < 1 || number > 1<<53 {
		return nil, 0, spacesReply{}, false
	}
	if refused, isObject := message["error"].(map[string]any); isObject {
		data, _ := refused["data"].(map[string]any)
		code, isText := data["code"].(string)
		if !isText {
			code = "error"
		}
		text, isText := refused["message"].(string)
		if !isText {
			text = "The spaces kernel refused that."
		}
		return nil, int64(number), spacesReply{refused: &spacesError{Code: code, Message: text}}, true
	}
	if result, given := message["result"]; given {
		reply.result, _ = json.Marshal(result)
	}
	return nil, int64(number), reply, true
}

// spaceOpened is a room's new space: its id, and the invitation its link
// holds.
type spaceOpened struct{ Space, Invite string }

var spaceSecret = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// Open opens a space for a net game's room, for the player listener, with the
// binary lane and the code the host chose for it, if any (a *spacesError
// taken when another space has it).
func (s *Spaces) Open(participants int, code string) (spaceOpened, error) {
	params := map[string]any{"rules": nil, "listener": spacesListener,
		"members": map[string]int{"participants": participants, "observers": spacesObservers}, "binary": true,
		"graceSeconds": spacesGrace}
	if code != "" {
		params["code"] = code
	}
	result, err := s.Call("space.open", params)
	if err != nil {
		return spaceOpened{}, err
	}
	var opened struct{ Space, Link string }
	if err := decodeContract("spaces-opened", result, &opened); err != nil {
		return spaceOpened{}, err
	}
	invite := linkInvite(opened.Link)
	if !spaceSecret.MatchString(invite) {
		s.Close(opened.Space)
		return spaceOpened{}, &spacesError{Code: "protocol", Message: "The spaces kernel gave a link without its invitation."}
	}
	return spaceOpened{opened.Space, invite}, nil
}

// linkInvite is the invitation a space's link holds, as open in spaces.ts
// reads it with URLSearchParams: in the text between the link's first # and
// the next, the value of the first name skalet.invite (+ a space, %XX its
// byte, any other % as it is), or none.
func linkInvite(link string) string {
	_, fragment, _ := strings.Cut(link, "#")
	fragment, _, _ = strings.Cut(fragment, "#")
	for pair := range strings.SplitSeq(strings.TrimPrefix(fragment, "?"), "&") {
		if name, value, _ := strings.Cut(pair, "="); formDecoded(name) == "skalet.invite" {
			return formDecoded(value)
		}
	}
	return ""
}

func formDecoded(text string) string {
	out := make([]byte, 0, len(text))
	for i := 0; i < len(text); i++ {
		if text[i] == '%' && i+2 < len(text) {
			if b, err := strconv.ParseUint(text[i+1:i+3], 16, 8); err == nil {
				out = append(out, byte(b))
				i += 2
				continue
			}
		}
		if text[i] == '+' {
			out = append(out, ' ')
		} else {
			out = append(out, text[i])
		}
	}
	return string(out)
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

// Member is the member of a space a page's proof names, which uses the proof
// up: its id; a *spacesError expired when it names none.
func (s *Spaces) Member(space, proof string) (string, error) {
	result, err := s.Call("space.member", map[string]string{"space": space, "proof": proof})
	if err != nil {
		return "", err
	}
	var member struct{ Member struct{ ID string } }
	if err := decodeContract("spaces-member", result, &member); err != nil {
		return "", err
	}
	return member.Member.ID, nil
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
