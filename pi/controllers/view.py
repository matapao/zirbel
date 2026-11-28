"""The box's controllers as Box settings lists them, in the service's {"type":"controllers"} message: every controller
on the box now (USB, Bluetooth or other, by its device number) and every paired Bluetooth controller, connected or not,
as one list (a Bluetooth gamepad is matched to its device by its address); the Bluetooth gamepads found while looking;
whether the box is looking, which one it is pairing, and why the last request failed. It fits a control frame (4 KB):
the found ones go first where it would not."""

from __future__ import annotations

import wire

MAX_DEVICES = 32
ERROR_CHARS = 200
NO_BLUETOOTH = "This box has no Bluetooth."


def controllers(pads: list[dict], bluetooth: dict | None, error: str | None = None) -> dict:
    bt = bluetooth or {"bluetooth": False, "scanning": False, "pairing": None, "error": None, "paired": [], "found": []}
    by_address = {pad["address"]: pad for pad in pads if pad.get("address")}
    unplugged = []
    for item in bt["paired"]:
        if item["address"] not in by_address:
            unplugged.append(
                {"name": item["name"], "kind": "bluetooth", "connected": item["connected"], "address": item["address"]}
            )
    devices = []
    for pad in sorted(pads, key=lambda item: item["device"]):
        entry = {"name": pad["name"], "kind": pad["kind"], "connected": True, "device": pad["device"]}
        if pad.get("address"):
            entry["address"] = pad["address"]
        devices.append(entry)
    devices += sorted(unplugged, key=lambda item: item["name"].lower())
    listed = {entry.get("address") for entry in devices}
    reason = error or bt["error"]
    message = {
        "type": "controllers",
        "devices": devices[:MAX_DEVICES],
        "found": [item for item in bt["found"] if item["address"] not in listed],
        "scanning": bool(bt["scanning"]),
        "bluetooth": bool(bt["bluetooth"]),
        "pairing": bt["pairing"],
        "error": reason[:ERROR_CHARS] if reason else None,
    }
    while not wire.fits(message) and message["found"]:
        message["found"].pop()
    while not wire.fits(message) and message["devices"]:
        message["devices"].pop()
    return message
