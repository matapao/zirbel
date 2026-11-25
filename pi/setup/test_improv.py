"""The Improv Wi-Fi protocol as the box serves it: packets and their checksum, writes in parts, results, and the
service's states and errors (improv.py)."""

import unittest

import improv


def decode_result(value: bytes) -> tuple[int, list[str]]:
    """A client's reading of an RPC result: its command and strings, its checksum checked."""
    assert improv.checksum(value[:-1]) == value[-1], "bad checksum"
    assert value[1] == len(value) - 3, "bad length"
    data, strings = value[2:-1], []
    while data:
        strings.append(data[1 : 1 + data[0]].decode("utf-8"))
        data = data[1 + data[0] :]
    return value[0], strings


def wifi_packet(ssid: bytes, password: bytes) -> bytes:
    return improv.packet(improv.WIFI_SETTINGS, bytes([len(ssid)]) + ssid + bytes([len(password)]) + password)


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class Packets(unittest.TestCase):
    def test_the_specs_example_is_built_and_read(self):
        value = wifi_packet(b"MyWirelessAP", b"mysecurepassword")
        self.assertEqual(value[:3], bytes([0x01, 0x1E, 0x0C]))
        self.assertEqual(value[-1], sum(value[:-1]) & 0xFF)
        reader = improv.PacketReader()
        command, data = reader.feed(value)
        self.assertEqual(command, improv.WIFI_SETTINGS)
        self.assertEqual(improv.wifi_settings(data), (b"MyWirelessAP", b"mysecurepassword"))

    def test_a_packet_comes_in_twenty_byte_writes(self):
        value = wifi_packet(b"A network with a long name", b"and a password long enough")
        reader = improv.PacketReader()
        parts = [value[index : index + 20] for index in range(0, len(value), 20)]
        self.assertGreater(len(parts), 2)
        for part in parts[:-1]:
            self.assertIsNone(reader.feed(part))
        self.assertEqual(reader.feed(parts[-1])[0], improv.WIFI_SETTINGS)

    def test_a_wrong_checksum_or_extra_bytes_are_refused_and_the_next_packet_starts_clean(self):
        reader = improv.PacketReader()
        bad = bytearray(improv.packet(improv.IDENTIFY))
        bad[-1] ^= 0xFF
        with self.assertRaises(improv.InvalidPacket):
            reader.feed(bytes(bad))
        with self.assertRaises(improv.InvalidPacket):
            reader.feed(improv.packet(improv.IDENTIFY) + b"\x00")
        self.assertEqual(reader.feed(improv.packet(improv.IDENTIFY)), (improv.IDENTIFY, b""))

    def test_a_packet_whose_parts_stop_coming_is_dropped(self):
        clock = Clock()
        reader = improv.PacketReader(clock)
        value = wifi_packet(b"Network", b"password1")
        self.assertIsNone(reader.feed(value[:5]))
        clock.now = improv.PARTIAL_PACKET_SECONDS + 1
        self.assertEqual(reader.feed(improv.packet(improv.DEVICE_INFO)), (improv.DEVICE_INFO, b""))

    def test_wifi_settings_must_add_up(self):
        for data in [b"", b"\x05abc", b"\x03abc\x05pw", b"\x00\x00", b"\x21" + b"a" * 33 + b"\x00"]:
            with self.assertRaises(improv.InvalidPacket, msg=data):
                improv.wifi_settings(data)
        self.assertEqual(improv.wifi_settings(b"\x04open\x00"), (b"open", b""))

    def test_results_hold_strings_and_scans_fit_one_packet_strongest_first(self):
        self.assertEqual(decode_result(improv.result(improv.WIFI_SETTINGS, ["http://zirbel.local/pair?code=AB"]))[1],
                         ["http://zirbel.local/pair?code=AB"])
        networks = [improv.Network(f"Network {index:02}".encode(), -90 + index, "WPA2") for index in range(40)]
        networks.append(improv.Network(b"Network 39", -95, "WPA2"))  # the same name, weaker: only the strongest
        value = improv.scan_result(networks)
        self.assertLessEqual(len(value), 255 + 3)
        command, strings = decode_result(value)
        self.assertEqual(command, improv.SCAN)
        self.assertEqual(len(strings) % 3, 0)
        self.assertEqual(strings[:3], ["Network 39", "-51", "WPA2"])
        self.assertEqual(strings.count("Network 39"), 1)
        self.assertEqual(decode_result(improv.scan_result([]))[1], [])


class ServiceStates(unittest.TestCase):
    def setUp(self):
        self.changes, self.joins, self.identified, self.scans = [], [], [], []
        info = improv.DeviceInfo("Zirbel setup", "1", "Raspberry Pi 5 Model B Rev 1.0", "Zirbel-3456",
                                 "Debian GNU/Linux", "13")
        self.service = improv.Service(info=info, changed=self.changes.append,
                                      join=lambda ssid, password: self.joins.append((ssid, password)),
                                      identify=lambda: self.identified.append(True),
                                      scan=lambda: self.scans.append(True))

    def test_it_starts_authorized_and_advertises_its_state_and_capabilities(self):
        self.assertEqual(self.service.state, improv.AUTHORIZED)
        self.assertEqual(self.service.service_data(),
                         bytes([improv.AUTHORIZED, improv.CAN_IDENTIFY | improv.CAN_DEVICE_INFO | improv.CAN_SCAN, 0, 0, 0, 0]))

    def test_wifi_settings_join_and_a_join_ends_provisioned_with_the_pairing_link(self):
        self.service.write(wifi_packet(b"Home", b"secret password"))
        self.assertEqual(self.joins, [(b"Home", b"secret password")])
        self.assertEqual(self.service.state, improv.PROVISIONING)
        self.service.write(wifi_packet(b"Other", b"another password"))  # one join at a time
        self.assertEqual(len(self.joins), 1)
        self.service.joined("http://zirbel.local/pair?code=ABCD-EFGH")
        self.assertEqual(self.service.state, improv.PROVISIONED)
        self.assertEqual(decode_result(self.service.last_result),
                         (improv.WIFI_SETTINGS, ["http://zirbel.local/pair?code=ABCD-EFGH"]))
        self.assertEqual(self.changes, [improv.CURRENT_STATE, improv.CURRENT_STATE, improv.RPC_RESULT])

    def test_a_failed_join_is_said_and_other_settings_can_follow(self):
        self.service.write(wifi_packet(b"Home", b"wrong password"))
        self.service.join_failed()
        self.assertEqual((self.service.state, self.service.error), (improv.AUTHORIZED, improv.UNABLE_TO_CONNECT))
        self.service.write(wifi_packet(b"Home", b"right password"))
        self.assertEqual((self.service.state, self.service.error), (improv.PROVISIONING, improv.NO_ERROR))

    def test_bad_packets_and_unknown_commands_are_errors(self):
        self.service.write(b"\x01\x02\x00\x00\x00")
        self.assertEqual(self.service.error, improv.INVALID_RPC)
        self.service.write(improv.packet(0x7F))
        self.assertEqual(self.service.error, improv.UNKNOWN_RPC)
        self.service.write(improv.packet(improv.WIFI_SETTINGS, b"\x09short"))
        self.assertEqual(self.service.error, improv.INVALID_RPC)
        self.assertEqual(self.joins, [])

    def test_device_info_identify_and_scan(self):
        self.service.write(improv.packet(improv.DEVICE_INFO))
        self.assertEqual(decode_result(self.service.last_result)[1],
                         ["Zirbel setup", "1", "Raspberry Pi 5 Model B Rev 1.0", "Zirbel-3456", "Debian GNU/Linux", "13"])
        self.service.write(improv.packet(improv.IDENTIFY))
        self.service.write(improv.packet(improv.SCAN))
        self.assertEqual((self.identified, self.scans), ([True], [True]))
        self.service.scanned([improv.Network(b"Home", -40, "WPA2/WPA3")])
        self.assertEqual(decode_result(self.service.last_result), (improv.SCAN, ["Home", "-40", "WPA2/WPA3"]))

    def test_a_box_without_a_light_does_not_identify(self):
        self.service.capabilities = improv.CAN_DEVICE_INFO | improv.CAN_SCAN
        self.service.write(improv.packet(improv.IDENTIFY))
        self.assertEqual((self.identified, self.service.error), ([], improv.UNKNOWN_RPC))


if __name__ == "__main__":
    unittest.main()
