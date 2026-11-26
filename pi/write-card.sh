#!/bin/bash
# Writes a Zirbel box image to a card or stick on a Mac. The box comes online through its own Wi-Fi: the person setting
# it up joins "Zirbel setup XXXX", then picks a network or keeps the box on its own Wi-Fi. Run it in Terminal: macOS
# lets only an app with access to removable volumes write a card. It erases only the disk you type, and only one of the
# removable disks it lists.
#   pi/write-card.sh IMAGE
set -euo pipefail
IMAGE=${1:?Usage: pi/write-card.sh IMAGE}
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

diskutil unmountDisk "$disk" >/dev/null
echo "Writing $(basename "$IMAGE") to $disk. sudo asks for this Mac's password."
sudo dd if="$IMAGE" of="/dev/r${disk#/dev/}" bs=4m status=progress
sync

diskutil eject "$disk" >/dev/null
echo "Done. Put the card in the Pi and power it on. In a minute or two, join the Wi-Fi \"Zirbel setup XXXX\" on a phone"
echo "or computer: its page opens, to pick the network the box joins or keep the box on its own Wi-Fi."
