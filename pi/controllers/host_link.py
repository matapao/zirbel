"""The service's connection to the host's local socket (wire.py): opened when the host listens, and again after the
host restarts. A host that stops reading is let go, and connected to again: what it missed comes with the next
connection, which hears of every device again."""

from __future__ import annotations

import os
import socket
from typing import Callable

import wire

SOCKET = os.environ.get("ZIRBEL_PADS_SOCKET", "/run/zirbel-pads/host.sock")
SEND_SECONDS = 0.5


class HostLink:
    def __init__(self, path: str, opened: Callable[[], None], message: Callable[[dict], None],
                 closed: Callable[[], None] = lambda: None, log: Callable[[str], None] = lambda text: print(text, flush=True)):
        self.path, self.opened, self.message, self.closed, self.log = path, opened, message, closed, log
        self.sock: socket.socket | None = None
        self.reader = wire.Reader()
        # Why the last connection failed, said once until it changes.
        self.failure = ""

    @property
    def connected(self) -> bool:
        return self.sock is not None

    def open(self) -> bool:
        """Connects, unless connected already; whether it is connected now."""
        if self.sock:
            return True
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(SEND_SECONDS)
        try:
            sock.connect(self.path)
        except OSError as error:
            sock.close()
            if error.strerror != self.failure:
                self.failure = error.strerror or str(error)
                self.log(f"The host's socket at {self.path} doesn't answer yet: {self.failure}.")
            return False
        self.sock, self.reader, self.failure = sock, wire.Reader(), ""
        self.log("Connected to the host.")
        self.opened()
        return self.sock is not None

    def send(self, frame: bytes) -> bool:
        if not self.sock:
            return False
        try:
            self.sock.sendall(frame)
            return True
        except OSError:
            self.close()
            return False

    def readable(self) -> bool:
        """Reads what the host sent; False once the connection is over."""
        if not self.sock:
            return False
        try:
            data = self.sock.recv(65536)
        except (BlockingIOError, InterruptedError, TimeoutError):
            return True
        except OSError:
            self.close()
            return False
        if not data:
            self.close()
            return False
        try:
            frames = self.reader.feed(data)
        except wire.FrameError as error:
            self.log(f"The host sent a frame this service can't read ({error}); connecting again.")
            self.close()
            return False
        for frame in frames:
            if isinstance(frame, dict) and self.sock:
                self.message(frame)
        return self.sock is not None

    def close(self) -> None:
        if not self.sock:
            return
        sock, self.sock = self.sock, None
        sock.close()
        self.log("The host's socket closed.")
        self.closed()
