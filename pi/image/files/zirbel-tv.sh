#!/bin/sh
# The box's HDMI console (zirbel-tv.service, AGENTS.md), as zirbel-tv: once the lobby's player listener answers,
# the image's Chromium full screen on its TV page under cage, a kiosk compositor that shows one program on the last
# display plugged in. Chromium keeps its own profile in this user's home: no first run, no translation, no crash
# bubbles, sound that plays without a click first. When Chromium ends, cage ends, and the unit starts it again.
set -eu
PORT=${ZIRBEL_PLAYER_PORT:-4174}
URL="http://127.0.0.1:$PORT/tv"
PROFILE="$HOME/.config/zirbel-tv"
# The editor may still be starting (at boot) or restarting: a page that can't load would stay an error page.
tries=0
until curl -fsS -o /dev/null -m 2 "http://127.0.0.1:$PORT/health"; do
  tries=$((tries + 1))
  [ "$tries" -lt 90 ] || { echo "The lobby's player listener does not answer on port $PORT." >&2; exit 1; }
  sleep 1
done
# A power cut leaves the profile as if Chromium crashed, and it would offer to restore its pages.
prefs="$PROFILE/Default/Preferences"
[ ! -f "$prefs" ] || sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[A-Za-z]*"/"exit_type":"Normal"/' "$prefs"
exec cage -d -m last -- /usr/bin/chromium --kiosk --ozone-platform=wayland --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check --disable-features=Translate,MediaRouter,DialMediaRouteProvider \
  --autoplay-policy=no-user-gesture-required --noerrdialogs --hide-crash-restore-bubble --disable-session-crashed-bubble \
  --password-store=basic --disable-component-update --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 --disable-pinch "$URL"
