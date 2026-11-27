package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"zirbel/contracts"
)

// A line from the spaces kernel as message in packages/server/spaces-socket.ts
// reads it: an object with a string method is a request of the kernel's,
// answered (with its id and method) only when its id is given; else one whose
// id is a call's number replies to that call, refused when its error is an
// object (data.code where it is a string, else error; its message where it is
// a string, else a word of the host's), else with its result as it came.
func FuzzKernelLine(f *testing.F) {
	for _, line := range []string{`{"jsonrpc":"2.0","id":1,"result":{"space":"0123456789ab","link":"x#skalet.invite=y"}}`,
		`{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Full.","data":{"code":"full"}}}`, `{"id":3,"error":{}}`,
		`{"id":3,"error":{"message":5,"data":{"code":""}}}`, `{"id":3,"error":"no"}`, `{"id":3,"error":null,"result":[1,2.50,"a"]}`,
		`{"id":1.0}`, `{"id":1e0,"result":1}`, `{"id":-0}`, `{"id":1.5}`, `{"id":"1"}`, `{"ID":1,"result":1}`, `{"id":1,"id":2}`,
		`{"jsonrpc":"2.0","id":7,"method":"rules.check","params":{}}`, `{"id":"seven","method":"x"}`, `{"id":null,"method":"x"}`,
		`{"method":"x"}`, `{"id":1,"method":""}`, `{"id":1,"method":5}`, `[{"id":1}]`, `{"id":1} {}`, `not json`, ``} {
		f.Add([]byte(line), uint32(1), []byte(`{"a":[1,"\u00e9",null]}`), "Full.", "full")
	}
	f.Fuzz(func(t *testing.T, line []byte, number uint32, result []byte, text, code string) {
		answer, call, reply, ok := kernelLine(line)
		if again, sameCall, sameReply, still := kernelLine(line); !contracts.Equal(again, answer) && (again != nil || answer != nil) ||
			sameCall != call || !bytes.Equal(sameReply.result, reply.result) || (sameReply.refused == nil) != (reply.refused == nil) || still != ok {
			t.Fatal("read twice, it reads otherwise")
		}
		value, err := contracts.Decode(line)
		message, isObject := value.(map[string]any)
		method, isRequest := message["method"].(string)
		id, given := message["id"]
		switch {
		case err != nil || !isObject || !json.Valid(line):
			if ok {
				t.Fatalf("%s: not a message of the kernel's, read as one", line)
			}
		case isRequest:
			sent, _ := json.Marshal(answer)
			expected, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id,
				"error": map[string]any{"code": -32601, "message": "Zirbel provides no " + method + "."}})
			want, _ := contracts.Decode(expected)
			if got, _ := contracts.Decode(sent); ok != (given && id != nil) || ok && !contracts.Equal(got, want) {
				t.Fatalf("%s: answered %v with %s", line, ok, sent)
			}
		default:
			number, isNumber := id.(json.Number)
			whole, err := strconv.ParseFloat(string(number), 64)
			if isNumber && err == nil && whole == math.Trunc(whole) && whole >= 1 && whole <= 1<<53 != (ok && answer == nil && call == int64(whole)) {
				t.Fatalf("%s: a reply %v to call %d", line, ok, call)
			}
			if !ok {
				return
			}
			refused, isRefusal := message["error"].(map[string]any)
			data, _ := refused["data"].(map[string]any)
			wantCode, isCode := data["code"].(string)
			wantText, isText := refused["message"].(string)
			if !isCode {
				wantCode = "error"
			}
			if !isText {
				wantText = "The spaces kernel refused that."
			}
			kept, hasResult := message["result"]
			var got any
			if reply.result != nil {
				got, _ = contracts.Decode(reply.result)
			}
			if isRefusal != (reply.refused != nil) || isRefusal && (reply.refused.Code != wantCode || reply.refused.Message != wantText) ||
				!isRefusal && (hasResult != (reply.result != nil) || hasResult && !contracts.Equal(got, kept)) {
				t.Fatalf("%s: replied %q, refused %+v", line, reply.result, reply.refused)
			}
		}
		// The kernel's own replies.
		if number == 0 || !json.Valid(result) {
			return
		}
		data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": number, "result": json.RawMessage(result)})
		if _, call, reply, ok := kernelLine(data); !ok || call != int64(number) || reply.refused != nil || !json.Valid(reply.result) {
			t.Fatalf("%s: %v call %d, %q", data, ok, call, reply.result)
		}
		data, _ = json.Marshal(map[string]any{"jsonrpc": "2.0", "id": number, "error": map[string]any{"code": -32000, "message": text,
			"data": map[string]any{"code": code}}})
		if _, call, reply, ok := kernelLine(data); !ok || call != int64(number) || reply.refused == nil ||
			*reply.refused != (spacesError{Code: asSent(code), Message: asSent(text)}) {
			t.Fatalf("%s: %v call %d, refused %+v", data, ok, call, reply.refused)
		}
	})
}

// asSent is a string as JSON carries it: valid UTF-8.
func asSent(text string) string {
	data, _ := json.Marshal(text)
	var sent string
	_ = json.Unmarshal(data, &sent)
	return sent
}

// A space's link as open in packages/server/spaces.ts reads its invitation:
// new URLSearchParams(link.split('#')[1] ?? "").get('skalet.invite'), which
// the host takes only where it is a secret.
func FuzzSpaceInvite(f *testing.F) {
	for _, link := range []string{"http://h:8/.skalet/join?space=0123456789ab#skalet.invite=AAAAAAAAAAAAAAAAAAAAAA",
		"#skalet.invite=AAAAAAAAAAAAAAAAAAAAAA#more", "#?skalet.invite=AAAAAAAAAAAAAAAAAAAAAA", "#skalet%2Einvite=AAAAAAAAAAAAAAAAAAAAA%41",
		"#skalet.invite=bad;&skalet.invite=AAAAAAAAAAAAAAAAAAAAAA", "#skalet.invite=%zz&skalet.invite=AAAAAAAAAAAAAAAAAAAAAA",
		"#a=1&&skalet.invite=AAAA+AAAAAAAAAAAAAAAAA", "#skalet.invite", "no fragment", "#skalet.invite=%%41%4"} {
		f.Add(link, []byte("a secret of sixteen bytes or more"))
	}
	percent := regexp.MustCompile(`%[0-9A-Fa-f]{2}`)
	decoded := func(text string) string {
		return percent.ReplaceAllStringFunc(strings.ReplaceAll(text, "+", " "), func(escape string) string {
			b, _ := hex.DecodeString(escape[1:])
			return string(b)
		})
	}
	f.Fuzz(func(t *testing.T, link string, secret []byte) {
		want := ""
		if parts := strings.Split(link, "#"); len(parts) > 1 {
			for pair := range strings.SplitSeq(strings.TrimPrefix(parts[1], "?"), "&") {
				name, value, _ := strings.Cut(pair, "=")
				if pair != "" && decoded(name) == "skalet.invite" {
					want = decoded(value)
					break
				}
			}
		}
		if got := linkInvite(link); got != want {
			t.Fatalf("%q: invitation %q; Node reads %q", link, got, want)
		}
		// The kernel's own link, with more after it.
		invite := base64.RawURLEncoding.EncodeToString(secret)
		if !spaceSecret.MatchString(invite) {
			return
		}
		made := "http://h:8/.skalet/join?space=0123456789ab&skalet.invite=no#a=1&skalet.invite=" + invite + "&skalet.invite=no#" + link
		if got := linkInvite(made); got != invite {
			t.Fatalf("%q: invitation %q", made, got)
		}
	})
}
