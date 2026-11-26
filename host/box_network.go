package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

// The box's own Wi-Fi (--box), mirroring packages/server/box-network.ts:
// instead of joining a network, the box makes one with a password, which
// phones, tablets and computers join to play, with no router and no internet.
// The box's setup service (pi/setup/own_network.py) makes its name and
// password once and keeps them outside the data folder, readable by the
// editor's group and no one else (/var/lib/zirbel-setup/own-network.json, or
// ZIRBEL_OWN_NETWORK); the editor shows them to its paired devices. The
// ownNetwork switch says whether the box makes it. Switching it wakes the
// setup service, the only thing that changes the Wi-Fi; a box with no name
// and password (no Wi-Fi setup) can't switch it on.

type ownNetwork struct {
	Name     string
	Password string
}

const ownNetworkBytes = 4096

var (
	// passphrase is a WPA2 passphrase: 8 to 63 printable ASCII characters.
	passphrase              = regexp.MustCompile(`^[\x20-\x7e]{8,63}$`)
	errNoOwnNetwork         = fail(http.StatusConflict, "This box can’t make its own Wi-Fi: it has no Wi-Fi setup.")
	errOwnNetworkUnreadable = fail(http.StatusInternalServerError, "The box’s own Wi-Fi could not be read.")
)

// readOwnNetwork reads the network's name and password, checked as a network
// takes them (a name of 1 to 32 bytes); found is false where the setup
// service made none.
func readOwnNetwork(file string) (network ownNetwork, found bool, err error) {
	handle, err := os.Open(file) // #nosec G304 G703 -- a fixed path from the box's environment
	if errors.Is(err, os.ErrNotExist) {
		return network, false, nil
	}
	if err != nil {
		return network, false, errOwnNetworkUnreadable
	}
	defer func() { _ = handle.Close() }()
	data, err := io.ReadAll(io.LimitReader(handle, ownNetworkBytes+1))
	var stored struct {
		Version  int    `json:"version"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if err != nil || len(data) > ownNetworkBytes || strictKeys(data, "version", "name", "password") != nil ||
		!allKeys(data, "version", "name", "password") || json.Unmarshal(data, &stored) != nil || stored.Version != 1 ||
		stored.Name == "" || len(stored.Name) > 32 || !passphrase.MatchString(stored.Password) {
		return network, false, errOwnNetworkUnreadable
	}
	return ownNetwork{Name: stored.Name, Password: stored.Password}, true, nil
}

// wake wakes the setup service through a file it removes: a systemd path unit
// starts the service when one appears. A box without the service has no
// folder for it, and the change stays in the settings only.
func wake(file string) error {
	// The service's group reads the file; its path is the box's own configuration.
	err := os.WriteFile(file, nil, 0o660) // #nosec G304 G306 G703 -- a fixed path from the box's environment, empty
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// networkWake is the file that wakes the setup service for the box's own
// Wi-Fi, beside its setup request.
func networkWake(setupRequest string) string {
	return filepath.Join(filepath.Dir(setupRequest), "network")
}

// network answers GET /api/box/network, for paired devices and the box
// itself: whether the box makes its own Wi-Fi, and the network with its
// password, or null on a box that can't make one.
func (b *Box) network(w http.ResponseWriter) error {
	switches, err := b.settings.Read()
	if err != nil {
		return err
	}
	network, found, err := readOwnNetwork(b.ownNetwork)
	if err != nil {
		return err
	}
	var view any // null where the box can't make one
	if found {
		// The Go host draws no QR code; the editor shows the name and password.
		view = map[string]any{"name": network.Name, "password": network.Password, "qr": nil}
	}
	reply(w, http.StatusOK, map[string]any{"ownNetwork": switches.OwnNetwork, "network": view})
	return nil
}
