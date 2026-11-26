#!/bin/bash
# The app stage, in the image's own root (provision.sh), on the base stage, owned by root in /opt/zirbel so the
# service's own user can't change it: on a 64-bit box the Node editor build for Linux arm64 (build.mjs stages it), on a
# 32-bit box the Go host built for it; then the services: the box's own, its Wi-Fi setup and its controllers.
#   chroot-app.sh COUNTRY [GAMES]   (GAMES: how many game folders build.mjs handed over, all of which must arrive)
set -euo pipefail
B=/tmp/zirbel-build
rm -rf /opt/zirbel
if [ -d "$B/editor" ]; then
  cp -R "$B/editor" /opt/zirbel
  install -m 644 "$B/files/zirbel-node.service" /etc/systemd/system/zirbel.service
  program=(/usr/local/bin/node /opt/zirbel/server.mjs)
else
  install -D -m 755 "$B/zirbel-host" /opt/zirbel/zirbel-host
  install -m 644 "$B/files/zirbel-go.service" /etc/systemd/system/zirbel.service
  program=(/opt/zirbel/zirbel-host)
fi
chown -R root:root /opt/zirbel
chmod -R u=rwX,go=rX /opt/zirbel
install -m 644 "$B/files/zirbel.avahi.xml" /etc/avahi/services/zirbel.service
install -m 644 "$B/files/wifi-awake.conf" /etc/NetworkManager/conf.d/90-zirbel-wifi-awake.conf
install -m 755 "$B/files/zirbel-report.sh" /usr/local/sbin/zirbel-report
install -m 644 "$B/files/zirbel-report.service" "$B/files/zirbel-report.timer" /etc/systemd/system/
systemctl enable zirbel-report.timer >/dev/null 2>&1
systemctl enable zirbel.service >/dev/null 2>&1
[ ! -d "$B/setup" ] || bash "$B/setup-install.sh" "$B/setup" "$1"
# The HDMI console on a 64-bit box (build.mjs hands its follower over there alone).
[ ! -d "$B/tv" ] || bash "$B/tv-install.sh" "$B/tv"
[ ! -d "$B/controllers" ] || bash "$B/controllers-install.sh" "$B/controllers"
# The installed program starts in box mode, as `zirbel`, with a throwaway account folder, and answers its health check on
# loopback. Its data folder is throwaway too, unless the box starts with games: then it is the box's own (~/.zirbel,
# both hosts' default), and each game goes into its library as the editor's folder import puts it, then into its lobby.
# It takes any free port for its LAN player listener, which a box runs from start-up.
dir=$(runuser -u zirbel -- mktemp -d)
data="$dir/data"
games=("$B"/games/*.json)
[ -e "${games[0]}" ] || games=()
[ ${#games[@]} -eq "${2:-0}" ] || { echo "Expected ${2:-0} games for the box's library, found ${#games[@]}." >&2; exit 1; }
[ ${#games[@]} -eq 0 ] || data=/home/zirbel/.zirbel
runuser -u zirbel -- env ZIRBEL_ACCOUNT_DIR="$dir/account" "${program[@]}" --box --data "$data" --port 48173 --player-port 0 \
  >"$dir/log" 2>&1 &
pid=$!
health=
for _ in $(seq 1 100); do health=$(curl -fsS http://127.0.0.1:48173/api/health 2>/dev/null) && break; sleep 0.2; done
stop() { kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true; }
fail() { stop; cat "$dir/log" >&2; rm -rf "$dir"; echo "$1" >&2; exit 1; }
[ -n "$health" ] || fail "The installed program did not answer its health check."
# Each game is published, to be played but neither downloaded nor remixed, and offered in the box's lobby.
api=http://127.0.0.1:48173/api
field() { python3 -I -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1" 2>/dev/null; }
id='^[a-z0-9][a-z0-9_-]{0,79}$'
for game in "${games[@]}"; do
  project=$(curl -fsS -H 'content-type: application/json' --data-binary "@$game" "$api/projects/import-game") ||
    fail "The box could not take the game in $game."
  project=$(field id <<<"$project") && [[ $project =~ $id ]] || fail "The box named no project for the game in $game."
  release=$(curl -fsS -H 'content-type: application/json' --data '{"permissions":{"play":true,"download":false,"remix":false}}' \
    "$api/projects/$project/release") || fail "The box could not publish the game in $game."
  release=$(field releaseId <<<"$release") && [[ $release =~ $id ]] || fail "The box named no release for the game in $game."
  curl -fsS -o /dev/null -H 'content-type: application/json' --data "{\"release\":\"$release\",\"offered\":true}" \
    "$api/lobby/offer" || fail "The box could not offer the game in $game in its lobby."
done
stop
[ ${#games[@]} -eq 0 ] || echo "Games in the box's library: ${#games[@]}."
rm -rf "$dir"
echo "Health: $health"
echo "App ready ($(dpkg --print-architecture)): $(du -sh /opt/zirbel | cut -f1) in /opt/zirbel."
