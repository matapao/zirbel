"""What the setup service asks the box's own editor, over loopback: a pairing link for the device being set up, whether
the person asked to change the Wi-Fi, and whether the box makes its own (own_network.py).

The editor's "Change Wi-Fi" sets its setupRequested, and a request file in /run/zirbel-setup starts this service (a path
unit watches it); when setup is over the service removes the file and clears the editor's setting. Switching the box's
own Wi-Fi sets the editor's ownNetwork and leaves another file there (network_wake), which starts this service too; the
service removes it, then makes the Wi-Fi follow the setting. Setup changes the setting itself as it changes the Wi-Fi.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from portal import Pairing, at  # noqa: F401 - at is the setup's too

EDITOR = os.environ.get("ZIRBEL_EDITOR_URL", "http://127.0.0.1").rstrip("/")
REQUEST = Path(os.environ.get("ZIRBEL_SETUP_REQUEST", "/run/zirbel-setup/request"))
# Loopback is not behind a proxy, whatever the environment says.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
REPLY_BYTES = 64 * 1024


def _call(method: str, path: str, payload: object | None = None, timeout: float = 5.0) -> object:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(EDITOR + path, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with _OPENER.open(request, timeout=timeout) as response:
        return json.loads(response.read(REPLY_BYTES) or b"null")


def pairing(attempts: int = 10) -> Pairing | None:
    """A pairing link from the editor; the editor may still be starting, so this waits for it a little. While no device
    has paired with the box, the link is its pairing page alone, where the device claims the box with no code."""
    for attempt in range(attempts):
        try:
            reply = _call("POST", "/api/pairing", {})
            if isinstance(reply, dict) and isinstance(reply.get("code"), str) and isinstance(reply.get("url"), str):
                url = reply["url"]
                if url.startswith(("http://", "https://")):
                    claim = _claimable()
                    return Pairing(code=reply["code"][:32], url=(url.split("?", 1)[0] if claim else url)[:500], claim=claim)
            return None
        except (OSError, ValueError):
            if attempt + 1 < attempts:
                time.sleep(3)
    return None


def _claimable() -> bool:
    try:
        status = _call("GET", "/api/box/status", timeout=3.0)
    except (OSError, ValueError):
        return False
    return bool(isinstance(status, dict) and status.get("claimable") is True)


def _settings() -> dict | None:
    """The editor's switches, from its status, or None when it doesn't answer."""
    try:
        status = _call("GET", "/api/box/status", timeout=3.0)
    except (OSError, ValueError):
        return None
    settings = status.get("settings") if isinstance(status, dict) else None
    return settings if isinstance(settings, dict) else None


def requested() -> bool:
    """Whether the person asked to change the Wi-Fi: the request file, or the editor's setting for it."""
    if REQUEST.exists():
        return True
    settings = _settings()
    return bool(settings and settings.get("setupRequested") is True)


def network_wake() -> Path:
    """The file the editor leaves when its ownNetwork setting changes, beside the request file."""
    return REQUEST.with_name("network")


def own_network() -> bool | None:
    """Whether the box makes its own Wi-Fi, by the editor's setting: None when the editor doesn't say."""
    value = (_settings() or {}).get("ownNetwork")
    return value if isinstance(value, bool) else None


def set_own_network(on: bool, attempts: int = 3) -> bool:
    """Sets the editor's ownNetwork, as setup changes the Wi-Fi: whether the editor took it. One that is restarting is
    asked again; one that refuses is not."""
    for attempt in range(attempts):
        try:
            reply = _call("PUT", "/api/box/settings", {"ownNetwork": on})
            return isinstance(reply, dict) and reply.get("ownNetwork") is on
        except urllib.error.HTTPError as error:
            error.close()
            return False
        except (OSError, ValueError):
            if attempt + 1 < attempts:
                time.sleep(2)
    return False


def clear_network_wake() -> None:
    try:
        network_wake().unlink()
    except FileNotFoundError:
        pass


def clear_request() -> None:
    """Setup is over: the request goes, from the file and from the editor's settings."""
    try:
        REQUEST.unlink()
    except FileNotFoundError:
        pass
    try:
        _call("POST", "/api/box/setup", {"requested": False}, timeout=3.0)  # only loopback may clear it
    except (OSError, ValueError):
        pass  # an editor that is not running has nothing to clear
