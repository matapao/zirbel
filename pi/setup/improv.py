"""The Improv Wi-Fi protocol over Bluetooth LE (https://www.improv-wifi.com/ble/, version 2.4), as the box serves it.

This module holds the protocol alone: packets, their checksum, and the service's states, errors and results. It has no
Bluetooth or network code, so it runs and is tested anywhere; bluetooth.py serves it over BlueZ, and the setup service
(zirbel_setup.py) does what a command asks for and reports back.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable

SERVICE = "00467768-6228-2272-4663-277478268000"
CURRENT_STATE = "00467768-6228-2272-4663-277478268001"
ERROR_STATE = "00467768-6228-2272-4663-277478268002"
RPC_COMMAND = "00467768-6228-2272-4663-277478268003"
RPC_RESULT = "00467768-6228-2272-4663-277478268004"
CAPABILITIES = "00467768-6228-2272-4663-277478268005"
SERVICE_DATA = "00004677-0000-1000-8000-00805f9b34fb"

# Current state.
AUTHORIZATION_REQUIRED = 0x01
AUTHORIZED = 0x02
PROVISIONING = 0x03
PROVISIONED = 0x04

# Error state.
NO_ERROR = 0x00
INVALID_RPC = 0x01
UNKNOWN_RPC = 0x02
UNABLE_TO_CONNECT = 0x03
NOT_AUTHORIZED = 0x04
BAD_HOSTNAME = 0x05
UNKNOWN_ERROR = 0xFF

# RPC commands.
WIFI_SETTINGS = 0x01
IDENTIFY = 0x02
DEVICE_INFO = 0x03
SCAN = 0x04

# Capabilities, a bit each.
CAN_IDENTIFY = 0x01
CAN_DEVICE_INFO = 0x02
CAN_SCAN = 0x04

MAX_DATA = 255
SSID_BYTES = 32
PASSWORD_BYTES = 64
# A packet whose parts stop coming is dropped: the next write starts a new one.
PARTIAL_PACKET_SECONDS = 3.0


class InvalidPacket(ValueError):
    """A packet that is malformed: a wrong checksum, a wrong length, or fields that don't add up."""


def checksum(data: bytes) -> int:
    """The protocol's checksum: the sum of the bytes, keeping only the lowest byte."""
    return sum(data) & 0xFF


def packet(command: int, data: bytes = b"") -> bytes:
    """An RPC packet: its command, its data's length, the data, and the checksum of all before it."""
    if len(data) > MAX_DATA:
        raise ValueError("An Improv packet holds at most 255 bytes of data.")
    head = bytes([command, len(data)]) + data
    return head + bytes([checksum(head)])


def strings(values: list[str]) -> bytes:
    """A result's list of strings, each its UTF-8 bytes after their length."""
    out = bytearray()
    for value in values:
        encoded = value.encode("utf-8")
        if len(encoded) > MAX_DATA:
            raise ValueError("An Improv string holds at most 255 bytes.")
        out += bytes([len(encoded)]) + encoded
    return bytes(out)


def result(command: int, values: list[str]) -> bytes:
    """An RPC result packet with its list of strings."""
    return packet(command, strings(values))


def wifi_settings(data: bytes) -> tuple[bytes, bytes]:
    """The SSID and password a "Send Wi-Fi settings" command carries."""
    if not data:
        raise InvalidPacket("No Wi-Fi settings.")
    ssid_end = 1 + data[0]
    if ssid_end >= len(data):
        raise InvalidPacket("The SSID runs past the data.")
    password_end = ssid_end + 1 + data[ssid_end]
    if password_end != len(data):
        raise InvalidPacket("The password's length does not match the data.")
    ssid, password = data[1:ssid_end], data[ssid_end + 1 : password_end]
    if not 1 <= len(ssid) <= SSID_BYTES or len(password) > PASSWORD_BYTES:
        raise InvalidPacket("An SSID has 1 to 32 bytes and a password at most 64.")
    return ssid, password


class PacketReader:
    """Gathers an RPC command from the writes it comes in: a client splits a packet longer than 20 bytes into several."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._buffer = bytearray()
        self._last = 0.0

    def feed(self, chunk: bytes) -> tuple[int, bytes] | None:
        """The packet's command and data once its last byte has come; None while more is to come."""
        now = self._clock()
        if self._buffer and now - self._last > PARTIAL_PACKET_SECONDS:
            self._buffer.clear()
        self._last = now
        self._buffer += chunk
        if len(self._buffer) < 2:
            return None
        size = 2 + self._buffer[1] + 1
        if len(self._buffer) < size:
            return None
        whole, self._buffer = bytes(self._buffer), bytearray()
        if len(whole) != size:
            raise InvalidPacket("More bytes came than the packet holds.")
        if checksum(whole[:-1]) != whole[-1]:
            raise InvalidPacket("The checksum does not match.")
        return whole[0], whole[2:-1]


@dataclass
class Network:
    """A Wi-Fi network the box sees: its SSID's bytes, its signal in dBm, and its security as Improv names it."""

    ssid: bytes
    rssi: int
    auth: str

    @property
    def name(self) -> str:
        return self.ssid.decode("utf-8", errors="replace")


def scan_result(networks: list[Network]) -> bytes:
    """The scan's result: the strongest networks first, as many as fit in one packet, three strings each."""
    values: list[str] = []
    size = 0
    seen: set[bytes] = set()
    for network in sorted(networks, key=lambda item: item.rssi, reverse=True):
        if network.ssid in seen or not network.ssid:
            continue
        entry = [network.name, str(network.rssi), network.auth]
        entry_size = len(strings(entry))
        if size + entry_size > MAX_DATA:
            break
        seen.add(network.ssid)
        values += entry
        size += entry_size
    return result(SCAN, values)


@dataclass
class DeviceInfo:
    """What the device info command answers: firmware name and version, hardware, device name, OS name and version."""

    firmware: str
    version: str
    hardware: str
    name: str
    os_name: str = ""
    os_version: str = ""

    def values(self) -> list[str]:
        values = [self.firmware, self.version, self.hardware, self.name]
        if self.os_name:
            values += [self.os_name, self.os_version]
        return values


@dataclass
class Service:
    """The Improv service's state: what the client reads and is told of, and what a command asks the box to do.

    The box has no button to press, so the service starts authorized; it runs only while the box needs Wi-Fi. Each
    change calls `changed` with the characteristic it touches, so the Bluetooth side can notify the client.
    """

    info: DeviceInfo
    capabilities: int = CAN_IDENTIFY | CAN_DEVICE_INFO | CAN_SCAN
    state: int = AUTHORIZED
    error: int = NO_ERROR
    last_result: bytes = b""
    changed: Callable[[str], None] = lambda _characteristic: None
    # What a command asks for, done by the setup service, which answers through joined, join_failed and scanned.
    join: Callable[[bytes, bytes], None] = lambda _ssid, _password: None
    identify: Callable[[], None] = lambda: None
    scan: Callable[[], None] = lambda: None
    reader: PacketReader = field(default_factory=PacketReader)

    def service_data(self) -> bytes:
        """The advertisement's service data: the current state and capabilities, then four reserved bytes."""
        return bytes([self.state, self.capabilities, 0, 0, 0, 0])

    def write(self, chunk: bytes) -> None:
        """A write to the RPC command characteristic: a whole packet or part of one."""
        try:
            command = self.reader.feed(chunk)
        except InvalidPacket:
            self._set_error(INVALID_RPC)
            return
        if command is not None:
            self.command(*command)

    def command(self, command: int, data: bytes) -> None:
        if command == WIFI_SETTINGS:
            if self.state == PROVISIONING:
                return  # one join at a time; the client waits for its state
            if self.state != AUTHORIZED:
                self._set_error(NOT_AUTHORIZED)
                return
            try:
                ssid, password = wifi_settings(data)
            except InvalidPacket:
                self._set_error(INVALID_RPC)
                return
            self._set_error(NO_ERROR)
            self._set_state(PROVISIONING)
            self.join(ssid, password)
        elif command == IDENTIFY and self.capabilities & CAN_IDENTIFY:
            self._set_error(NO_ERROR)
            self.identify()
        elif command == DEVICE_INFO and self.capabilities & CAN_DEVICE_INFO:
            self._set_error(NO_ERROR)
            self._set_result(result(DEVICE_INFO, self.info.values()))
        elif command == SCAN and self.capabilities & CAN_SCAN:
            self._set_error(NO_ERROR)
            self.scan()
        else:
            self._set_error(UNKNOWN_RPC)

    def joined(self, url: str) -> None:
        """The box joined the network: provisioned, with the link to finish onboarding."""
        self._set_state(PROVISIONED)
        self._set_result(result(WIFI_SETTINGS, [url] if url else []))

    def join_failed(self) -> None:
        """The box could not join: ready for other settings, with the error said."""
        self._set_state(AUTHORIZED)
        self._set_error(UNABLE_TO_CONNECT)

    def scanned(self, networks: list[Network]) -> None:
        self._set_result(scan_result(networks))

    def _set_state(self, state: int) -> None:
        if state != self.state:
            self.state = state
            self.changed(CURRENT_STATE)

    def _set_error(self, error: int) -> None:
        if error != self.error:
            self.error = error
            self.changed(ERROR_STATE)

    def _set_result(self, value: bytes) -> None:
        self.last_result = value
        self.changed(RPC_RESULT)
