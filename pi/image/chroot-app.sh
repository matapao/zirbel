#!/bin/bash
# The app stage, in the image's own root (provision.sh), on the base stage: the editor build for Linux arm64
# (build.mjs stages it) in /opt/zirbel, owned by root so the editor's own user can't change it, and the services.
#   chroot-app.sh COUNTRY
set -euo pipefail
B=/tmp/zirbel-build
rm -rf /opt/zirbel
cp -R "$B/editor" /opt/zirbel
chown -R root:root /opt/zirbel
chmod -R u=rwX,go=rX /opt/zirbel
install -m 644 "$B/files/zirbel.service" /etc/systemd/system/zirbel.service
install -m 644 "$B/files/zirbel.avahi.xml" /etc/avahi/services/zirbel.service
systemctl enable zirbel.service >/dev/null 2>&1
[ ! -d "$B/setup" ] || bash "$B/setup-install.sh" "$B/setup" "$1"
runuser -u zirbel -- /usr/local/bin/node /opt/zirbel/server.mjs --help | head -3
echo "App ready: $(du -sh /opt/zirbel | cut -f1) editor."
