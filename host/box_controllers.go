package main

import (
	"net/http"
	"sync"
	"time"
)

// The box's controllers in Box settings (--box), mirroring
// packages/server/box-controllers.ts: its gamepads, USB and Bluetooth, and
// Bluetooth pairing, as the box's controllers service (pi/controllers) sees
// them, with the screen and place each one has. The service is reached over
// the pads' local socket (--pads-socket), whose JSON control frames carry its
// views and the owner's requests: GET /api/box/controllers lists them, and
// POST …/scan ({on}), …/pair and …/forget ({address}) ask the service, which
// answers each with its view, which the route answers with. With no service
// connected they answer 503. Owners alone use them: an editor of one game
// never reaches /api/box/ (box_editor_access.go).

// controllerService is what the routes need of the pads' local socket:
// whether the service is connected, a JSON control frame to it, its JSON
// control frames that the pads' routing leaves alone (its controllers views),
// and where a box gamepad is now.
type controllerService interface {
	Connected() bool
	// Send sends the connected service a JSON control frame; false when none is connected.
	Send(message any) bool
	// OnControl calls listener with each JSON control frame the service sends.
	OnControl(listener func(message []byte))
	// ScreenOf is the screen a box gamepad (by its device number) is on now.
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

// boxControllers keeps the service's latest view; changed closes when the
// next one comes.
type boxControllers struct {
	service controllerService
	answer  time.Duration
	mu      sync.Mutex
	view    *controllersView
	changed chan struct{}
}

func newBoxControllers(service controllerService) *boxControllers {
	c := &boxControllers{service: service, answer: controllerAnswer, changed: make(chan struct{})}
	service.OnControl(c.take)
	return c
}

func (c *boxControllers) take(message []byte) {
	var view controllersView
	if decodeContract("controllers-view", message, &view) != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.view = &view
	close(c.changed)
	c.changed = make(chan struct{})
}

// next waits for the service's next view, or after a while the one it has.
func (c *boxControllers) next(changed chan struct{}) *controllersView {
	timer := time.NewTimer(c.answer)
	defer timer.Stop()
	select {
	case <-changed:
	case <-timer.C:
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.view
}

func (c *boxControllers) waiter() chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.changed
}

// read is the box's controllers, each with its screen and place.
func (c *boxControllers) read() (any, error) {
	if !c.service.Connected() {
		return nil, fail(http.StatusServiceUnavailable, noControllerService)
	}
	changed := c.waiter()
	c.mu.Lock()
	view := c.view
	c.mu.Unlock()
	if view == nil {
		view = c.next(changed)
	}
	return c.shown(view)
}

// ask sends the service a request and answers with the view it sends back.
func (c *boxControllers) ask(message any) (any, error) {
	changed := c.waiter()
	if !c.service.Send(message) {
		return nil, fail(http.StatusServiceUnavailable, noControllerService)
	}
	return c.shown(c.next(changed))
}

func (c *boxControllers) shown(view *controllersView) (any, error) {
	if view == nil || !c.service.Connected() {
		return nil, fail(http.StatusServiceUnavailable, noControllerService)
	}
	shown := *view
	shown.Devices = make([]controllerDevice, len(view.Devices))
	for i, item := range view.Devices {
		item.Screen = nil
		if item.Device != nil {
			if screen, ok := c.service.ScreenOf(*item.Device); ok {
				item.Screen = &screen
			}
		}
		shown.Devices[i] = item
	}
	return shown, nil
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
