package main

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// The box's controllers in Box settings (--box), mirroring
// packages/server/box-controllers.ts: its gamepads, USB and Bluetooth, and
// Bluetooth pairing, as the box's controller service (pi/controllers) sees
// them, with the screen and place each one has. The service is reached over
// the pads' local socket (--pads-socket, pads_local.go), whose JSON control
// frames carry its views and the owner's requests: GET /api/box/controllers
// lists them, and POST …/scan ({on}), …/pair and …/forget ({address}) ask the
// service, which answers each with its view, which the route answers with. With no service
// connected they answer 503. Owners alone use them: an editor of one game
// never reaches /api/box/ (box_editor_access.go).

// controllerService is what the routes need of the pads (pads_box.go):
// whether the service is connected, its last view of the controllers (nil
// while it isn't), a hook for each new view, a JSON control frame to it, and
// where a box gamepad is now.
type controllerService interface {
	Connected() bool
	Controllers() json.RawMessage
	OnViewed(viewed func())
	ToService(message any) bool
	ScreenOf(device int) (controllerScreen, bool)
}

// controllerScreen is a box gamepad's screen: its code, whether it is the
// box's own (the TV), and the place it holds there (0 to 7, shown as P1 to P8).
type controllerScreen struct {
	Code  string `json:"code"`
	TV    bool   `json:"tv"`
	Place int    `json:"place"`
}

type controllerDevice struct {
	Name      string            `json:"name"`
	Kind      string            `json:"kind"`
	Connected bool              `json:"connected"`
	Device    *int              `json:"device,omitempty"`
	Address   string            `json:"address,omitempty"`
	Screen    *controllerScreen `json:"screen"`
}

type controllerFound struct {
	Address string `json:"address"`
	Name    string `json:"name"`
}

// controllersView is the service's view (contract controllers-view), and
// without its type what the routes answer.
type controllersView struct {
	Devices   []controllerDevice `json:"devices"`
	Found     []controllerFound  `json:"found"`
	Scanning  bool               `json:"scanning"`
	Bluetooth bool               `json:"bluetooth"`
	Pairing   *string            `json:"pairing"`
	Error     *string            `json:"error"`
}

const noControllerService = "The box’s controller service isn’t running."

// controllerAnswer is how long a request waits for the service's answer
// before the route answers with the view it has.
const controllerAnswer = 2 * time.Second

// boxControllers waits for the service's views: changed closes when the
// next one comes.
type boxControllers struct {
	service controllerService
	answer  time.Duration
	mu      sync.Mutex
	changed chan struct{}
}

func newBoxControllers(service controllerService) *boxControllers {
	c := &boxControllers{service: service, answer: controllerAnswer, changed: make(chan struct{})}
	service.OnViewed(c.viewed)
	return c
}

func (c *boxControllers) viewed() {
	c.mu.Lock()
	defer c.mu.Unlock()
	close(c.changed)
	c.changed = make(chan struct{})
}

func (c *boxControllers) waiter() chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.changed
}

// wait waits for the service's next view, or a while.
func (c *boxControllers) wait(changed chan struct{}) {
	timer := time.NewTimer(c.answer)
	defer timer.Stop()
	select {
	case <-changed:
	case <-timer.C:
	}
}

// view is the service's view now, as the contract reads it.
func (c *boxControllers) view() *controllersView {
	raw := c.service.Controllers()
	var view controllersView
	if raw == nil || decodeContract("controllers-view", raw, &view) != nil {
		return nil
	}
	return &view
}

// read is the box's controllers, each with its screen and place.
func (c *boxControllers) read() (any, error) {
	if !c.service.Connected() {
		return nil, fail(http.StatusServiceUnavailable, noControllerService)
	}
	changed := c.waiter()
	if c.view() == nil {
		c.wait(changed)
	}
	return c.shown()
}

// ask sends the service a request and answers with the view it sends back.
func (c *boxControllers) ask(message any) (any, error) {
	changed := c.waiter()
	if !c.service.ToService(message) {
		return nil, fail(http.StatusServiceUnavailable, noControllerService)
	}
	c.wait(changed)
	return c.shown()
}

func (c *boxControllers) shown() (any, error) {
	view := c.view()
	if view == nil || !c.service.Connected() {
		return nil, fail(http.StatusServiceUnavailable, noControllerService)
	}
	for i, item := range view.Devices {
		view.Devices[i].Screen = nil
		if item.Device != nil {
			if screen, ok := c.service.ScreenOf(*item.Device); ok {
				view.Devices[i].Screen = &screen
			}
		}
	}
	return view, nil
}

// serveControllers answers GET /api/box/controllers and POST
// /api/box/controllers/scan|pair|forget; handled says whether it did.
func (b *Box) serveControllers(w http.ResponseWriter, r *http.Request, action string) (bool, error) {
	if action == "" && r.Method == http.MethodGet {
		if b.controllers == nil {
			return true, fail(http.StatusServiceUnavailable, noControllerService)
		}
		view, err := b.controllers.read()
		return true, send(w, http.StatusOK, view, err)
	}
	if r.Method != http.MethodPost || (action != "scan" && action != "pair" && action != "forget") {
		return false, nil
	}
	data, err := readBody(r, 1024)
	if err != nil {
		return true, err
	}
	var message map[string]any
	if action == "scan" {
		var input struct{ On bool }
		if err := decodeContract("controllers-scan", data, &input); err != nil {
			return true, err
		}
		message = map[string]any{"type": action, "on": input.On}
	} else {
		var input struct{ Address string }
		if err := decodeContract("controllers-address", data, &input); err != nil {
			return true, err
		}
		message = map[string]any{"type": action, "address": input.Address}
	}
	if b.controllers == nil {
		return true, fail(http.StatusServiceUnavailable, noControllerService)
	}
	view, err := b.controllers.ask(message)
	return true, send(w, http.StatusOK, view, err)
}
