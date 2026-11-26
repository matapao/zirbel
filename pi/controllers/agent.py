"""The pairing agent BlueZ asks (org.bluez.Agent1), with no input and no output: it agrees to the controller the owner
asked to pair, while that pairing runs, and to services of controllers paired already; it refuses everything else
(bluetooth.py's allows). A legacy device that wants a PIN gets 0000, as old gamepads expect."""

from __future__ import annotations

import dbus
import dbus.service

from bluetooth import AGENT_PATH, LEGACY_PIN, Bluetooth

AGENT = "org.bluez.Agent1"


def _rejected() -> dbus.DBusException:
    return dbus.DBusException("Rejected by the box.", name="org.bluez.Error.Rejected")


class Agent(dbus.service.Object):
    def __init__(self, bus, bluetooth: Bluetooth):
        super().__init__(bus, AGENT_PATH)
        self.bluetooth = bluetooth

    def _check(self, device, service: bool = False) -> None:
        if not self.bluetooth.allows(str(device), service):
            raise _rejected()

    @dbus.service.method(AGENT, in_signature="", out_signature="")
    def Release(self) -> None:  # noqa: N802 - D-Bus's names
        pass

    @dbus.service.method(AGENT, in_signature="o", out_signature="s")
    def RequestPinCode(self, device) -> str:  # noqa: N802
        self._check(device)
        return LEGACY_PIN

    @dbus.service.method(AGENT, in_signature="o", out_signature="u")
    def RequestPasskey(self, device) -> int:  # noqa: N802
        self._check(device)
        return dbus.UInt32(0)

    @dbus.service.method(AGENT, in_signature="os", out_signature="")
    def DisplayPinCode(self, device, pincode) -> None:  # noqa: N802
        self._check(device)

    @dbus.service.method(AGENT, in_signature="ouq", out_signature="")
    def DisplayPasskey(self, device, passkey, entered) -> None:  # noqa: N802
        pass

    @dbus.service.method(AGENT, in_signature="ou", out_signature="")
    def RequestConfirmation(self, device, passkey) -> None:  # noqa: N802
        self._check(device)

    @dbus.service.method(AGENT, in_signature="o", out_signature="")
    def RequestAuthorization(self, device) -> None:  # noqa: N802
        self._check(device)

    @dbus.service.method(AGENT, in_signature="os", out_signature="")
    def AuthorizeService(self, device, uuid) -> None:  # noqa: N802
        self._check(device, service=True)

    @dbus.service.method(AGENT, in_signature="", out_signature="")
    def Cancel(self) -> None:  # noqa: N802
        pass
