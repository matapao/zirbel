#!/bin/bash
# Installs the box's Wi-Fi setup service (pi/setup) in the image's root, as chroot-app.sh runs it: its Python files
# beside the editor in /opt/zirbel, its systemd units, the folder where the editor asks for it, NetworkManager's
# dispatcher hook and the setup hotspot's DNS. Its Python bindings come with the base stage.
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
install -D -m 755 "$SETUP/90-zirbel-setup" /etc/NetworkManager/dispatcher.d/90-zirbel-setup
install -D -m 644 "$SETUP/dnsmasq-shared.conf" /etc/NetworkManager/dnsmasq-shared.d/zirbel-setup.conf
systemctl enable zirbel-setup.service zirbel-setup.path >/dev/null 2>&1
python3 -E -s -c "import ast, pathlib; [ast.parse(p.read_text()) for p in pathlib.Path('/opt/zirbel/pi/setup').glob('*.py')]"
echo "Setup service installed: $(ls /opt/zirbel/pi/setup | wc -l) files."
