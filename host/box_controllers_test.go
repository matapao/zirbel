package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const testControllersView = `{"type":"controllers","scanning":false,"bluetooth":true,"pairing":null,"error":null,
"devices":[{"name":"USB gamepad","kind":"usb","connected":true,"device":0},
{"name":"Wireless Controller","kind":"bluetooth","connected":true,"device":1,"address":"A0:B1:C2:D3:E4:F5"},
{"name":"Arcade stick","kind":"bluetooth","connected":false,"address":"11:22:33:44:55:66"}],
"found":[{"address":"77:88:99:AA:BB:CC","name":"Pro pad"}]}`

// fakeControllerService is the pads' local socket with a controllers service
// on it, which answers each request with answer's view.
type fakeControllerService struct {
	mu        sync.Mutex
	on        bool
	sent      []map[string]any
	listeners []func([]byte)
	answer    func(map[string]any) string
}

func (f *fakeControllerService) Connected() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.on
}

func (f *fakeControllerService) Send(message any) bool {
	f.mu.Lock()
	if !f.on {
		f.mu.Unlock()
		return false
	}
	asked, _ := message.(map[string]any)
	f.sent = append(f.sent, asked)
	answer := f.answer
	f.mu.Unlock()
	if answer != nil {
		go f.emit(answer(asked))
	}
	return true
}

func (f *fakeControllerService) OnControl(listener func([]byte)) {
	f.listeners = append(f.listeners, listener)
}

func (f *fakeControllerService) ScreenOf(device int) (controllerScreen, bool) {
	return controllerScreen{Code: "KQWZ", TV: true, Place: 1}, device == 1
}

func (f *fakeControllerService) emit(message string) {
	for _, listener := range f.listeners {
		listener([]byte(message))
	}
}

func controllerCall(t *testing.T, box *Box, method, action, body string) (int, map[string]any, error) {
	t.Helper()
	r := httptest.NewRequestWithContext(t.Context(), method, "/api/box/controllers/"+action, strings.NewReader(body))
	r.Header.Set("content-type", "application/json")
	w := httptest.NewRecorder()
	handled, err := box.serveControllers(w, r, action)
	if !handled {
		return 0, nil, nil
	}
	var answer map[string]any
	if err == nil {
		if json.Unmarshal(w.Body.Bytes(), &answer) != nil {
			t.Fatalf("not JSON: %s", w.Body)
		}
	}
	return w.Code, answer, err
}

func TestTheBoxsControllersComeWithTheirScreenAndPlace(t *testing.T) {
	service := &fakeControllerService{on: true}
	box := &Box{controllers: newBoxControllers(service)}
	box.controllers.answer = 50 * time.Millisecond
	service.emit(testControllersView)
	// A view the service shouldn't have sent leaves the last one; so does a pad's.
	service.emit(`{"type":"controllers","devices":[{"name":"x","kind":"serial","connected":true}],"found":[],"scanning":false,"bluetooth":true,"pairing":null,"error":null}`)
	service.emit(`{"type":"device","device":2,"name":"Other","standard":true,"uid":"usb-1"}`)
	status, answer, err := controllerCall(t, box, http.MethodGet, "", "")
	if err != nil || status != http.StatusOK {
		t.Fatalf("GET: %d %v", status, err)
	}
	devices, _ := answer["devices"].([]any)
	if len(devices) != 3 || answer["type"] != nil {
		t.Fatalf("devices: %v", answer)
	}
	first, _ := devices[0].(map[string]any)
	second, _ := devices[1].(map[string]any)
	third, _ := devices[2].(map[string]any)
	if first["screen"] != nil || third["screen"] != nil || third["device"] != nil {
		t.Fatalf("a gamepad on no screen, or not connected, has none: %v %v", first, third)
	}
	if screen, _ := second["screen"].(map[string]any); screen["code"] != "KQWZ" || screen["tv"] != true || screen["place"] != 1.0 {
		t.Fatalf("on the TV as P2: %v", second)
	}
}

func TestTheOwnersRequestsGoToTheServiceAndAreAnsweredWithItsNextView(t *testing.T) {
	service := &fakeControllerService{on: true, answer: func(asked map[string]any) string {
		return strings.Replace(testControllersView, `"scanning":false`, `"scanning":true`, 1)
	}}
	box := &Box{controllers: newBoxControllers(service)}
	box.controllers.answer = time.Second
	if status, answer, err := controllerCall(t, box, http.MethodPost, "scan", `{"on":true}`); err != nil || status != 200 || answer["scanning"] != true {
		t.Fatalf("scan: %d %v %v", status, answer, err)
	}
	for _, action := range []string{"pair", "forget"} {
		if _, _, err := controllerCall(t, box, http.MethodPost, action, `{"address":"77:88:99:AA:BB:CC"}`); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
	}
	if len(service.sent) != 3 || service.sent[0]["on"] != true || service.sent[1]["type"] != "pair" || service.sent[2]["address"] != "77:88:99:AA:BB:CC" {
		t.Fatalf("sent: %v", service.sent)
	}
	for _, bad := range [][2]string{{"pair", `{"address":"77:88:99:aa:bb:cc"}`}, {"forget", `{"address":"77:88"}`},
		{"scan", `{"on":"yes"}`}, {"scan", `{"on":true,"more":1}`}, {"pair", `{}`}} {
		if _, _, err := controllerCall(t, box, http.MethodPost, bad[0], bad[1]); statusOf(err) != http.StatusBadRequest {
			t.Fatalf("%s %s: %v", bad[0], bad[1], err)
		}
	}
	if len(service.sent) != 3 {
		t.Fatal("a refused request reached the service")
	}
	for _, route := range [][2]string{{http.MethodGet, "scan"}, {http.MethodPost, ""}, {http.MethodPost, "connect"}, {http.MethodPut, "pair"}} {
		if status, _, _ := controllerCall(t, box, route[0], route[1], "{}"); status != 0 {
			t.Fatalf("%s %s is not one of these routes", route[0], route[1])
		}
	}
}

func TestAServiceThatDoesntAnswerLeavesTheViewItHad(t *testing.T) {
	service := &fakeControllerService{on: true}
	box := &Box{controllers: newBoxControllers(service)}
	box.controllers.answer = 20 * time.Millisecond
	service.emit(testControllersView)
	if _, answer, err := controllerCall(t, box, http.MethodPost, "scan", `{"on":true}`); err != nil || answer["scanning"] != false {
		t.Fatalf("scan: %v %v", answer, err)
	}
	quiet := &Box{controllers: newBoxControllers(&fakeControllerService{on: true})}
	quiet.controllers.answer = 20 * time.Millisecond
	if _, _, err := controllerCall(t, quiet, http.MethodGet, "", ""); statusOf(err) != http.StatusServiceUnavailable {
		t.Fatalf("connected with no view: %v", err)
	}
}

func TestWithoutTheControllersServiceTheRoutesAnswer503(t *testing.T) {
	for _, box := range []*Box{{}, {controllers: newBoxControllers(&fakeControllerService{})}} {
		for _, route := range [][3]string{{http.MethodGet, "", ""}, {http.MethodPost, "scan", `{"on":true}`},
			{http.MethodPost, "pair", `{"address":"77:88:99:AA:BB:CC"}`}} {
			_, _, err := controllerCall(t, box, route[0], route[1], route[2])
			var known *HTTPError
			if !errors.As(err, &known) || known.Status != http.StatusServiceUnavailable || known.Message != noControllerService {
				t.Fatalf("%v: %v", route, err)
			}
		}
	}
}
