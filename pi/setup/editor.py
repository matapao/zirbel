"""What the setup service asks the box's own editor, over loopback: a pairing link for the device being set up, and
whether the person asked to change the Wi-Fi.

The editor's "Change Wi-Fi" sets its setupRequested, and a request file in /run/zirbel-setup starts this service (a path
unit watches it); when setup is over the service removes the file and clears the editor's setting.
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

from portal import Pairing

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


def at(url: str, address: str | None) -> str:
    """The link at the box's own address on the network, which every device can open, where the box knows it."""
    if not address:
        return url
    parts = urllib.parse.urlsplit(url)
    host = f"[{address}]" if ":" in address else address
    return urllib.parse.urlunsplit(parts._replace(netloc=host + (f":{parts.port}" if parts.port else "")))


def requested() -> bool:
    """Whether the person asked to change the Wi-Fi: the request file, or the editor's setting for it."""
    if REQUEST.exists():
        return True
    try:
        status = _call("GET", "/api/box/status", timeout=3.0)
    except (OSError, ValueError):
        return False
    settings = status.get("settings") if isinstance(status, dict) else None
    return bool(isinstance(settings, dict) and settings.get("setupRequested") is True)


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
