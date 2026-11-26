"""The box's own Wi-Fi: instead of joining a network, the box makes one with a password, which phones, tablets and
computers join to play, with no router and no internet.

Its name and password are made once and kept in a state file outside the editor's data folder (STATE): root's, and
readable by the editor's group and no one else, so the editor shows them to its paired devices. The editor's ownNetwork
setting says whether the box makes it. This service is the only thing that changes the Wi-Fi: whenever it runs, the Wi-Fi
follows the setting (apply), and the editor wakes it when the setting changes. NetworkManager keeps the network as a
saved connection that comes back after a reboot, before any network the box joined.

This module has no D-Bus code (network.py holds it), so it runs and is tested anywhere.
"""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

STATE = Path(os.environ.get("ZIRBEL_OWN_NETWORK", "/var/lib/zirbel-setup/own-network.json"))
# Lower-case letters and digits without the ones read as others (0 and o, 1, i and l): typed on a phone without its shift
# key, and read aloud four at a time.
ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"
GROUPS = 3
GROUP = 4
STATE_BYTES = 4096

# What apply did: made the network, took it away, nothing, or failed to make it.
UP = "up"
DOWN = "down"
KEEP = ""
FAILED = "failed"


@dataclass(frozen=True)
class Credentials:
    """The network's name and its WPA2 password."""

    name: str
    password: str


def new_password() -> str:
    """Twelve characters in three groups, as 4k7m-q2xd-9fht: about 59 bits, and what is shown is what is typed."""
    return "-".join("".join(secrets.choice(ALPHABET) for _ in range(GROUP)) for _ in range(GROUPS))


def _checked(values: object) -> Credentials | None:
    """The state file's contents, if they are what a network takes: a name of up to 32 bytes, and a WPA2 passphrase of 8
    to 63 printable ASCII characters."""
    if not isinstance(values, dict) or set(values) != {"version", "name", "password"} or values["version"] != 1:
        return None
    name, password = values["name"], values["password"]
    if not isinstance(name, str) or not 1 <= len(name.encode("utf-8")) <= 32:
        return None
    if not isinstance(password, str) or not 8 <= len(password) <= 63 or not all(" " <= c <= "~" for c in password):
        return None
    return Credentials(name, password)


def read(path: Path | None = None) -> Credentials | None:
    """The network's name and password, as kept, or None when there are none (or none that a network takes)."""
    try:
        with (path or STATE).open("rb") as file:
            data = file.read(STATE_BYTES + 1)
        return _checked(json.loads(data)) if len(data) <= STATE_BYTES else None
    except (OSError, ValueError):
        return None


def credentials(suffix: str, path: Path | None = None) -> Credentials:
    """The network's name and password: made the first time, the same ever after. The name is the box's, as its setup
    hotspot's: "Zirbel " and the end of its address. Raises OSError when they can't be kept."""
    path = path or STATE
    kept = read(path)
    if kept:
        return kept
    made = Credentials(f"Zirbel {suffix}", new_password())
    _write(path, made)
    return made


def _write(path: Path, made: Credentials) -> None:
    """Written beside the file and moved over it, so that the editor never reads half of one; mode 0640, in a folder whose
    group (zirbel, setgid: zirbel-setup.tmpfiles) each new file takes."""
    partial = path.with_name(f".{path.name}.partial")
    descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o640)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump({"version": 1, "name": made.name, "password": made.password}, file)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(partial, 0o640)  # whatever the umask took away
        os.replace(partial, path)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def action(*, wanted: bool | None, exists: bool, active: bool) -> str:
    """What the Wi-Fi needs for the editor's setting: the network made (or brought back), taken away, or nothing. An
    editor that doesn't answer (None) changes nothing: what NetworkManager has saved stays as it is."""
    if wanted is None:
        return KEEP
    if wanted:
        return KEEP if exists and active else UP
    return DOWN if exists else KEEP


def apply(nm, wanted: bool | None, made: Credentials | None, before_up: Callable[[], None] = lambda: None) -> str:
    """Makes the Wi-Fi follow the setting, through nm (network.NetworkManager): what it did. before_up runs just before
    the network is made, to let the radio go (the setup hotspot). A network that doesn't start is taken away again; the
    setting stays, so the next time this runs it is tried again."""
    step = action(wanted=wanted, exists=nm.own_network_exists(), active=nm.own_network_active())
    if step == UP:
        if made is None:
            return FAILED  # no name and password could be kept
        before_up()
        if nm.own_network_up(made.name, made.password):
            return UP
        nm.own_network_down()
        return FAILED
    if step == DOWN:
        nm.own_network_down()
    return step
