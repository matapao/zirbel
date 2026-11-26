"""When the box sets itself up: decisions alone, without hardware, so they are tested.

The setup service runs only while it is needed. It starts at boot, when the network goes away (a NetworkManager
dispatcher script), and when the person asks the editor to change the Wi-Fi (a request file a path unit watches). It
waits a grace period for a network, opens its setup hotspot when there is none, and exits as soon as there is one:
nothing of it stays running on a box that is set up.
"""

from __future__ import annotations

from pathlib import Path

GRACE_SECONDS = 60.0
# While in setup because no network could be joined, the saved ones are tried again this often, when no one is using
# the setup meanwhile; trying needs the radio, so the hotspot goes down for that long.
RETRY_SECONDS = 300.0
RETRY_FOR_SECONDS = 45.0
IDLE_SECONDS = 120.0
ABANDONED_SECONDS = 900.0


def needed(*, online: bool, offline_for: float, requested: bool, grace: float = GRACE_SECONDS) -> bool:
    """Whether to set up: when the person asked, or when the box has been without a network for the grace period."""
    return requested or (not online and offline_for >= grace)


def finished(*, online: bool, requested: bool, provisioned: bool) -> bool:
    """Whether setup is over: a network was joined or the box's own Wi-Fi made, or a network came back that the person
    did not ask to change."""
    return provisioned or (online and not requested)


def abandoned(*, requested: bool, since_use: float) -> bool:
    """Whether the person asked to change the Wi-Fi and then left it: the box goes back to the network it had."""
    return requested and since_use >= ABANDONED_SECONDS


def retry_saved(*, saved: bool, requested: bool, since_retry: float, since_use: float) -> bool:
    """Whether to try the saved networks again: only for a box that lost its network, not one asked to change it."""
    return saved and not requested and since_retry >= RETRY_SECONDS and since_use >= IDLE_SECONDS


def has_wifi(sys_root: Path = Path("/sys")) -> bool:
    """Whether the box has a Wi-Fi radio. Without one there is nothing to set up: the box is set up over Ethernet."""
    return any((sys_root / "class" / "ieee80211").glob("*"))


# A box that keeps joining a network nobody can reach it on (one that keeps its devices apart, say) is reset from its
# card: an empty file named zirbel-reset-wifi on the boot partition, with or without an extension (a text editor adds
# .txt). At the next boot the box forgets the networks it saved and its own Wi-Fi, and goes straight to setup.
BOOT = Path("/boot/firmware")
RESET_NAME = "zirbel-reset-wifi"


def reset_marker(boot: Path = BOOT) -> Path | None:
    """The reset file on the card's boot partition, if someone left one."""
    try:
        for entry in boot.iterdir():
            if entry.is_file() and entry.name.lower().split(".")[0] == RESET_NAME:
                return entry
    except OSError:
        pass
    return None
