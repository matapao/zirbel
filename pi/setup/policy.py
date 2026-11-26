"""When the box sets itself up, and how its radios share the work: decisions alone, without hardware, so they are tested.

The setup service runs only while it is needed. It starts at boot, when the network goes away (a NetworkManager
dispatcher script), and when the person asks the editor to change the Wi-Fi (a request file a path unit watches). It
waits a grace period for a network, sets the box up when there is none, and exits as soon as there is one: nothing of it
stays running on a box that is set up.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

GRACE_SECONDS = 60.0
# While in setup because no network could be joined, the saved ones are tried again this often, when no one is using
# the setup meanwhile; trying needs the radio, so the hotspot goes down for that long.
RETRY_SECONDS = 300.0
RETRY_FOR_SECONDS = 45.0
IDLE_SECONDS = 120.0
ABANDONED_SECONDS = 900.0
# Where the radio can't serve the hotspot while Bluetooth advertises, the hotspot comes once Bluetooth has been quiet this
# long.
HOTSPOT_AFTER_SECONDS = 120.0

TOGETHER = "together"
BLUETOOTH_FIRST = "bluetooth-first"


@dataclass
class Radios:
    """The box's radios: whether it has Wi-Fi and Bluetooth, and whether the two can serve setup at the same time."""

    wifi: bool
    bluetooth: bool
    sharing: str = TOGETHER


# For this long after power-on a box with a network still takes a new one over Bluetooth (never the hotspot then).
AFTER_BOOT_SECONDS = 10 * 60


def needed(*, online: bool, offline_for: float, requested: bool, grace: float = GRACE_SECONDS) -> bool:
    """Whether to set up: when the person asked, or when the box has been without a network for the grace period."""
    return requested or (not online and offline_for >= grace)


def after_boot(uptime: float) -> bool:
    """Whether the box is in the minutes after power-on in which it takes a new network over Bluetooth even with one:
    the way to move a box that is set up somewhere else, with no screen, card or SSH."""
    return uptime < AFTER_BOOT_SECONDS


def finished(*, online: bool, requested: bool, provisioned: bool, after_boot: bool = False) -> bool:
    """Whether setup is over: Wi-Fi was given and joined, or a network came back that the person did not ask to change
    and the minutes after power-on are over."""
    return provisioned or (online and not requested and not after_boot)


def abandoned(*, requested: bool, since_use: float) -> bool:
    """Whether the person asked to change the Wi-Fi and then left it: the box goes back to the network it had."""
    return requested and since_use >= ABANDONED_SECONDS


def retry_saved(*, saved: bool, requested: bool, since_retry: float, since_use: float) -> bool:
    """Whether to try the saved networks again: only for a box that lost its network, not one asked to change it."""
    return saved and not requested and since_retry >= RETRY_SECONDS and since_use >= IDLE_SECONDS


def hotspot_due(radios: Radios, *, quiet_for: float) -> bool:
    """Whether the hotspot runs now: with Bluetooth where the radio shares, else once Bluetooth has been quiet a while.

    quiet_for: how long since setup started or a Bluetooth client last did something, whichever is later.
    """
    if not radios.bluetooth or radios.sharing == TOGETHER:
        return True
    return quiet_for >= HOTSPOT_AFTER_SECONDS


def sharing(model: str, wifi_bus: str, bluetooth_bus: str) -> str:
    """How Wi-Fi and Bluetooth share for setup, by the board and where each radio sits.

    The Pi 3 B and Zero 2 W carry the older CYW43438, one chip for both radios, which is not relied on to serve an access
    point while advertising over Bluetooth: Bluetooth comes first there. The newer CYW43455 and CYW43456 (Pi 3 B+ and A+,
    4, 400, 5 and the compute modules) are taken to do both. A USB adapter is a radio of its own, which shares with
    nothing. These are assumptions to be checked on each board; ZIRBEL_SETUP_RADIOS overrides them.
    """
    override = os.environ.get("ZIRBEL_SETUP_RADIOS", "")
    if override in (TOGETHER, BLUETOOTH_FIRST):
        return override
    if wifi_bus == "usb" or bluetooth_bus == "usb":
        return TOGETHER
    older = ("Raspberry Pi 3 Model B Rev", "Raspberry Pi Zero 2")
    return BLUETOOTH_FIRST if model.startswith(older) else TOGETHER


def _bus(device: Path) -> str:
    """The bus a radio sits on: usb for an adapter anywhere under a USB port, else its subsystem (sdio, serial...)."""
    try:
        if "/usb" in str(device.resolve()):
            return "usb"
        return (device / "subsystem").resolve().name
    except OSError:
        return ""


def _model(model_file: Path) -> str:
    try:
        return model_file.read_bytes().rstrip(b"\0").decode("utf-8", errors="replace")
    except OSError:
        return ""


def detect(sys_root: Path = Path("/sys"), model_file: Path = Path("/proc/device-tree/model")) -> Radios:
    """The radios this box has. Without a Wi-Fi radio there is nothing to set up: the box is set up over Ethernet."""
    phys = sorted((sys_root / "class" / "ieee80211").glob("*"))
    controllers = sorted((sys_root / "class" / "bluetooth").glob("hci*"))
    wifi_bus = _bus(phys[0] / "device") if phys else ""
    bluetooth_bus = _bus(controllers[0] / "device") if controllers else ""
    return Radios(wifi=bool(phys), bluetooth=bool(controllers), sharing=sharing(_model(model_file), wifi_bus, bluetooth_bus))


def model_name(model_file: Path = Path("/proc/device-tree/model")) -> str:
    return _model(model_file) or "Raspberry Pi"


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
