"""Bluetooth controllers through BlueZ (bluetooth.py, agent.py), over a fake D-Bus: the controller powered on and the
agent registered as BlueZ appears, the paired and found gamepads, discovery for 30 s, pairing that trusts and connects
the one the owner picked, forgetting one, BlueZ's signals, and an agent that agrees to that one device alone."""

import importlib
import sys
import types
import unittest
from unittest import mock

from test_pads import Clock

ADAPTER = "/org/bluez/hci0"
PAD = ADAPTER + "/dev_A0_B1_C2_D3_E4_F5"
OTHER = ADAPTER + "/dev_11_22_33_44_55_66"
KEYBOARD = ADAPTER + "/dev_77_88_99_AA_BB_CC"


def fake_dbus() -> tuple[types.ModuleType, types.ModuleType]:
    """The parts of python3-dbus the service uses, without D-Bus."""
    module = types.ModuleType("dbus")

    class DBusException(Exception):
        def __init__(self, *args, name=None):
            super().__init__(*args)
            self._name = name

        def get_dbus_name(self):
            return self._name

    class Dictionary(dict):
        def __init__(self, values=(), signature=None):
            super().__init__(values)
            self.signature = signature

    module.DBusException, module.Dictionary = DBusException, Dictionary
    for name, base in (("Boolean", int), ("ObjectPath", str), ("UInt32", int), ("String", str)):
        setattr(module, name, type(name, (base,), {}))
    service = types.ModuleType("dbus.service")

    class Object:
        def __init__(self, bus=None, path=None):
            self.bus, self.path = bus, path

    service.Object = Object
    service.method = lambda interface, in_signature=None, out_signature=None: (lambda function: function)
    module.service = service
    return module, service


def import_bluez():
    module, service = fake_dbus()
    with mock.patch.dict(sys.modules, {"dbus": module, "dbus.service": service}):
        for name in ("bluetooth", "agent"):
            sys.modules.pop(name, None)
        return importlib.import_module("bluetooth"), importlib.import_module("agent"), module


bluetooth, agent, dbus = import_bluez()


def device(address: str, name: str | None, paired=False, connected=False, rssi=None, **more) -> dict:
    props = {"Address": address, "Alias": address.replace(":", "-"), "Paired": paired, "Connected": connected,
             "Adapter": ADAPTER, **more}
    if name:
        props["Name"] = name
    if rssi is not None:
        props["RSSI"] = rssi
    return {bluetooth.DEVICE: props}


class FakeBus:
    """BlueZ's objects, the calls made to them (those that answer later wait in pending), its signal receivers and
    the watch on its name."""

    def __init__(self, objects: dict):
        self.objects = objects
        self.calls: list[tuple[str, str, tuple]] = []
        self.pending: list[tuple[str, str, object, object]] = []
        self.failures: dict[tuple[str, str], Exception] = {}
        self.receivers: dict[str, object] = {}
        self.owner = None

    def get_object(self, name, path):
        assert name == bluetooth.BLUEZ
        return FakeProxy(self, path)

    def add_signal_receiver(self, handler, signal_name, dbus_interface, bus_name, path_keyword=None):
        self.receivers[signal_name] = handler

    def watch_name_owner(self, name, callback):
        self.owner = callback

    def called(self, method: str) -> list[tuple]:
        return [(path, args) for path, name, args in self.calls if name == method]

    def answer(self, method: str, error: Exception | None = None) -> None:
        index = next(index for index, item in enumerate(self.pending) if item[1] == method)
        _, _, reply, refuse = self.pending.pop(index)
        if error:
            refuse(error)
        else:
            reply()


class FakeProxy:
    def __init__(self, bus: FakeBus, path: str):
        self.bus, self.path = bus, path

    def __getattr__(self, method):
        def call(*args, dbus_interface=None, reply_handler=None, error_handler=None, timeout=None):
            self.bus.calls.append((self.path, method, args))
            failure = self.bus.failures.get((self.path, method))
            if method == "GetManagedObjects":
                return self.bus.objects
            if reply_handler:
                self.bus.pending.append((self.path, method, reply_handler, error_handler))
                return None
            if failure:
                raise failure
            return None
        return call


def objects(**adapter) -> dict:
    return {
        "/org/bluez": {bluetooth.AGENT_MANAGER: {}},
        ADAPTER: {bluetooth.ADAPTER: {"Address": "B8:27:EB:00:00:01", "Powered": False, "Discovering": False, **adapter}},
        PAD: device("A0:B1:C2:D3:E4:F5", "Wireless Controller", paired=True, connected=True, Icon="input-gaming"),
        OTHER: device("11:22:33:44:55:66", "Pro Controller", rssi=-60, Class=0x002508),
        KEYBOARD: device("77:88:99:AA:BB:CC", "Keyboard", rssi=-40, Icon="input-keyboard"),
    }


def started(test: unittest.TestCase, **adapter):
    bus, clock, changes = FakeBus(objects(**adapter)), Clock(), []
    cancelled = []
    found = bluetooth.Bluetooth(bus, lambda: changes.append(1), clock.later, cancelled.append, log=lambda text: None)
    found.start()
    bus.owner(":1.7")
    return bus, clock, found, changes, cancelled


class Start(unittest.TestCase):
    def test_bluez_appearing_powers_the_controller_and_takes_the_agent(self):
        bus, _, found, changes, _ = started(self)
        self.assertEqual(set(bus.receivers), {"InterfacesAdded", "InterfacesRemoved", "PropertiesChanged"})
        self.assertEqual(bus.called("Set"), [(ADAPTER, (bluetooth.ADAPTER, "Powered", True))])
        self.assertEqual(bus.called("RegisterAgent"), [("/org/bluez", (bluetooth.AGENT_PATH, "NoInputNoOutput"))])
        self.assertEqual(bus.called("RequestDefaultAgent"), [("/org/bluez", (bluetooth.AGENT_PATH,))])
        self.assertEqual(found.adapter, ADAPTER)
        self.assertTrue(changes)

    def test_an_agent_registered_already_is_still_made_the_default(self):
        bus = FakeBus(objects(Powered=True))
        bus.failures[("/org/bluez", "RegisterAgent")] = dbus.DBusException("exists", name="org.bluez.Error.AlreadyExists")
        found = bluetooth.Bluetooth(bus, lambda: None, Clock().later, lambda timer: None, log=lambda text: None)
        found.start()
        bus.owner(":1.7")
        self.assertEqual(bus.called("Set"), [], "a controller already on")
        self.assertEqual(len(bus.called("RequestDefaultAgent")), 1)

    def test_with_bluez_gone_there_is_no_bluetooth_and_it_comes_back(self):
        bus, _, found, _, _ = started(self)
        bus.owner("")
        self.assertEqual(found.view()["bluetooth"], False)
        found.scan(True)
        self.assertEqual(found.error, bluetooth.NO_BLUETOOTH)
        bus.owner(":1.9")
        self.assertTrue(found.view()["bluetooth"])
        self.assertEqual(len(bus.called("RegisterAgent")), 2)


class View(unittest.TestCase):
    def test_paired_gamepads_and_gamepads_found_closest_first(self):
        bus, _, found, _, _ = started(self)
        bus.receivers["InterfacesAdded"](ADAPTER + "/dev_00_11_22_33_44_55",
                                         device("00:11:22:33:44:55", "Arcade Stick", rssi=-30, Appearance=0x03C4))
        bus.receivers["InterfacesAdded"](ADAPTER + "/dev_00_11_22_33_44_56", device("00:11:22:33:44:56", None, rssi=-20,
                                                                                    Icon="input-gaming"))
        view = found.view()
        self.assertEqual(view["paired"], [{"address": "A0:B1:C2:D3:E4:F5", "name": "Wireless Controller", "connected": True}])
        # Not the keyboard, nor one with no name yet.
        self.assertEqual(view["found"], [{"address": "00:11:22:33:44:55", "name": "Arcade Stick"},
                                         {"address": "11:22:33:44:55:66", "name": "Pro Controller"}])
        self.assertEqual((view["scanning"], view["pairing"], view["error"]), (False, None, None))

    def test_signals_keep_the_view(self):
        bus, _, found, changes, _ = started(self)
        before = len(changes)
        bus.receivers["PropertiesChanged"](bluetooth.DEVICE, {"Connected": False}, [], path=PAD)
        self.assertFalse(found.view()["paired"][0]["connected"])
        bus.receivers["PropertiesChanged"](bluetooth.DEVICE, {}, ["Name"], path=OTHER)
        self.assertEqual(found.view()["found"], [])
        bus.receivers["InterfacesRemoved"](PAD, [bluetooth.DEVICE])
        self.assertEqual(found.view()["paired"], [])
        self.assertGreater(len(changes), before)
        # A signal about an object never listed changes nothing.
        bus.receivers["PropertiesChanged"](bluetooth.DEVICE, {"Connected": True}, [], path=ADAPTER + "/dev_none")


class Requests(unittest.TestCase):
    def test_looking_lasts_30_seconds_or_until_stopped(self):
        bus, clock, found, _, cancelled = started(self)
        found.scan(True)
        self.assertEqual([name for _, name, _ in bus.calls[-2:]], ["SetDiscoveryFilter", "StartDiscovery"])
        self.assertTrue(found.view()["scanning"])
        clock.advance(bluetooth.SCAN_SECONDS)
        self.assertFalse(found.view()["scanning"])
        self.assertEqual(len(bus.called("StopDiscovery")), 1)
        found.scan(True)
        found.scan(True)
        self.assertEqual(len(cancelled), 1, "looking again starts its 30 seconds again")
        found.scan(False)
        self.assertEqual(len(bus.called("StopDiscovery")), 2)
        self.assertFalse(found.scanning)

    def test_looking_that_bluez_refuses_says_why_and_bluez_ending_it_ends_it(self):
        bus, _, found, _, _ = started(self)
        found.scan(True)
        bus.answer("StartDiscovery", dbus.DBusException("Not ready", name="org.bluez.Error.NotReady"))
        self.assertFalse(found.scanning)
        self.assertIn("Not ready", found.error)
        found.scan(True)
        bus.answer("StartDiscovery", dbus.DBusException("busy", name="org.bluez.Error.InProgress"))
        self.assertTrue(found.scanning)
        bus.receivers["PropertiesChanged"](bluetooth.ADAPTER, {"Discovering": False}, [], path=ADAPTER)
        self.assertFalse(found.scanning)

    def test_pairing_trusts_and_connects_the_one_picked(self):
        bus, _, found, changes, _ = started(self)
        found.scan(True)
        found.pair("11:22:33:44:55:66")
        self.assertEqual(found.view()["pairing"], "11:22:33:44:55:66")
        self.assertFalse(found.scanning, "pairing stops looking")
        self.assertEqual(bus.pending[-1][:2], (OTHER, "Pair"))
        bus.answer("Pair")
        self.assertIn((OTHER, (bluetooth.DEVICE, "Trusted", True)), bus.called("Set"))
        bus.answer("Connect")
        self.assertEqual((found.pairing, found.error), (None, None))
        self.assertTrue(changes)

    def test_a_pairing_that_fails_says_so_and_one_paired_already_goes_on(self):
        bus, _, found, _, _ = started(self)
        found.pair("11:22:33:44:55:66")
        bus.answer("Pair", dbus.DBusException("failed", name="org.bluez.Error.AuthenticationFailed"))
        self.assertEqual(found.pairing, None)
        self.assertEqual(found.error, "Pro Controller didn't pair. Put it in pairing mode, then try again.")
        found.pair("11:22:33:44:55:66")
        bus.answer("Pair", dbus.DBusException("exists", name="org.bluez.Error.AlreadyExists"))
        bus.answer("Connect", dbus.DBusException("connected", name="org.bluez.Error.AlreadyConnected"))
        self.assertEqual((found.pairing, found.error), (None, None))
        found.pair("11:22:33:44:55:66")
        bus.answer("Pair")
        bus.answer("Connect", dbus.DBusException("page timeout", name="org.bluez.Error.Failed"))
        self.assertIn("didn't connect yet", found.error)

    def test_a_paired_one_is_connected_again_without_pairing(self):
        bus, _, found, _, _ = started(self)
        found.pair("A0:B1:C2:D3:E4:F5")
        self.assertEqual(bus.called("Pair"), [])
        self.assertEqual(bus.pending[-1][:2], (PAD, "Connect"))

    def test_pairing_what_the_box_doesnt_see_or_two_at_once_is_refused(self):
        bus, _, found, _, _ = started(self)
        found.pair("99:99:99:99:99:99")
        self.assertEqual(found.error, bluetooth.GONE)
        found.pair("not an address")
        self.assertEqual(found.error, bluetooth.GONE)
        found.pair("11:22:33:44:55:66")
        found.pair("A0:B1:C2:D3:E4:F5")
        self.assertEqual(found.error, bluetooth.BUSY)
        found.pair("11:22:33:44:55:66")
        self.assertEqual(len(bus.called("Pair")), 1, "the same one again waits for the first")

    def test_forgetting_removes_the_device_from_bluez(self):
        bus, _, found, _, _ = started(self)
        found.forget("A0:B1:C2:D3:E4:F5")
        self.assertEqual(bus.called("RemoveDevice"), [(ADAPTER, (PAD,))])
        bus.answer("RemoveDevice", dbus.DBusException("nope"))
        self.assertIn("didn't forget", found.error)
        found.forget("99:99:99:99:99:99")
        self.assertEqual(found.error, bluetooth.GONE)


class Agent(unittest.TestCase):
    def test_the_agent_agrees_to_the_device_being_paired_alone(self):
        bus, _, found, _, _ = started(self)
        pairing = agent.Agent(bus, found)
        self.assertEqual(pairing.path, bluetooth.AGENT_PATH)
        for ask in (lambda path: pairing.RequestConfirmation(path, 123456), pairing.RequestAuthorization,
                    pairing.RequestPinCode, pairing.RequestPasskey):
            with self.assertRaises(dbus.DBusException) as refused:
                ask(OTHER)
            self.assertEqual(refused.exception.get_dbus_name(), "org.bluez.Error.Rejected")
        found.pair("11:22:33:44:55:66")
        pairing.RequestConfirmation(OTHER, 123456)
        pairing.RequestAuthorization(OTHER)
        self.assertEqual(pairing.RequestPinCode(OTHER), "0000")
        self.assertEqual(pairing.RequestPasskey(OTHER), 0)
        # Another device asking meanwhile is refused.
        with self.assertRaises(dbus.DBusException):
            pairing.RequestAuthorization(KEYBOARD)

    def test_services_of_a_paired_controller_are_allowed_and_others_not(self):
        bus, _, found, _, _ = started(self)
        pairing = agent.Agent(bus, found)
        pairing.AuthorizeService(PAD, "00001124-0000-1000-8000-00805f9b34fb")
        with self.assertRaises(dbus.DBusException):
            pairing.AuthorizeService(KEYBOARD, "00001124-0000-1000-8000-00805f9b34fb")
        with self.assertRaises(dbus.DBusException):
            pairing.RequestAuthorization(PAD)
        pairing.Release()
        pairing.Cancel()
        pairing.DisplayPasskey(OTHER, 1, 0)


if __name__ == "__main__":
    unittest.main()
