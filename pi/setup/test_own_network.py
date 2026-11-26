"""The box's own Wi-Fi (own_network.py, network.py): a password made once and kept for the editor's group alone, the
Wi-Fi following the editor's setting, the access point NetworkManager saves, and the setup hotspot's DNS kept to the
hotspot."""

import importlib
import io
import json
import os
import stat
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import own_network


def fake_dbus() -> types.ModuleType:
    """The D-Bus types network.py builds NetworkManager's settings from, without D-Bus: each value keeps its type."""
    module = types.ModuleType("dbus")

    class Dictionary(dict):
        def __init__(self, values=(), signature=None):
            super().__init__(values)
            self.signature = signature

    class Array(list):
        def __init__(self, values=(), signature=None):
            super().__init__(values)
            self.signature = signature

    class DBusException(Exception):
        pass

    module.Dictionary, module.Array, module.DBusException = Dictionary, Array, DBusException
    for name, base in (("ByteArray", bytes), ("UInt32", int), ("Int32", int), ("Boolean", int), ("ObjectPath", str)):
        setattr(module, name, type(name, (base,), {}))
    return module


def import_network():
    with mock.patch.dict(sys.modules, {"dbus": fake_dbus()}):
        sys.modules.pop("network", None)
        return importlib.import_module("network")


class FakeNetworkManager:
    """What own_network.apply asks of network.NetworkManager, and what it did."""

    def __init__(self, exists=False, active=False, starts=True):
        self.exists, self.active, self.starts, self.calls = exists, active, starts, []

    def own_network_exists(self):
        return self.exists

    def own_network_active(self):
        return self.active

    def own_network_up(self, name, password):
        self.calls.append(("up", name, password))
        self.exists = True
        self.active = self.starts
        return self.starts

    def own_network_down(self):
        self.calls.append(("down",))
        had, self.exists, self.active = self.exists, False, False
        return had


class Credentials(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.state = Path(self.folder.name) / "own-network.json"

    def test_a_password_is_twelve_characters_without_look_alikes_in_three_groups(self):
        passwords = {own_network.new_password() for _ in range(200)}
        self.assertEqual(len(passwords), 200)
        for password in passwords:
            groups = password.split("-")
            self.assertEqual([len(group) for group in groups], [4, 4, 4], password)
            self.assertTrue(set("".join(groups)) <= set(own_network.ALPHABET), password)
        self.assertFalse(set("0o1il") & set(own_network.ALPHABET))

    def test_the_name_and_password_are_made_once_and_kept_for_the_editors_group_alone(self):
        made = own_network.credentials("3F2A", self.state)
        self.assertEqual(made.name, "Zirbel 3F2A")
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o640)
        self.assertEqual(json.loads(self.state.read_text()), {"version": 1, "name": made.name, "password": made.password})
        self.assertEqual(own_network.credentials("9999", self.state), made, "the same ever after")
        self.assertEqual(own_network.read(self.state), made)
        self.assertEqual(os.listdir(self.folder.name), ["own-network.json"], "nothing half-written is left")

    def test_a_kept_file_a_network_cannot_take_is_made_again(self):
        for kept in ({"version": 1, "name": "Zirbel", "password": "short"},
                     {"version": 1, "name": "x" * 33, "password": "long enough"},
                     {"version": 1, "name": "Zirbel", "password": "naïve-password"},
                     {"version": 2, "name": "Zirbel", "password": "long enough"},
                     {"version": 1, "name": "Zirbel", "password": "long enough", "extra": True}):
            self.state.write_text(json.dumps(kept))
            self.assertIsNone(own_network.read(self.state), kept)
            self.assertNotEqual(own_network.credentials("3F2A", self.state).password, kept["password"])
        self.state.write_text(" " * (own_network.STATE_BYTES + 1))
        self.assertIsNone(own_network.read(self.state))
        self.assertIsNone(own_network.read(Path(self.folder.name) / "none.json"))
        with self.assertRaises(OSError):
            own_network.credentials("3F2A", Path(self.folder.name) / "no-folder" / "own-network.json")


class FollowingTheSetting(unittest.TestCase):
    made = own_network.Credentials("Zirbel 3F2A", "abcd-efgh-jkmn")

    def test_what_the_wifi_needs_for_each_setting(self):
        cases = {
            (True, False, False): own_network.UP,
            (True, True, False): own_network.UP,  # saved, but not running: brought back
            (True, True, True): own_network.KEEP,
            (False, True, True): own_network.DOWN,
            (False, True, False): own_network.DOWN,
            (False, False, False): own_network.KEEP,
            (None, True, True): own_network.KEEP,  # an editor that doesn't answer changes nothing
            (None, False, False): own_network.KEEP,
        }
        for (wanted, exists, active), step in cases.items():
            self.assertEqual(own_network.action(wanted=wanted, exists=exists, active=active), step, (wanted, exists, active))

    def test_the_network_is_made_after_the_radio_is_let_go_and_taken_away_when_it_does_not_start(self):
        nm = FakeNetworkManager()
        hotspot_down = lambda: nm.calls.append(("hotspot down",))  # noqa: E731
        self.assertEqual(own_network.apply(nm, True, self.made, before_up=hotspot_down), own_network.UP)
        self.assertEqual(nm.calls, [("hotspot down",), ("up", "Zirbel 3F2A", "abcd-efgh-jkmn")])
        self.assertEqual(own_network.apply(nm, True, self.made, before_up=hotspot_down), own_network.KEEP)
        self.assertEqual(len(nm.calls), 2, "a network that runs is left as it is")

        failing = FakeNetworkManager(starts=False)
        self.assertEqual(own_network.apply(failing, True, self.made), own_network.FAILED)
        self.assertEqual(failing.calls, [("up", "Zirbel 3F2A", "abcd-efgh-jkmn"), ("down",)])
        self.assertEqual(own_network.apply(FakeNetworkManager(), True, None), own_network.FAILED, "no password to make it with")

    def test_off_takes_the_network_away_and_no_answer_leaves_it(self):
        nm = FakeNetworkManager(exists=True, active=True)
        self.assertEqual(own_network.apply(nm, None, self.made), own_network.KEEP)
        self.assertEqual(nm.calls, [])
        self.assertEqual(own_network.apply(nm, False, self.made), own_network.DOWN)
        self.assertEqual(nm.calls, [("down",)])
        self.assertEqual(own_network.apply(nm, False, self.made), own_network.KEEP)


class AccessPoint(unittest.TestCase):
    def setUp(self):
        self.network = import_network()

    def test_the_access_point_is_wpa2_on_two_point_four_gigahertz_shared_from_the_box_and_comes_back_first(self):
        values = self.network.own_network_settings("Zirbel 3F2A", "abcd-efgh-jkmn")
        connection, wifi = values["connection"], values["802-11-wireless"]
        security, ipv4 = values["802-11-wireless-security"], values["ipv4"]
        self.assertEqual((connection["id"], connection["type"], connection["autoconnect"]),
                         ("zirbel-network", "802-11-wireless", True))
        self.assertGreaterEqual(connection["autoconnect-priority"], 100)
        self.assertEqual(type(connection["autoconnect-priority"]).__name__, "Int32")
        self.assertEqual((bytes(wifi["ssid"]), wifi["mode"], wifi["band"]), (b"Zirbel 3F2A", "ap", "bg"))
        self.assertEqual(type(wifi["ssid"]).__name__, "ByteArray")
        self.assertEqual((security["key-mgmt"], security["psk"]), ("wpa-psk", "abcd-efgh-jkmn"))
        self.assertEqual((list(security["proto"]), list(security["pairwise"]), list(security["group"])),
                         (["rsn"], ["ccmp"], ["ccmp"]))
        self.assertEqual((security["pmf"], type(security["pmf"]).__name__), (1, "Int32"))  # off, for older phones
        self.assertEqual(ipv4["method"], "shared")
        self.assertEqual([(item["address"], item["prefix"]) for item in ipv4["address-data"]], [("10.42.0.1", 24)])
        self.assertEqual(values["ipv6"]["method"], "disabled")

    def test_the_network_chosen_last_goes_first_and_the_own_wifi_before_any(self):
        self.assertEqual(self.network.next_priority([]), 1)
        self.assertEqual(self.network.next_priority([0, 3, 1]), 4)
        self.assertEqual(self.network.next_priority([98, 99]), 99)
        self.assertLess(self.network.next_priority([500]), self.network.OWN_PRIORITY)

    def test_every_name_resolves_to_the_box_only_while_the_setup_hotspot_runs(self):
        with tempfile.TemporaryDirectory() as folder:
            dns = Path(folder) / "zirbel-setup.conf"
            with mock.patch.object(self.network, "DNS_FILE", dns):
                self.network.wildcard_dns(True)
                self.assertIn("address=/#/10.42.0.1", dns.read_text())
                self.network.wildcard_dns(False)
                self.assertFalse(dns.exists())
                self.network.wildcard_dns(False)  # gone already
            with mock.patch.object(self.network, "DNS_FILE", Path(folder) / "none" / "zirbel-setup.conf"), \
                    mock.patch("sys.stdout", new_callable=io.StringIO) as said:
                self.network.wildcard_dns(True)  # said, and the hotspot goes on without it
            self.assertIn("The setup hotspot's DNS could not be set", said.getvalue())


if __name__ == "__main__":
    unittest.main()
