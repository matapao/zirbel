#!/bin/bash
# The app stage, in the image's own root (provision.sh), on the base stage, owned by root in /opt/zirbel so the
# service's own user can't change it: on a 64-bit box the Node editor build for Linux arm64 (build.mjs stages it), on a
# 32-bit box the Go host built for it; then the services.
#   chroot-app.sh COUNTRY
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
systemctl enable zirbel.service >/dev/null 2>&1
[ ! -d "$B/setup" ] || bash "$B/setup-install.sh" "$B/setup" "$1"
# The installed program starts in box mode, as `zirbel`, with throwaway folders, and answers its health check on
# loopback; nothing it writes stays in the image.
dir=$(runuser -u zirbel -- mktemp -d)
runuser -u zirbel -- env ZIRBEL_ACCOUNT_DIR="$dir/account" "${program[@]}" --box --data "$dir/data" --port 48173 \
  >"$dir/log" 2>&1 &
pid=$!
health=
for _ in $(seq 1 100); do health=$(curl -fsS http://127.0.0.1:48173/api/health 2>/dev/null) && break; sleep 0.2; done
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true
[ -n "$health" ] || { cat "$dir/log" >&2; rm -rf "$dir"; echo "The installed program did not answer its health check." >&2; exit 1; }
rm -rf "$dir"
echo "Health: $health"
echo "App ready ($(dpkg --print-architecture)): $(du -sh /opt/zirbel | cut -f1) in /opt/zirbel."
