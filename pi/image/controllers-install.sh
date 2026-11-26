#!/bin/bash
# Installs the box's controllers service (pi/controllers) in the image's root, as chroot-app.sh runs it, on both
# targets: its Python files beside the editor in /opt/zirbel, its own user `zirbel-pads` (in the groups input, for
# /dev/input, and bluetooth, for BlueZ) and the group `zirbel-pads` it shares with the host's user `zirbel`, the folder
# for the host's local socket (/run/zirbel-pads, made at boot by tmpfiles), the udev rule that keeps the box's gamepads
# to this service, its unit, and Bluetooth on: BlueZ (Raspberry Pi OS Lite has it; installed here where it doesn't), its
# service started at boot, no overlay that turns the radio off, and no saved block on it. Its Python bindings come with
# the base stage.
#   controllers-install.sh CONTROLLERS_DIR
set -euo pipefail
DIR=$1
export DEBIAN_FRONTEND=noninteractive
if ! dpkg-query -W -f='${Status}' bluez 2>/dev/null | grep -q 'install ok installed'; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends bluez
  apt-get clean
  rm -rf /var/lib/apt/lists/*
fi
getent group zirbel-pads >/dev/null || groupadd --system zirbel-pads
id zirbel-pads >/dev/null 2>&1 || useradd --system --gid zirbel-pads --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin zirbel-pads
usermod --append --groups input,bluetooth zirbel-pads
passwd --lock zirbel-pads >/dev/null
# The host makes its socket in the folder, and the service connects to it: both in the group, no one else.
usermod --append --groups zirbel-pads zirbel
install -d -m 755 /opt/zirbel/pi/controllers
for file in "$DIR"/*.py; do
  case $(basename "$file") in test_*) continue ;; esac
  install -m 644 "$file" /opt/zirbel/pi/controllers/
done
install -m 644 "$DIR/zirbel-pads.service" /etc/systemd/system/
install -m 644 "$DIR/zirbel-pads.tmpfiles" /usr/lib/tmpfiles.d/zirbel-pads.conf
install -m 644 "$DIR/72-zirbel-pads.rules" /etc/udev/rules.d/72-zirbel-pads.rules
sed -i '/^[[:space:]]*dtoverlay=disable-bt/d' /boot/firmware/config.txt
for state in /var/lib/systemd/rfkill/*:bluetooth; do [ -e "$state" ] && echo 0 > "$state"; done
systemctl enable bluetooth.service zirbel-pads.service >/dev/null 2>&1
python3 -E -s -c "import ast, pathlib; [ast.parse(p.read_text()) for p in pathlib.Path('/opt/zirbel/pi/controllers').glob('*.py')]"
echo "Controllers service installed: $(ls /opt/zirbel/pi/controllers | wc -l) files, $(dpkg-query -W -f='${Version}' bluez) BlueZ."
