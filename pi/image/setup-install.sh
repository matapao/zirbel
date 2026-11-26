#!/bin/bash
# Installs the box's Wi-Fi setup service (pi/setup) in the image's root, as chroot-app.sh runs it: its Python files
# beside the editor in /opt/zirbel, its systemd units, the folders where the editor asks for it and where the box's own
# Wi-Fi's name and password are kept, NetworkManager's dispatcher hook and the folder for the setup hotspot's DNS (which
# the service writes only while the hotspot runs). Its Python bindings come with the base stage.
#   setup-install.sh SETUP_DIR COUNTRY
set -euo pipefail
SETUP=$1
install -d -m 755 /opt/zirbel/pi/setup
for file in "$SETUP"/*.py; do
  case $(basename "$file") in test_*) continue ;; esac
  install -m 644 "$file" /opt/zirbel/pi/setup/
done
install -m 644 "$SETUP/zirbel-setup.service" "$SETUP/zirbel-setup.path" /etc/systemd/system/
install -m 644 "$SETUP/zirbel-setup.tmpfiles" /usr/lib/tmpfiles.d/zirbel-setup.conf
# Root's, readable by the editor's group alone; each new file takes its group (setgid). Made at boot too (tmpfiles).
install -d -m 2750 -o root -g zirbel /var/lib/zirbel-setup
install -D -m 755 "$SETUP/90-zirbel-setup" /etc/NetworkManager/dispatcher.d/90-zirbel-setup
install -d -m 755 /etc/NetworkManager/dnsmasq-shared.d
rm -f /etc/NetworkManager/dnsmasq-shared.d/zirbel-setup.conf
systemctl enable zirbel-setup.service zirbel-setup.path >/dev/null 2>&1
python3 -E -s -c "import ast, pathlib; [ast.parse(p.read_text()) for p in pathlib.Path('/opt/zirbel/pi/setup').glob('*.py')]"
echo "Setup service installed: $(ls /opt/zirbel/pi/setup | wc -l) files."
