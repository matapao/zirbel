#!/bin/bash
# The app stage, in the image's own root (provision.sh), on the base stage, owned by root in /opt/zirbel so the
# service's own user can't change it: on a 64-bit box the Node editor build for Linux arm64 (build.mjs stages it), on a
# 32-bit box the Go host built for it; then the services.
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
# The installed program starts in box mode, as `zirbel`, with a throwaway account folder, and answers its health check on
# loopback. Its data folder is throwaway too, unless the box starts with games: then it is the box's own (~/.zirbel,
# both hosts' default), and each game goes into its library as the editor's folder import puts it.
dir=$(runuser -u zirbel -- mktemp -d)
data="$dir/data"
games=("$B"/games/*.json)
[ -e "${games[0]}" ] || games=()
[ ${#games[@]} -eq "${2:-0}" ] || { echo "Expected ${2:-0} games for the box's library, found ${#games[@]}." >&2; exit 1; }
[ ${#games[@]} -eq 0 ] || data=/home/zirbel/.zirbel
runuser -u zirbel -- env ZIRBEL_ACCOUNT_DIR="$dir/account" "${program[@]}" --box --data "$data" --port 48173 \
  >"$dir/log" 2>&1 &
pid=$!
health=
for _ in $(seq 1 100); do health=$(curl -fsS http://127.0.0.1:48173/api/health 2>/dev/null) && break; sleep 0.2; done
stop() { kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true; }
fail() { stop; cat "$dir/log" >&2; rm -rf "$dir"; echo "$1" >&2; exit 1; }
[ -n "$health" ] || fail "The installed program did not answer its health check."
for game in "${games[@]}"; do
  curl -fsS -o /dev/null -H 'content-type: application/json' --data-binary "@$game" \
    http://127.0.0.1:48173/api/projects/import-game || fail "The box could not take the game in $game."
done
stop
[ ${#games[@]} -eq 0 ] || echo "Games in the box's library: ${#games[@]}."
rm -rf "$dir"
echo "Health: $health"
echo "App ready ($(dpkg --print-architecture)): $(du -sh /opt/zirbel | cut -f1) in /opt/zirbel."
