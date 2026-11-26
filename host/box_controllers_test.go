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

// Box settings' controllers over the pads' routing with a fake controller
// service, mirroring test/box-controllers.test.ts.

const testControllersView = `{"type":"controllers","scanning":false,"bluetooth":true,"pairing":null,"error":null,
"devices":[{"name":"USB gamepad","kind":"usb","connected":true,"device":0},
{"name":"Wireless Controller","kind":"bluetooth","connected":true,"device":1,"address":"A0:B1:C2:D3:E4:F5"},
{"name":"Arcade stick","kind":"bluetooth","connected":false,"address":"11:22:33:44:55:66"}],
"found":[{"address":"77:88:99:AA:BB:CC","name":"Pro pad"}]}`

// answeringService is the controller service's connection, which answers each
// request with answer's view (from its own goroutine: the pads are locked
// while they send).
type answeringService struct {
	mu     sync.Mutex
	pads   *Pads
	sent   []map[string]any
	answer func(map[string]any) string
}

func (f *answeringService) text(message any) {
	data, _ := json.Marshal(message)
	var value map[string]any
	_ = json.Unmarshal(data, &value)
	f.mu.Lock()
	f.sent = append(f.sent, value)
	answer := f.answer
	f.mu.Unlock()
	if answer != nil {
		go f.say(answer(value))
	}
}
func (f *answeringService) binary([]byte) {}
func (f *answeringService) close(int)     {}

func (f *answeringService) say(message string) {
	var parsed padsServiceMessage
	_ = json.Unmarshal([]byte(message), &parsed)
	f.pads.ServiceMessage(f, parsed, json.RawMessage(message))
}

func (f *answeringService) asked() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sent
}

func controllersBox(t *testing.T, answer func(map[string]any) string, wait time.Duration) (*Box, *Pads, *answeringService) {
	t.Helper()
	_, clock := padClock()
	pads := NewPads(clock)
	service := &answeringService{pads: pads, answer: answer}
	pads.AttachService(service)
	box := &Box{controllers: newBoxControllers(pads)}
	box.controllers.answer = wait
	return box, pads, service
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
	box, pads, service := controllersBox(t, nil, 50*time.Millisecond)
	service.say(`{"type":"device","device":0,"name":"USB gamepad","standard":true}`)
	tv := &fakePadLink{}
	screen := opened(t, pads.OpenScreen(tv, "local", true, ""))
	service.say(`{"type":"device","device":1,"name":"Wireless Controller","standard":true,"uid":"A0:B1:C2:D3:E4:F5"}`)
	service.say(testControllersView)
	status, answer, err := controllerCall(t, box, http.MethodGet, "", "")
	if err != nil || status != http.StatusOK {
		t.Fatalf("GET: %d %v", status, err)
	}
	devices, _ := answer["devices"].([]any)
	if len(devices) != 3 || answer["type"] != nil {
		t.Fatalf("devices: %v", answer)
	}
	for i, place := range []float64{0, 1} {
		item, _ := devices[i].(map[string]any)
		if on, _ := item["screen"].(map[string]any); on["code"] != screen.code || on["tv"] != true || on["place"] != place {
			t.Fatalf("on the TV as P%d: %v", i+1, item)
		}
	}
	if third, _ := devices[2].(map[string]any); third["screen"] != nil || third["device"] != nil {
		t.Fatalf("a controller not connected is on no screen: %v", third)
	}
	// A view the contract refuses is as good as none.
	service.say(`{"type":"controllers","devices":[{"name":"x","kind":"serial","connected":true}],"found":[],"scanning":false,"bluetooth":true,"pairing":null,"error":null}`)
	if _, _, err := controllerCall(t, box, http.MethodGet, "", ""); statusOf(err) != http.StatusServiceUnavailable {
		t.Fatalf("a refused view: %v", err)
	}
}

func TestTheOwnersRequestsGoToTheServiceAndAreAnsweredWithItsNextView(t *testing.T) {
	box, _, service := controllersBox(t, func(map[string]any) string {
		return strings.Replace(testControllersView, `"scanning":false`, `"scanning":true`, 1)
	}, time.Second)
	if status, answer, err := controllerCall(t, box, http.MethodPost, "scan", `{"on":true}`); err != nil || status != 200 || answer["scanning"] != true {
		t.Fatalf("scan: %d %v %v", status, answer, err)
	}
	for _, action := range []string{"pair", "forget"} {
		if _, _, err := controllerCall(t, box, http.MethodPost, action, `{"address":"77:88:99:AA:BB:CC"}`); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
	}
	sent := service.asked()
	if len(sent) != 3 || sent[0]["on"] != true || sent[1]["type"] != "pair" || sent[2]["address"] != "77:88:99:AA:BB:CC" {
		t.Fatalf("sent: %v", sent)
	}
	for _, bad := range [][2]string{{"pair", `{"address":"77:88:99:aa:bb:cc"}`}, {"forget", `{"address":"77:88"}`},
		{"scan", `{"on":"yes"}`}, {"scan", `{"on":true,"more":1}`}, {"pair", `{}`}} {
		if _, _, err := controllerCall(t, box, http.MethodPost, bad[0], bad[1]); statusOf(err) != http.StatusBadRequest {
			t.Fatalf("%s %s: %v", bad[0], bad[1], err)
		}
	}
	if len(service.asked()) != 3 {
		t.Fatal("a refused request reached the service")
	}
	for _, route := range [][2]string{{http.MethodGet, "scan"}, {http.MethodPost, ""}, {http.MethodPost, "connect"}, {http.MethodPut, "pair"}} {
		if status, _, _ := controllerCall(t, box, route[0], route[1], "{}"); status != 0 {
			t.Fatalf("%s %s is not one of these routes", route[0], route[1])
		}
	}
}

func TestAServiceThatDoesntAnswerLeavesTheViewItHad(t *testing.T) {
	box, _, service := controllersBox(t, nil, 20*time.Millisecond)
	if _, _, err := controllerCall(t, box, http.MethodGet, "", ""); statusOf(err) != http.StatusServiceUnavailable {
		t.Fatalf("connected with no view: %v", err)
	}
	service.say(testControllersView)
	if _, answer, err := controllerCall(t, box, http.MethodPost, "scan", `{"on":true}`); err != nil || answer["scanning"] != false {
		t.Fatalf("scan: %v %v", answer, err)
	}
}

func TestWithoutTheControllersServiceTheRoutesAnswer503(t *testing.T) {
	gone, pads, service := controllersBox(t, nil, 20*time.Millisecond)
	service.say(testControllersView)
	pads.ServiceGone(service)
	for _, box := range []*Box{{}, gone} {
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

func TestABoxGamepadThatGoesAndComesBackByItsUIDKeepsItsPlace(t *testing.T) {
	now, clock := padClock()
	pads := NewPads(clock)
	service := &fakePadLink{}
	pads.AttachService(service)
	say := func(link padsLink, message string) {
		var parsed padsServiceMessage
		_ = json.Unmarshal([]byte(message), &parsed)
		pads.ServiceMessage(link, parsed, json.RawMessage(message))
	}
	device := func(number, uid string) string {
		return `{"type":"device","device":` + number + `,"name":"Pad","standard":true` + uid + `}`
	}
	const uid = `,"uid":"A0:B1:C2:D3:E4:F5"`
	laptop := &fakePadLink{}
	screen := opened(t, pads.OpenScreen(laptop, "lan", false, ""))
	place := 2
	pads.ScreenMessage(screen, laptop, padsScreenMessage{Type: "claim", Place: &place})
	say(service, device("0", uid))
	pads.ServiceInput(service, 0, padFrame(1))
	at := func(number int) int {
		on, ok := pads.ScreenOf(number)
		if !ok {
			return -1
		}
		if on.Code != screen.code || on.TV {
			t.Fatalf("on %v", on)
		}
		return on.Place
	}
	if at(0) != 2 {
		t.Fatalf("the claimed place: %d", at(0))
	}
	// It drops and comes back as another number; the service restarts: the same place.
	say(service, `{"type":"gone","device":0}`)
	say(service, device("3", uid))
	if at(0) != -1 || at(3) != 2 {
		t.Fatalf("back as 3: %d %d", at(0), at(3))
	}
	pads.ServiceGone(service)
	again := &fakePadLink{}
	pads.AttachService(again)
	say(again, device("0", uid))
	if at(0) != 2 {
		t.Fatalf("after the service restarted: %d", at(0))
	}
	// Its place taken meanwhile, gone longer than a minute, or without a uid: it waits for a button.
	say(again, `{"type":"gone","device":0}`)
	phone := opened(t, pads.OpenPad(&fakePadLink{}, "lan", "192.168.1.30", screen.code, &place, ""))
	say(again, device("0", uid))
	if at(0) != -1 {
		t.Fatal("it took a phone's place")
	}
	pads.PadGone(phone)
	pads.ScreenMessage(screen, laptop, padsScreenMessage{Type: "claim", Place: &place})
	pads.ServiceInput(again, 0, padFrame(0))
	pads.ServiceInput(again, 0, padFrame(1))
	if at(0) != 2 {
		t.Fatalf("claimed again: %d", at(0))
	}
	say(again, `{"type":"gone","device":0}`)
	*now = now.Add(padResume)
	say(again, device("0", uid))
	say(again, device("1", ""))
	say(again, `{"type":"gone","device":1}`)
	say(again, device("1", ""))
	if at(0) != -1 || at(1) != -1 || !pads.Connected() {
		t.Fatalf("after a minute, and without a uid: %d %d", at(0), at(1))
	}
}
