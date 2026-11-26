#!/bin/bash
# The base stage, in the image's own root (provision.sh): what a Zirbel box runs beside Raspberry Pi OS Lite.
#   chroot-base.sh COUNTRY SSH_KEY_FILE
# Every box gets the Python bindings its Wi-Fi setup service uses (D-Bus and GLib, for NetworkManager), git (each of its
# games is a git repository, AGENTS.md), and:
# - Two users: `zirbel` runs the editor (and the harnesses) and can't use sudo; `admin` is for maintenance over SSH,
#   with the given public key only.
# - The Wi-Fi country, which Wi-Fi needs before it turns on, and the host name `zirbel` (zirbel.local).
# A 64-bit box (arm64) also gets what its harnesses need, none of which is made for 32-bit ARM, where the Go host runs
# instead (chroot-app.sh):
# - Node 26, from nodejs.org, checked against its published SHA-256.
# - Claude Code from Anthropic's installer, which keeps it up to date, and Codex from npm, both as `zirbel`'s.
# - Their command sandboxes (bubblewrap, socat), and Chromium for view_game.
# And what its HDMI console needs (docs/box-tv.md, tv-install.sh): the cage kiosk compositor for that Chromium on a
# session logind gives the seat, PipeWire for the TV's sound over HDMI, fonts for web pages and their emoji, and its own
# user, `zirbel-tv`, in video, render and audio alone.
set -euo pipefail
COUNTRY=$1 SSH_KEY_FILE=$2
NODE_VERSION=26.13.1
NODE_SHA256=89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd
CODEX_VERSION=0.171.0
export DEBIAN_FRONTEND=noninteractive
[[ $COUNTRY =~ ^[A-Z]{2}$ ]] || { echo "The Wi-Fi country must be two capital letters." >&2; exit 1; }

ARCH=$(dpkg --print-architecture)
HARNESSES=()
CONSOLE=()
[ "$ARCH" = arm64 ] && HARNESSES=(bubblewrap socat chromium xz-utils)
[ "$ARCH" = arm64 ] && CONSOLE=(cage pipewire pipewire-pulse wireplumber dbus-user-session fonts-liberation2 fonts-noto-color-emoji)
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3-dbus python3-gi ca-certificates git "${HARNESSES[@]}" "${CONSOLE[@]}"
apt-get clean

install_node() {
  local node=node-v$NODE_VERSION-linux-arm64.tar.xz
  curl -fsSLo "/tmp/$node" "https://nodejs.org/dist/v$NODE_VERSION/$node"
  echo "$NODE_SHA256  /tmp/$node" | sha256sum -c --quiet
  tar -xJf "/tmp/$node" -C /usr/local --strip-components=1 --no-same-owner --exclude='*/CHANGELOG.md' --exclude='*/README.md'
  rm "/tmp/$node"
  node --version
}

id admin >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --groups sudo,adm admin
passwd --lock admin >/dev/null
install -d -m 700 -o admin -g admin /home/admin/.ssh
install -m 600 -o admin -g admin "$SSH_KEY_FILE" /home/admin/.ssh/authorized_keys
echo 'admin ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/010-admin
chmod 440 /etc/sudoers.d/010-admin
install -m 644 /tmp/zirbel-build/files/sshd.conf /etc/ssh/sshd_config.d/zirbel.conf
systemctl enable ssh >/dev/null 2>&1

id zirbel >/dev/null 2>&1 || useradd --create-home --home-dir /home/zirbel --shell /bin/bash --groups netdev zirbel
passwd --lock zirbel >/dev/null
if [ "$ARCH" = arm64 ]; then
  id zirbel-tv >/dev/null 2>&1 ||
    useradd --create-home --home-dir /home/zirbel-tv --shell /usr/sbin/nologin --groups video,render,audio zirbel-tv
  passwd --lock zirbel-tv >/dev/null
fi
if [ "$ARCH" = arm64 ]; then
  install_node
  # Anthropic's installer, as `zirbel`: its own binary for this system, checked against its manifest, in ~/.local.
  runuser -u zirbel -- bash -c 'cd ~ && curl -fsSL https://claude.ai/install.sh | bash' </dev/null
  runuser -u zirbel -- /home/zirbel/.local/bin/claude --version
  npm install --global --no-fund --no-audit "@openai/codex@$CODEX_VERSION"
  codex --version
fi

# No first-boot wizard asks for a user: the box has its two.
systemctl disable userconfig.service >/dev/null 2>&1 || true
rm -f /etc/ssh/sshd_config.d/rename_user.conf

echo zirbel > /etc/hostname
# cloud-init would set the host name again on first boot; it keeps this one.
printf '# A Zirbel box keeps its host name, zirbel (zirbel.local).\npreserve_hostname: true\n' > /etc/cloud/cloud.cfg.d/90-zirbel.cfg
sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tzirbel/' /etc/hosts
grep -q '^127\.0\.1\.1' /etc/hosts || printf '127.0.1.1\tzirbel\n' >> /etc/hosts
if [ "$ARCH" = arm64 ] && ! grep -q '^kernel=kernel8.img' /boot/firmware/config.txt; then
  # The Pi 5 boots the 4K-page kernel the Pi 3 and 4 use: Claude Code's bundled tools fail on its 16K-page one.
  printf '\n# Zirbel: the 4K-page kernel, which Claude Code needs.\n[pi5]\nkernel=kernel8.img\n[all]\n' >> /boot/firmware/config.txt
fi
# Wi-Fi stays blocked until a country is set; the kernel takes it at boot, and the saved block is cleared.
sed -i "s/ cfg80211\.ieee80211_regdom=[A-Z]*//; s/\$/ cfg80211.ieee80211_regdom=$COUNTRY/" /boot/firmware/cmdline.txt
for state in /var/lib/systemd/rfkill/*:wlan; do [ -e "$state" ] && echo 0 > "$state"; done
# What only the build needed: npm's download cache and apt's package lists (apt update fetches them again).
rm -rf /root/.npm /var/lib/apt/lists/*
if [ "$ARCH" = arm64 ]; then echo "Base ready ($ARCH): $(node --version), $(codex --version | head -1), Wi-Fi country $COUNTRY."
else echo "Base ready ($ARCH): Wi-Fi country $COUNTRY."; fi
