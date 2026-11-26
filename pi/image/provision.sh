#!/bin/bash
# Runs in a privileged Debian container on an arm64 host (build.mjs starts it): grows a Raspberry Pi OS image to SIZE,
# mounts its two partitions and runs a stage's script in a chroot of its root file system (natively for an arm64
# image, through Docker's emulation for an armhf one). The app stage, the last, then shrinks the image to what it holds
# and a little room: first boot grows it to the card (cmdline.txt's resize), so the image stays as small to write as it
# can be.
#   provision.sh IMAGE SIZE STAGE [ARG...]   STAGE is base or app (chroot-base.sh, chroot-app.sh)
set -euo pipefail
IMAGE=$1 SIZE=$2 STAGE=$3
shift 3
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=/mnt/root

apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends parted e2fsprogs fdisk >/dev/null

# The root partition grows into the image's new end. First boot still grows it to the card (cmdline.txt's resize).
if [ "$(stat -c %s "$IMAGE")" -lt "$(numfmt --from=iec "$SIZE")" ]; then
  truncate -s "$SIZE" "$IMAGE"
  parted -s "$IMAGE" resizepart 2 100%
fi
part() { sfdisk --dump "$IMAGE" | awk -v n="$IMAGE$1" '$1 == n { gsub(/[^0-9]/, "", $4); gsub(/[^0-9]/, "", $6); print $4, $6 }'; }
read -r BOOT_START BOOT_SECTORS < <(part 1)
read -r ROOT_START ROOT_SECTORS < <(part 2)
BOOT=$(losetup --find --show --offset $((BOOT_START * 512)) --sizelimit $((BOOT_SECTORS * 512)) "$IMAGE")
DISK=$(losetup --find --show --offset $((ROOT_START * 512)) --sizelimit $((ROOT_SECTORS * 512)) "$IMAGE")
cleanup() {
  set +e
  for mount in dev/pts dev proc sys boot/firmware ""; do mountpoint -q "$ROOT/$mount" && umount "$ROOT/$mount"; done
  losetup -d "$BOOT" "$DISK"
}
trap cleanup EXIT
e2fsck -fy "$DISK" >/dev/null || [ $? -le 1 ]
resize2fs "$DISK" >/dev/null 2>&1

mkdir -p "$ROOT"
mount "$DISK" "$ROOT"
mount "$BOOT" "$ROOT/boot/firmware"
mount --bind /dev "$ROOT/dev"
mount --bind /dev/pts "$ROOT/dev/pts"
mount -t proc proc "$ROOT/proc"
mount -t sysfs sys "$ROOT/sys"

# The chroot resolves names through the container's resolver while it runs; the image's own comes back after.
RESOLV="$ROOT/etc/resolv.conf"
[ -e "$RESOLV" ] || [ -L "$RESOLV" ] && mv "$RESOLV" "$RESOLV.zirbel-build"
cp /etc/resolv.conf "$RESOLV"
# Packages installed in the chroot start no services in it.
printf '#!/bin/sh\nexit 101\n' > "$ROOT/usr/sbin/policy-rc.d"
chmod 755 "$ROOT/usr/sbin/policy-rc.d"

WORK="$ROOT/tmp/zirbel-build"
rm -rf "$WORK" && mkdir -p "$WORK"
cp -R "$HERE/." "$WORK/"
[ -f /key.pub ] && cp /key.pub "$WORK/key.pub"
[ -d /editor ] && cp -R /editor "$WORK/editor"
[ -f /zirbel-host ] && cp /zirbel-host "$WORK/zirbel-host"
[ -d /setup ] && cp -R /setup "$WORK/setup"
[ -d /tv ] && cp -R /tv "$WORK/tv"
[ -d /games ] && cp -R /games "$WORK/games"
status=0
chroot "$ROOT" /bin/bash "/tmp/zirbel-build/chroot-$STAGE.sh" "$@" || status=$?

rm -rf "$WORK" "$ROOT/usr/sbin/policy-rc.d"
rm -f "$RESOLV"
[ -e "$RESOLV.zirbel-build" ] || [ -L "$RESOLV.zirbel-build" ] && mv "$RESOLV.zirbel-build" "$RESOLV"
[ $status -eq 0 ] && [ "$STAGE" = app ] || exit $status

# The root file system to its smallest and 512 MB of room, its partition to the file system, the image to the partition.
for mount in dev/pts dev proc sys boot/firmware ""; do mountpoint -q "$ROOT/$mount" && umount "$ROOT/$mount"; done
e2fsck -fy "$DISK" >/dev/null || [ $? -le 1 ]
resize2fs -M "$DISK" >/dev/null 2>&1
blocks() { dumpe2fs -h "$DISK" 2>/dev/null | awk -F': *' -v f="$1" '$1 == f { print $2 }'; }
SECTORS=$(( ($(blocks 'Block count') * $(blocks 'Block size') + 512 * 1024 * 1024) / 512 ))
SECTORS=$(( (SECTORS + 2047) / 2048 * 2048 ))
resize2fs "$DISK" "${SECTORS}s" >/dev/null 2>&1
losetup -d "$BOOT" "$DISK"
trap - EXIT
echo "start=$ROOT_START, size=$SECTORS" | sfdisk --no-reread --no-tell-kernel -N 2 "$IMAGE" >/dev/null
truncate -s $(( (ROOT_START + SECTORS) * 512 )) "$IMAGE"
sfdisk --dump "$IMAGE" | grep "^$IMAGE"
echo "Image: $(( (ROOT_START + SECTORS) * 512 / 1024 / 1024 )) MiB, its root file system grows to the card on first boot."
