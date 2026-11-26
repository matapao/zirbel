#!/bin/bash
# Installs the box's HDMI console (docs/box-tv.md) in the image's root, as chroot-app.sh runs it on a 64-bit box: its
# follower (pi/tv) beside the editor in /opt/zirbel, the kiosk's launcher and units, its PAM session, the folder the
# editor wakes the follower through, the udev rule for displays and gamepads, and the HDMI sound ahead of a headphone
# jack. Its packages (cage, PipeWire, fonts) and its user, zirbel-tv, come with the base stage.
#   tv-install.sh TV_DIR
set -euo pipefail
TV=$1
FILES=$(cd "$(dirname "$0")/files" && pwd)
id zirbel-tv >/dev/null 2>&1 || { echo "The base has no zirbel-tv user: make it again (--rebuild-base)." >&2; exit 1; }
command -v cage >/dev/null || { echo "The base has no cage: make it again (--rebuild-base)." >&2; exit 1; }
install -d -m 755 /opt/zirbel/pi/tv
install -m 644 "$TV/zirbel_tv.py" /opt/zirbel/pi/tv/
install -D -m 755 "$FILES/zirbel-tv.sh" /usr/local/libexec/zirbel-tv
install -m 644 "$FILES/zirbel-tv.service" "$FILES/zirbel-tv-follow.service" "$FILES/zirbel-tv-follow.path" /etc/systemd/system/
install -m 644 "$FILES/zirbel-tv.tmpfiles" /usr/lib/tmpfiles.d/zirbel-tv.conf
install -m 644 "$FILES/zirbel-tv.pam" /etc/pam.d/zirbel-tv
install -m 644 "$FILES/72-zirbel-tv.rules" /etc/udev/rules.d/72-zirbel-tv.rules
install -D -m 644 "$FILES/zirbel-tv-hdmi.conf" /etc/wireplumber/wireplumber.conf.d/90-zirbel-tv-hdmi.conf
systemctl enable zirbel-tv-follow.service zirbel-tv-follow.path >/dev/null 2>&1
python3 -E -s -c "import ast, pathlib; ast.parse(pathlib.Path('/opt/zirbel/pi/tv/zirbel_tv.py').read_text())"
echo "TV console installed: $(cage -v 2>&1 | head -1), $(chromium --version 2>/dev/null | head -1)."
