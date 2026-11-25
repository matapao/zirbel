"""The Improv service over Bluetooth LE, through BlueZ's D-Bus API: a GATT application with Improv's characteristics,
and an advertisement with its service UUID and service data.

The advertisement holds the service UUID and service data together, as the protocol requires; they fill the 31 bytes
with the flags, so BlueZ puts the box's name in the scan response. When the state changes, the advertisement is
registered again with the new service data.
"""

from __future__ import annotations

from typing import Callable

import dbus
import dbus.service

import improv

BLUEZ = "org.bluez"
ADAPTER = BLUEZ + ".Adapter1"
GATT_MANAGER = BLUEZ + ".GattManager1"
ADVERTISING_MANAGER = BLUEZ + ".LEAdvertisingManager1"
SERVICE_IFACE = BLUEZ + ".GattService1"
CHARACTERISTIC_IFACE = BLUEZ + ".GattCharacteristic1"
ADVERTISEMENT_IFACE = BLUEZ + ".LEAdvertisement1"
PROPS = "org.freedesktop.DBus.Properties"
OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager"
ROOT = "/org/zirbel/setup"


def adapter_path(bus: dbus.Bus) -> str | None:
    """The first Bluetooth controller that can serve GATT and advertise."""
    manager = dbus.Interface(bus.get_object(BLUEZ, "/"), OBJECT_MANAGER)
    for path, interfaces in manager.GetManagedObjects().items():
        if ADAPTER in interfaces and GATT_MANAGER in interfaces and ADVERTISING_MANAGER in interfaces:
            return str(path)
    return None


def address(bus: dbus.Bus) -> str:
    path = adapter_path(bus)
    return str(bus.get_object(BLUEZ, path).Get(ADAPTER, "Address", dbus_interface=PROPS)) if path else ""


class Characteristic(dbus.service.Object):
    def __init__(self, bus: dbus.Bus, index: int, uuid: str, flags: list[str], service_path: str,
                 read: Callable[[], bytes], write: Callable[[bytes], None] | None, used: Callable[[], None]):
        self.path = f"{service_path}/char{index}"
        self.uuid, self.flags, self.service_path = uuid, flags, service_path
        self.read, self.write, self.used = read, write, used
        self.notifying = False
        super().__init__(bus, self.path)

    def properties(self) -> dict:
        return {
            CHARACTERISTIC_IFACE: {
                "Service": dbus.ObjectPath(self.service_path),
                "UUID": self.uuid,
                "Flags": dbus.Array(self.flags, signature="s"),
            }
        }

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface: str) -> dict:  # noqa: N802 - D-Bus's name
        return self.properties()[CHARACTERISTIC_IFACE]

    @dbus.service.method(CHARACTERISTIC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options: dict) -> dbus.Array:  # noqa: N802 - D-Bus's name
        self.used()
        return dbus.Array(self.read(), signature="y")

    @dbus.service.method(CHARACTERISTIC_IFACE, in_signature="aya{sv}")
    def WriteValue(self, value: dbus.Array, options: dict) -> None:  # noqa: N802 - D-Bus's name
        self.used()
        if not self.write:
            raise dbus.DBusException("Not writable.", name=BLUEZ + ".Error.NotPermitted")
        self.write(bytes(value))

    @dbus.service.method(CHARACTERISTIC_IFACE)
    def StartNotify(self) -> None:  # noqa: N802 - D-Bus's name
        self.used()
        self.notifying = True

    @dbus.service.method(CHARACTERISTIC_IFACE)
    def StopNotify(self) -> None:  # noqa: N802 - D-Bus's name
        self.notifying = False

    @dbus.service.signal(PROPS, signature="sa{sv}as")
    def PropertiesChanged(self, interface: str, changed: dict, invalidated: list) -> None:  # noqa: N802
        pass

    def notify(self) -> None:
        if self.notifying:
            changed = dbus.Dictionary({"Value": dbus.Array(self.read(), signature="y")}, signature="sv")
            self.PropertiesChanged(CHARACTERISTIC_IFACE, changed, dbus.Array([], signature="s"))


class Application(dbus.service.Object):
    """The GATT application: the Improv service and its characteristics, as BlueZ's object manager lists them."""

    def __init__(self, bus: dbus.Bus, service: improv.Service, used: Callable[[], None]):
        self.path = ROOT
        self.service_path = ROOT + "/service0"
        super().__init__(bus, ROOT)
        values = {
            improv.CAPABILITIES: lambda: bytes([service.capabilities]),
            improv.CURRENT_STATE: lambda: bytes([service.state]),
            improv.ERROR_STATE: lambda: bytes([service.error]),
            improv.RPC_RESULT: lambda: service.last_result,
        }
        specs = [
            (improv.CAPABILITIES, ["read"], None),
            (improv.CURRENT_STATE, ["read", "notify"], None),
            (improv.ERROR_STATE, ["read", "notify"], None),
            (improv.RPC_COMMAND, ["write", "write-without-response"], service.write),
            (improv.RPC_RESULT, ["read", "notify"], None),
        ]
        self.characteristics = {
            uuid: Characteristic(bus, index, uuid, flags, self.service_path, values.get(uuid, lambda: b""), write, used)
            for index, (uuid, flags, write) in enumerate(specs)
        }

    @dbus.service.method(OBJECT_MANAGER, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self) -> dict:  # noqa: N802 - D-Bus's name
        objects = {
            dbus.ObjectPath(self.service_path): {
                SERVICE_IFACE: {
                    "UUID": improv.SERVICE,
                    "Primary": dbus.Boolean(True),
                    "Characteristics": dbus.Array(
                        [dbus.ObjectPath(item.path) for item in self.characteristics.values()], signature="o"
                    ),
                }
            }
        }
        for item in self.characteristics.values():
            objects[dbus.ObjectPath(item.path)] = item.properties()
        return objects

    def notify(self, uuid: str) -> None:
        if uuid in self.characteristics:
            self.characteristics[uuid].notify()


class Advertisement(dbus.service.Object):
    def __init__(self, bus: dbus.Bus, index: int, name: str, service_data: bytes):
        self.path = f"{ROOT}/advertisement{index}"
        self.name, self.service_data = name, service_data
        super().__init__(bus, self.path)

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface: str) -> dict:  # noqa: N802 - D-Bus's name
        return {
            "Type": "peripheral",
            "ServiceUUIDs": dbus.Array([improv.SERVICE], signature="s"),
            "ServiceData": dbus.Dictionary(
                {improv.SERVICE_DATA: dbus.Array(self.service_data, signature="y")}, signature="sv"
            ),
            "LocalName": self.name,
            "Discoverable": dbus.Boolean(True),
        }

    @dbus.service.method(ADVERTISEMENT_IFACE)
    def Release(self) -> None:  # noqa: N802 - D-Bus's name
        pass


class Bluetooth:
    """The Improv service on the box's Bluetooth controller while setup runs."""

    def __init__(self, bus: dbus.Bus, service: improv.Service, name: str, used: Callable[[], None]):
        self.bus, self.service, self.name = bus, service, name
        path = adapter_path(bus)
        if not path:
            raise RuntimeError("No Bluetooth controller can advertise.")
        self.adapter = bus.get_object(BLUEZ, path)
        self.app = Application(bus, service, used)
        self.advertisement: Advertisement | None = None
        self._count = 0

    def start(self) -> None:
        self.adapter.Set(ADAPTER, "Powered", dbus.Boolean(True), dbus_interface=PROPS)
        self.adapter.Set(ADAPTER, "Alias", self.name, dbus_interface=PROPS)
        try:
            dbus.Interface(self.adapter, GATT_MANAGER).RegisterApplication(dbus.ObjectPath(self.app.path), {})
        except dbus.DBusException as error:
            # An earlier start that failed after it may have left it registered: then it is there already.
            if not (error.get_dbus_name() or "").endswith(".AlreadyExists"):
                raise
        self._advertise()

    def _advertise(self) -> None:
        manager = dbus.Interface(self.adapter, ADVERTISING_MANAGER)
        if self.advertisement:
            try:
                manager.UnregisterAdvertisement(dbus.ObjectPath(self.advertisement.path))
            except dbus.DBusException:
                pass
            self.advertisement.remove_from_connection()
        self._count += 1
        self.advertisement = Advertisement(self.bus, self._count, self.name, self.service.service_data())
        manager.RegisterAdvertisement(dbus.ObjectPath(self.advertisement.path), {})

    def changed(self, uuid: str) -> None:
        """A characteristic changed: its listeners hear it, and a new state goes into the advertisement too."""
        self.app.notify(uuid)
        if uuid == improv.CURRENT_STATE and self.service.state != improv.PROVISIONED:
            self._advertise()

    def stop(self) -> None:
        manager = dbus.Interface(self.adapter, ADVERTISING_MANAGER)
        if self.advertisement:
            try:
                manager.UnregisterAdvertisement(dbus.ObjectPath(self.advertisement.path))
            except dbus.DBusException:
                pass
        try:
            dbus.Interface(self.adapter, GATT_MANAGER).UnregisterApplication(dbus.ObjectPath(self.app.path))
        except dbus.DBusException:
            pass
