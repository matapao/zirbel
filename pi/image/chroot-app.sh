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
  check=(runuser -u zirbel -- /usr/local/bin/node /opt/zirbel/server.mjs --help)
else
  install -D -m 755 "$B/zirbel-host" /opt/zirbel/zirbel-host
  install -m 644 "$B/files/zirbel-go.service" /etc/systemd/system/zirbel.service
  check=(runuser -u zirbel -- /opt/zirbel/zirbel-host --help)
fi
chown -R root:root /opt/zirbel
chmod -R u=rwX,go=rX /opt/zirbel
install -m 644 "$B/files/zirbel.avahi.xml" /etc/avahi/services/zirbel.service
systemctl enable zirbel.service >/dev/null 2>&1
[ ! -d "$B/setup" ] || bash "$B/setup-install.sh" "$B/setup" "$1"
"${check[@]}" 2>&1 | head -3 || true
echo "App ready ($(dpkg --print-architecture)): $(du -sh /opt/zirbel | cut -f1) in /opt/zirbel."
