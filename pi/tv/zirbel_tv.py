"""The box's TV console follows its display and the editor's TV switch (AGENTS.md).

zirbel-tv.service shows the lobby's TV page on a TV or monitor plugged into the box. This runs as root, as
zirbel-tv-follow.service: at boot, when a display is plugged in or out (a udev rule on the DRM connectors' changes) and
when the editor's "Show the lobby on a TV" switch changes (the editor leaves /run/zirbel-tv/wake, which a path unit
watches). It starts the console when a display is connected and the switch is on, and stops it when there is no
display or the switch is off; while the editor doesn't say (it is starting or restarting), it leaves the console as it
is. It asks the editor over loopback as the setup service does (pi/setup/editor.py): as root, its request is the box's
own.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Callable

EDITOR = os.environ.get("ZIRBEL_EDITOR_URL", "http://127.0.0.1").rstrip("/")
WAKE = Path(os.environ.get("ZIRBEL_TV_WAKE", "/run/zirbel-tv/wake"))
DRM = Path("/sys/class/drm")
UNIT = "zirbel-tv.service"
# Loopback is not behind a proxy, whatever the environment says.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
REPLY_BYTES = 64 * 1024


def displays(drm: Path = DRM) -> list[str]:
    """The display connectors with something plugged in (card1-HDMI-A-1 and the like), by their status in sysfs. A
    writeback connector is no display."""
    found = []
    for status in sorted(drm.glob("card*-*/status")):
        name = status.parent.name
        if "-Writeback-" in name:
            continue
        try:
            if status.read_text(encoding="ascii").strip() == "connected":
                found.append(name)
        except OSError:
            continue
    return found


def _status(timeout: float = 3.0) -> object:
    with _OPENER.open(EDITOR + "/api/box/status", timeout=timeout) as response:
        return json.loads(response.read(REPLY_BYTES) or b"null")


def switch(
    attempts: int = 1, wait: float = 3.0, ask: Callable[[], object] = _status, sleep: Callable[[float], None] = time.sleep
) -> bool | None:
    """The editor's TV switch, from its status, or None while it doesn't answer (asked attempts times, wait apart)."""
    for attempt in range(attempts):
        try:
            status = ask()
        except (OSError, ValueError):
            status = None
        settings = status.get("settings") if isinstance(status, dict) else None
        value = settings.get("tv") if isinstance(settings, dict) else None
        if isinstance(value, bool):
            return value
        if attempt + 1 < attempts:
            sleep(wait)
    return None


def decide(connected: bool, on: bool | None) -> str | None:
    """What the console does: start with a display and the switch on, stop with no display or the switch off, and
    nothing while the switch is unknown and a display is there."""
    if not connected or on is False:
        return "stop"
    return "start" if on else None


def follow(
    drm: Path = DRM,
    wake: Path = WAKE,
    attempts: int = 1,
    ask: Callable[[], object] = _status,
    run: Callable[[list[str]], object] = lambda command: subprocess.run(command, check=False),
    sleep: Callable[[float], None] = time.sleep,
) -> str | None:
    """Follows once: the wake file goes, then the console starts or stops. What it did, if anything."""
    try:
        wake.unlink()
    except FileNotFoundError:
        pass
    connected = bool(displays(drm))
    # With no display there is nothing to ask the editor.
    action = decide(connected, switch(attempts, ask=ask, sleep=sleep) if connected else None)
    if action:
        run(["systemctl", "--no-block", action, UNIT])
    return action


def main() -> int:
    # The editor may be starting (at boot) or restarting: it is asked for a minute.
    action = follow(attempts=20)
    print("TV console: " + (action or "left as it is (the editor doesn't say whether to show it)"), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
