#!/bin/bash
# Runs in a privileged Debian container on an arm64 host (build.mjs starts it): grows a Raspberry Pi OS image to SIZE,
# mounts its two partitions and runs a stage's script in a chroot of its root file system, natively, with no emulation.
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
[ -d /setup ] && cp -R /setup "$WORK/setup"
status=0
chroot "$ROOT" /bin/bash "/tmp/zirbel-build/chroot-$STAGE.sh" "$@" || status=$?

rm -rf "$WORK" "$ROOT/usr/sbin/policy-rc.d"
rm -f "$RESOLV"
[ -e "$RESOLV.zirbel-build" ] || [ -L "$RESOLV.zirbel-build" ] && mv "$RESOLV.zirbel-build" "$RESOLV"
exit $status
