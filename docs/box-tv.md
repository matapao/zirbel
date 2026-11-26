# The TV page and the box's HDMI console

A TV shows the lobby ten feet away. Any screen can: the TV page is served by every player listener at `/tv`, beside the
lobby page at `/`, and opens in a TV's own browser, a console's, a laptop cast to a TV, or the box's own HDMI output.
People play there with phones, gamepads on the box and gamepads on the screen's own device, each holding one of the
screen's places, P1 to P8.

## The TV page

`public/tv.html`, `packages/web/tv.ts` and the modules beside it; both hosts serve it (`lobby-routes.ts`,
`lobby_routes.go`), with the lobby page's content security policy and a `ws:` connection to its own host for the pads
socket.

- **The lobby.** Big tiles of the offered games and of the sessions being played, from the lobby's API on its own
  listener (`/lobby/state`, `/lobby/sessions`, `/lobby/join`), for a seat named "TV". Choosing a game starts a session
  (a multiplayer game's code is shown for the others, with a QR code that opens the lobby with it); choosing a session
  asks for its code, typed on letters a remote reaches or on a keyboard, since the lobby never lists codes.
- **Moving around.** A remote's or a keyboard's arrows, OK (Enter) and Back (Escape, Backspace, and the Back keys TVs
  send: `GoBack`, `BrowserBack`, webOS's 461, Tizen's 10009), and any gamepad: its d-pad or left stick moves, A or Start
  chooses, B or Select goes back, and a held direction repeats. Gamepads are the device's own (the Gamepad API) and the
  screen's controllers (phones, gamepads on the box) alike. Focus moves to the nearest tile in a direction, tiles in
  line before tiles beside it (`tv-focus.ts`).
- **A screen.** It opens the pads socket's screen side as it opens (`openScreen` in `pads-client.ts`), which keeps its
  resume token in this tab's sessionStorage, so the player page it goes to keeps the same screen. Its corner shows the places: each with its controller (a phone, a gamepad on the box or on this
  device), what it drives there, and its colour; a QR code for each free place (`/pad/<code>?place=k`) and a big one for
  the next free place, with the screen's code. Choosing a place offers "Press A to take P3" (the next controller whose
  A goes down takes it, for 30 s; while it waits A chooses nothing on the page), swapping it with another place, and
  letting its phone go. This device's own gamepads take a place on their first press, and the page tells the host which
  places they hold.
- **Into a game and back.** Starting or joining a session goes to the game's player page on the same listener, with
  `?screen=tv`; the player page resumes the same screen, so its controllers and places stay, and leaving the game goes
  back to `/tv` (`tv-return.ts`). Show on TV from another page (the host's `open`) goes to that page's game the same
  way, and only to a `/join/` page of this listener.
- **Old and small browsers.** The page's script is built for Chromium 80 (`scripts/build.mjs`) and its CSS keeps to
  what such browsers lay out. Where the browser has no WebGL 2 or no import maps, which games need, the page still
  shows the lobby and its sessions, says it can't play the games here, and sends each game to a phone or a laptop with
  the lobby's QR code. Full screen waits for a key, a click or a tap: a browser doesn't count a gamepad's press as a
  person's gesture.
- **Addresses for phones.** On the LAN listener, `/lobby/state` names the lobby's address for other devices (`link`),
  so a TV page opened on the box itself at `127.0.0.1` still puts an address phones reach in its QR codes.

## The box's HDMI console

On a 64-bit box (the arm64 image; the 32-bit image has none), a TV or monitor plugged into the box's HDMI shows the TV
page. The image installs it with `pi/image/tv-install.sh`, from `pi/tv/` and `pi/image/files/`:

| File | What |
| --- | --- |
| `zirbel-tv.service` | The kiosk: `cage`, a Wayland compositor that shows one program full screen on the last display plugged in, with the image's Chromium in kiosk mode on `http://127.0.0.1:4174/tv`, as the user `zirbel-tv`. A session on the seat (its PAM file, `zirbel-tv.pam`, with `pam_systemd`) on tty7 gives cage the display and the keyboard, and the user's PipeWire the sound. It is not enabled: the follower starts and stops it. |
| `zirbel-tv.sh` | Its launcher (`/usr/local/libexec/zirbel-tv`): waits for the player listener, clears a crashed profile's restore prompt, and runs cage and Chromium with its own profile in the user's home, no first run, no translation, no crash bubbles, and sound that plays without a click. |
| `zirbel-tv-follow.service`, `.path` | The follower (`pi/tv/zirbel_tv.py`, root): starts the console while a display is connected and the switch is on, stops it with no display or the switch off, and leaves it as it is while the editor doesn't answer. It runs at boot, when the editor's switch changes (it leaves `/run/zirbel-tv/wake`, which the path unit watches) and when a display comes or goes. |
| `72-zirbel-tv.rules` | udev: a DRM connector's hotplug runs the follower; and the seat's user gets no access to gamepads (`uaccess` taken off joysticks), so the box's gamepads reach the page through the host only, as every screen's controllers do. |
| `zirbel-tv.tmpfiles` | `/run/zirbel-tv`, root's and the editor's group's: the editor wakes the follower there, and says the box has a console while it is there (`canShowTv`). |
| `zirbel-tv-hdmi.conf` | WirePlumber: HDMI's sound ahead of a headphone jack. |

The user `zirbel-tv` is in `video`, `render` and `audio` alone: never the editor's user and never `input`. The base
stage makes it and installs `cage`, PipeWire (`pipewire`, `pipewire-pulse`, `wireplumber`, `dbus-user-session`) and
fonts for web pages and emoji. The editor's unit fixes the lobby's player port at 4174 (`ZIRBEL_PLAYER_PORT`), which
the kiosk opens.

**The switch.** Box settings' "Show the lobby on a TV" (`tv`, both hosts) starts on where a 64-bit box has at least
2 GB of memory, and off elsewhere; settings written before it take that default. Switching it wakes the follower.

**The box report** (`zirbel-report.sh`) names the displays plugged in and the console's and its follower's last lines.

## The editor is never the TV's

Box mode treats a loopback request as the box itself, with its owner's powers. The TV's browser runs on the box and
reaches the editor over loopback too, so loopback alone no longer decides: a loopback request is the box's own only
when the connecting socket belongs to the editor's own user or root (`packages/server/loopback-owner.ts`,
`host/loopback_owner.go`). On Linux the host reads the socket's owner from `/proc/net/tcp` and `/proc/net/tcp6`: the
socket whose local address and port are the request's remote address and port, and whose remote port is the
listener's, and its uid column. Any other user on the box comes as from the box's network: `/` goes to the lobby and
the rest needs pairing. Where the tables can't be read (not Linux), every loopback request stays the box's own. The
box's own callers keep working: the setup service runs as root, the harnesses' turns run as the editor's user, and the
report service doesn't call the editor.

## What the tests cover, and what needs a box with a TV

`test/browser-tv.mjs` drives the TV page in a browser, `test/tv-input.test.ts` its keys, gamepads and focus,
`test/lobby.contract.test.ts` both hosts serving it, `test/box.contract.test.ts` the switch on both hosts,
`test/loopback-owner.test.ts` and `host/loopback_owner_test.go` the loopback rule over the tables' text (and over this
system's own on Linux), and `pi/tv/test_tv.py` the follower over a DRM tree in sysfs's shape. Inside an image's root
(`systemd-nspawn` or a chroot) `systemd-analyze verify` reads the console's units and `udevadm verify` its rule; a
chroot can't make the user namespaces Chromium's sandbox uses. What needs a box with a TV: logind giving the kiosk's
session the seat on tty7, Chromium's sandbox under the unit, the GPU's WebGL 2, a display's hotplug reaching the
follower, HDMI sound through PipeWire, and how the page reads from across a room.
