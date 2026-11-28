"""Bluetooth controllers, through BlueZ's D-Bus API: the box's controller powered on, an agent that pairs with no input
and no output (Just Works, or a legacy PIN of 0000), discovery for 30 s at the owner's request, pairing, trusting and
connecting the gamepad the owner picks, and forgetting one.

The agent agrees only to the device the owner asked to pair, while that pairing runs; any other device that asks to
pair with the box is refused. A paired controller is trusted, so it connects again by itself, without asking. BlueZ may
start after this service, or restart: the controller and the agent are set up again whenever it appears.
"""

from __future__ import annotations

import re
from collections.abc import Callable

import dbus
from view import NO_BLUETOOTH

BLUEZ = "org.bluez"
ADAPTER = BLUEZ + ".Adapter1"
DEVICE = BLUEZ + ".Device1"
AGENT_MANAGER = BLUEZ + ".AgentManager1"
PROPS = "org.freedesktop.DBus.Properties"
OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager"
AGENT_PATH = "/org/zirbel/pads/agent"
CAPABILITY = "NoInputNoOutput"
SCAN_SECONDS = 30
PAIR_SECONDS = 60
CONNECT_SECONDS = 30
NAME_CHARS = 64
MAX_LISTED = 12
ADDRESS = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")
LEGACY_PIN = "0000"

GONE = "The box doesn't see that controller now. Look for controllers again."
BUSY = "The box is pairing another controller. Wait for it to finish."


def is_gamepad(props: dict) -> bool:
    """A gamepad or joystick, as BlueZ names its icon, or by its class of device (a peripheral that is a joystick or
    gamepad) or its Bluetooth LE appearance."""
    if str(props.get("Icon", "")) == "input-gaming":
        return True
    klass = int(props.get("Class", 0))
    if klass & 0x1F00 == 0x0500 and (klass >> 2) & 0x0F in (1, 2):
        return True
    return int(props.get("Appearance", 0)) in (0x03C3, 0x03C4)


def _name(props: dict) -> str:
    return str(props.get("Name") or props.get("Alias") or props.get("Address", ""))[:NAME_CHARS]


def _dbus_name(error: Exception) -> str:
    return getattr(error, "get_dbus_name", lambda: "")() or ""


class Bluetooth:
    """The box's Bluetooth controller and what it knows of devices, kept from BlueZ's objects and their signals."""

    def __init__(
        self,
        bus,
        changed: Callable[[], None],
        later: Callable[[float, Callable[[], None]], object],
        cancel: Callable[[object], None],
        log: Callable[[str], None] = lambda text: print(text, flush=True),
    ):
        self.bus, self.changed, self.later, self.cancel, self.log = bus, changed, later, cancel, log
        self.objects: dict[str, dict[str, dict]] = {}
        self.adapter: str | None = None
        self.scanning = False
        self.pairing: str | None = None
        self.error: str | None = None
        self._scan_timer: object = None

    def start(self) -> None:
        receive = self.bus.add_signal_receiver
        receive(self._added, signal_name="InterfacesAdded", dbus_interface=OBJECT_MANAGER, bus_name=BLUEZ)
        receive(self._removed, signal_name="InterfacesRemoved", dbus_interface=OBJECT_MANAGER, bus_name=BLUEZ)
        receive(
            self._properties, signal_name="PropertiesChanged", dbus_interface=PROPS, bus_name=BLUEZ, path_keyword="path"
        )
        self.bus.watch_name_owner(BLUEZ, self._owner)

    def _owner(self, owner: str) -> None:
        """BlueZ appeared (or came back) or went."""
        self.objects, self.adapter, self.scanning, self.pairing = {}, None, False, None
        if owner:
            try:
                manager = self.bus.get_object(BLUEZ, "/")
                objects = manager.GetManagedObjects(dbus_interface=OBJECT_MANAGER)
                self.objects = {
                    str(path): {str(name): dict(props) for name, props in interfaces.items()}
                    for path, interfaces in objects.items()
                }
            except dbus.DBusException as error:
                self.log(f"BlueZ didn't list its objects: {error}")
            self._choose_adapter()
            self._register_agent()
        self.changed()

    def _choose_adapter(self) -> None:
        adapters = sorted(path for path, interfaces in self.objects.items() if ADAPTER in interfaces)
        self.adapter = adapters[0] if adapters else None
        if self.adapter and not bool(self.objects[self.adapter][ADAPTER].get("Powered", False)):
            try:
                self._proxy(self.adapter).Set(ADAPTER, "Powered", dbus.Boolean(True), dbus_interface=PROPS)
            except dbus.DBusException as error:
                self.log(f"Bluetooth didn't power on: {error}")

    def _register_agent(self) -> None:
        manager = self.bus.get_object(BLUEZ, "/org/bluez")
        try:
            manager.RegisterAgent(dbus.ObjectPath(AGENT_PATH), CAPABILITY, dbus_interface=AGENT_MANAGER)
        except dbus.DBusException as error:
            if not _dbus_name(error).endswith(".AlreadyExists"):
                self.log(f"BlueZ took no agent: {error}")
                return
        try:
            manager.RequestDefaultAgent(dbus.ObjectPath(AGENT_PATH), dbus_interface=AGENT_MANAGER)
        except dbus.DBusException as error:
            self.log(f"BlueZ kept another default agent: {error}")

    def _proxy(self, path: str):
        return self.bus.get_object(BLUEZ, path)

    def _added(self, path, interfaces) -> None:
        kept = self.objects.setdefault(str(path), {})
        for name, props in interfaces.items():
            kept[str(name)] = dict(props)
        if ADAPTER in interfaces and not self.adapter:
            self._choose_adapter()
        self.changed()

    def _removed(self, path, interfaces) -> None:
        kept = self.objects.get(str(path), {})
        for name in interfaces:
            kept.pop(str(name), None)
        if not kept:
            self.objects.pop(str(path), None)
        if str(path) == self.adapter and ADAPTER in interfaces:
            self.adapter, self.scanning = None, False
            self._choose_adapter()
        self.changed()

    def _properties(self, interface, changed, invalidated, path=None) -> None:
        props = self.objects.get(str(path), {}).get(str(interface))
        if props is None:
            return
        props.update(changed)
        for name in invalidated:
            props.pop(str(name), None)
        if (
            str(interface) == ADAPTER
            and str(path) == self.adapter
            and "Discovering" in changed
            and not changed["Discovering"]
        ):
            self._scan_over()
        if str(interface) in (ADAPTER, DEVICE):
            self.changed()

    def devices(self) -> list[tuple[str, dict]]:
        """The adapter's devices, by object path."""
        prefix = (self.adapter or "\0") + "/"
        return [
            (path, interfaces[DEVICE])
            for path, interfaces in sorted(self.objects.items())
            if path.startswith(prefix) and DEVICE in interfaces
        ]

    def _device(self, address: str) -> tuple[str, dict] | None:
        return next(((path, props) for path, props in self.devices() if str(props.get("Address", "")) == address), None)

    def address_of(self, path: str) -> str | None:
        props = self.objects.get(str(path), {}).get(DEVICE)
        return str(props.get("Address", "")) if props else None

    def view(self) -> dict:
        """The paired controllers (with whether each is connected) and those found while looking, closest first."""
        paired, found = [], []
        for _, props in self.devices():
            address = str(props.get("Address", ""))
            if not ADDRESS.match(address) or not is_gamepad(props):
                continue
            if bool(props.get("Paired", False)):
                paired.append(
                    {"address": address, "name": _name(props), "connected": bool(props.get("Connected", False))}
                )
            elif "Name" in props:
                found.append((int(props.get("RSSI", -127)), {"address": address, "name": _name(props)}))
        found.sort(key=lambda item: -item[0])
        return {
            "bluetooth": self.adapter is not None,
            "scanning": self.scanning,
            "pairing": self.pairing,
            "error": self.error,
            "paired": paired[:MAX_LISTED],
            "found": [item for _, item in found][:MAX_LISTED],
        }

    # The owner's requests, from Box settings through the host.

    def scan(self, on: bool) -> None:
        self.error = None
        if not self.adapter:
            self.error = NO_BLUETOOTH
            return
        adapter = self._proxy(self.adapter)
        if not on:
            if self.scanning:
                adapter.StopDiscovery(dbus_interface=ADAPTER, reply_handler=_ignore, error_handler=_ignore)
            self._scan_over()
            return
        try:
            adapter.SetDiscoveryFilter(dbus.Dictionary({"Transport": "auto"}, signature="sv"), dbus_interface=ADAPTER)
        except dbus.DBusException:
            pass  # an older BlueZ: it looks for every kind
        self.scanning = True
        if self._scan_timer is not None:
            self.cancel(self._scan_timer)
        self._scan_timer = self.later(SCAN_SECONDS, self._scan_timeout)
        adapter.StartDiscovery(dbus_interface=ADAPTER, reply_handler=_ignore, error_handler=self._scan_refused)

    def _scan_timeout(self) -> None:
        self._scan_timer = None
        self.scan(False)

    def _scan_refused(self, error: Exception) -> None:
        if _dbus_name(error).endswith(".InProgress"):
            return
        self._scan_over()
        self.error = f"Bluetooth didn't start looking: {error}"
        self.changed()

    def _scan_over(self) -> None:
        if self._scan_timer is not None:
            self.cancel(self._scan_timer)
            self._scan_timer = None
        if self.scanning:
            self.scanning = False
            self.changed()

    def pair(self, address: str) -> None:
        self.error = None
        found = self._device(address) if self.adapter and ADDRESS.match(address) else None
        if not self.adapter:
            self.error = NO_BLUETOOTH
        elif self.pairing and self.pairing != address:
            self.error = BUSY
        elif not found:
            self.error = GONE
        if self.error or self.pairing == address:
            return
        path, props = found
        self.pairing = address
        # Pairing goes better with nothing else on the radio.
        self.scan(False)
        device = self._proxy(path)
        if bool(props.get("Paired", False)):
            self._trust(path, props)
            return
        device.Pair(
            dbus_interface=DEVICE,
            timeout=PAIR_SECONDS,
            reply_handler=lambda: self._trust(path, props),
            error_handler=lambda error: self._pair_failed(path, props, error),
        )

    def _pair_failed(self, path: str, props: dict, error: Exception) -> None:
        if _dbus_name(error).endswith(".AlreadyExists"):
            self._trust(path, props)
            return
        self._done(f"{_name(props)} didn't pair. Put it in pairing mode, then try again.")

    def _trust(self, path: str, props: dict) -> None:
        device = self._proxy(path)
        try:
            device.Set(DEVICE, "Trusted", dbus.Boolean(True), dbus_interface=PROPS)
        except dbus.DBusException as error:
            self.log(f"BlueZ didn't trust {props.get('Address')}: {error}")
        device.Connect(
            dbus_interface=DEVICE,
            timeout=CONNECT_SECONDS,
            reply_handler=lambda: self._done(None),
            error_handler=lambda error: self._connect_failed(props, error),
        )

    def _connect_failed(self, props: dict, error: Exception) -> None:
        if _dbus_name(error).endswith(".AlreadyConnected"):
            self._done(None)
        else:
            self._done(f"{_name(props)} paired, and didn't connect yet. Press a button on it.")

    def _done(self, error: str | None) -> None:
        self.pairing, self.error = None, error
        self.changed()

    def forget(self, address: str) -> None:
        self.error = None
        found = self._device(address) if self.adapter and ADDRESS.match(address) else None
        if not found:
            self.error = NO_BLUETOOTH if not self.adapter else GONE
            return
        if self.pairing == address:
            self.pairing = None
        self._proxy(self.adapter).RemoveDevice(
            dbus.ObjectPath(found[0]),
            dbus_interface=ADAPTER,
            reply_handler=_ignore,
            error_handler=lambda error: self._done(f"The box didn't forget it: {error}"),
        )

    # The agent's answers (agent.py).

    def allows(self, path: str, service: bool = False) -> bool:
        """Whether the agent agrees to a device's request: pairing for the device being paired; a service for that one,
        or for one paired already."""
        address = self.address_of(path)
        if address is not None and address == self.pairing:
            return True
        props = self.objects.get(str(path), {}).get(DEVICE, {})
        return service and bool(props.get("Paired", False))


def _ignore(*_args: object) -> None:
    """An answer nothing waits for."""
