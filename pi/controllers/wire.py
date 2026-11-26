"""The frames between this service and the host, over the host's local socket (its --pads-socket, by default
/run/zirbel-pads/host.sock): each is a u16 length (little-endian), then that many bytes of payload, whose first byte is 0
for a JSON control message (UTF-8, at most 4 KB) or 1 for input (u8 device, then a pad state, layout.py).

This service sends {"type":"device","device":n,"name":…,"standard":bool,"uid":…} when a gamepad appears (uid: who it
is across a reconnect, its Bluetooth address or its USB port's path), {"type":"gone","device":n} when it goes, input
frames, and {"type":"controllers",…} (the box's controllers and its Bluetooth, view.py) when they change and in answer
to every request. The host sends {"type":"rumble","device":n,"duration":ms,"strong":0..1,
"weak":0..1}, and the owner's requests from Box settings: {"type":"scan","on":bool}, {"type":"pair","address":…},
{"type":"forget","address":…}.
"""

from __future__ import annotations

import json
import struct

CONTROL, INPUT = 0, 1
MAX_JSON = 4096
MAX_PAD = 56
MAX_PAYLOAD = 1 + MAX_JSON
LENGTH = struct.Struct("<H")


class FrameError(ValueError):
    """A frame the other side should not have sent: the connection ends."""


def control(message: dict) -> bytes:
    data = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_JSON:
        raise ValueError("A control message is at most 4 KB.")
    return LENGTH.pack(1 + len(data)) + bytes([CONTROL]) + data


def fits(message: dict) -> bool:
    return len(json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= MAX_JSON


def pad_input(device: int, state: bytes) -> bytes:
    if not 0 <= device <= 15 or len(state) > MAX_PAD:
        raise ValueError("Not an input frame.")
    return LENGTH.pack(2 + len(state)) + bytes([INPUT, device]) + state


class Reader:
    """Frames out of a byte stream, as they arrive in pieces: each JSON control message as a dict, and input frames as
    (device, pad state) pairs."""

    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data: bytes) -> list[dict | tuple[int, bytes]]:
        self.buffer += data
        frames: list[dict | tuple[int, bytes]] = []
        while len(self.buffer) >= LENGTH.size:
            (length,) = LENGTH.unpack_from(self.buffer)
            if not 1 <= length <= MAX_PAYLOAD:
                raise FrameError("A frame of the wrong length.")
            if len(self.buffer) < LENGTH.size + length:
                break
            payload = bytes(self.buffer[LENGTH.size:LENGTH.size + length])
            del self.buffer[:LENGTH.size + length]
            frames.append(self._payload(payload))
        return frames

    @staticmethod
    def _payload(payload: bytes) -> dict | tuple[int, bytes]:
        if payload[0] == CONTROL:
            try:
                message = json.loads(payload[1:].decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as error:
                raise FrameError("A control message that isn't JSON.") from error
            if not isinstance(message, dict):
                raise FrameError("A control message that isn't an object.")
            return message
        if payload[0] == INPUT and 2 <= len(payload) <= 2 + MAX_PAD:
            return payload[1], payload[2:]
        raise FrameError("A frame of an unknown kind.")
