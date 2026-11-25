#!/bin/bash
# Writes a Zirbel box image to a card or stick on a Mac and, when you give one, the Wi-Fi it joins on its first boot;
# without one, the box's own setup takes it later (over Bluetooth, or its setup hotspot). Run it in Terminal: macOS
# lets only an app with access to removable volumes write a card. It erases only the disk you type, and only one of
# the removable disks it lists.
#   pi/write-card.sh IMAGE [COUNTRY]
set -euo pipefail
IMAGE=${1:?Usage: pi/write-card.sh IMAGE [COUNTRY]}
COUNTRY=${2:-}
[ -f "$IMAGE" ] || { echo "No image at $IMAGE." >&2; exit 1; }

# Cards and sticks: external and removable, never this Mac's own disks.
cards=()
for disk in $(diskutil list external physical | awk '/^\/dev\/disk/ { print $1 }'); do
  info=$(diskutil info "$disk")
  grep -q 'Removable Media: *Removable' <<<"$info" || continue
  cards+=("$disk")
  size=$(awk -F': *' '/Disk Size/ { print $2 }' <<<"$info" | cut -d'(' -f1)
  printf '  %s  %s %s\n' "${disk#/dev/}" "$size" "$(awk -F': *' '/Media Name/ { print $2 }' <<<"$info")"
done
[ ${#cards[@]} -gt 0 ] || { echo "No card or stick found. Put one in and try again." >&2; exit 1; }
read -r -p "Type the disk to erase and write (for example ${cards[0]#/dev/}): " chosen
disk=""
for card in "${cards[@]}"; do [ "${card#/dev/}" = "$chosen" ] && disk=$card; done
[ -n "$disk" ] || { echo "$chosen is not one of the disks above. Nothing was written." >&2; exit 1; }

read -r -p "Wi-Fi for the box (leave empty to set it up later over Bluetooth or the setup hotspot): " ssid
password=""
if [ -n "$ssid" ]; then
  read -r -s -p "Its password (not shown): " password
  echo
  [ -n "$COUNTRY" ] || read -r -p "Wi-Fi country, two letters (for example NO): " COUNTRY
  [[ $COUNTRY =~ ^[A-Z]{2}$ ]] || { echo "The country must be two capital letters. Nothing was written." >&2; exit 1; }
fi

diskutil unmountDisk "$disk" >/dev/null
echo "Writing $(basename "$IMAGE") to $disk. sudo asks for this Mac's password."
sudo dd if="$IMAGE" of="/dev/r${disk#/dev/}" bs=4m status=progress
sync

if [ -n "$ssid" ]; then
  diskutil mountDisk "$disk" >/dev/null
  boot=$(diskutil info "${disk}s1" | awk -F': *' '/Mount Point/ { print $2 }')
  [ -d "$boot" ] || { echo "The card's boot partition didn't mount, so the Wi-Fi isn't on it." >&2; exit 1; }
  # YAML's double-quoted strings: the name and password reach cloud-init exactly as typed.
  quote() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
  umask 077
  cat >"$boot/network-config" <<EOF
# The Wi-Fi this box joins on its first boot (netplan v2, as cloud-init takes it). After that boot the box moves this
# file off the boot partition, readable by root alone.
network:
  version: 2
  wifis:
    wlan0:
      dhcp4: true
      dhcp6: true
      regulatory-domain: $COUNTRY
      access-points:
        $(quote "$ssid"):
          password: $(quote "$password")
      optional: true
EOF
  sync
  echo "The box joins $ssid on its first boot."
fi
diskutil eject "$disk" >/dev/null
echo "Done. Put the card in the Pi and power it on; after a minute or two it is at http://zirbel.local."
