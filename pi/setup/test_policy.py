"""When the box sets itself up, and how its radios share (policy.py): from boards with both radios on one chip to a
Pi 2 B with none, or with USB adapters."""

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import policy


def fake_box(test: unittest.TestCase, model: str, wifi: str | None, bluetooth: str | None) -> tuple[Path, Path]:
    """A /sys with the radios a board has, each on its bus, and its device-tree model."""
    root = Path(tempfile.mkdtemp())
    test.addCleanup(shutil.rmtree, root)
    for kind, bus, name in (("ieee80211", wifi, "phy0"), ("bluetooth", bluetooth, "hci0")):
        (root / "class" / kind).mkdir(parents=True)
        if bus is None:
            continue
        parent = "platform/soc/usb1/1-1/1-1:1.0" if bus == "usb" else f"platform/soc/{bus}0"
        device = root / "devices" / parent / name
        device.mkdir(parents=True)
        (root / "bus" / bus).mkdir(parents=True, exist_ok=True)
        (device / "subsystem").symlink_to(root / "bus" / bus)
        link = root / "class" / kind / name
        link.mkdir()
        (link / "device").symlink_to(device)
    model_file = root / "model"
    model_file.write_bytes(model.encode() + b"\0")
    return root, model_file


class Decisions(unittest.TestCase):
    def test_setup_runs_when_asked_or_after_the_grace_period_without_a_network(self):
        self.assertTrue(policy.needed(online=True, offline_for=0, requested=True))
        self.assertFalse(policy.needed(online=False, offline_for=30, requested=False))
        self.assertTrue(policy.needed(online=False, offline_for=60, requested=False))
        self.assertFalse(policy.needed(online=True, offline_for=600, requested=False))

    def test_setup_ends_when_provisioned_or_when_a_network_it_was_not_asked_to_change_comes_back(self):
        self.assertTrue(policy.finished(online=False, requested=True, provisioned=True))
        self.assertTrue(policy.finished(online=True, requested=False, provisioned=False))
        self.assertFalse(policy.finished(online=True, requested=True, provisioned=False))
        # In the minutes after power-on a box with a network still takes a new one over Bluetooth.
        self.assertFalse(policy.finished(online=True, requested=False, provisioned=False, after_boot=True))
        self.assertTrue(policy.finished(online=True, requested=False, provisioned=True, after_boot=True))
        self.assertTrue(policy.after_boot(0) and policy.after_boot(policy.AFTER_BOOT_SECONDS - 1))
        self.assertFalse(policy.after_boot(policy.AFTER_BOOT_SECONDS))
        self.assertTrue(policy.abandoned(requested=True, since_use=policy.ABANDONED_SECONDS))
        self.assertFalse(policy.abandoned(requested=False, since_use=10_000))

    def test_saved_networks_are_tried_again_only_when_no_one_is_using_setup(self):
        idle = {"since_retry": policy.RETRY_SECONDS, "since_use": policy.IDLE_SECONDS}
        self.assertTrue(policy.retry_saved(saved=True, requested=False, **idle))
        self.assertFalse(policy.retry_saved(saved=False, requested=False, **idle))
        self.assertFalse(policy.retry_saved(saved=True, requested=True, **idle))
        self.assertFalse(policy.retry_saved(saved=True, requested=False, since_retry=policy.RETRY_SECONDS, since_use=10))

    def test_the_hotspot_waits_for_quiet_bluetooth_only_where_the_radio_cannot_do_both(self):
        shared = policy.Radios(wifi=True, bluetooth=True, sharing=policy.BLUETOOTH_FIRST)
        self.assertFalse(policy.hotspot_due(shared, quiet_for=30))
        self.assertTrue(policy.hotspot_due(shared, quiet_for=policy.HOTSPOT_AFTER_SECONDS))
        self.assertTrue(policy.hotspot_due(policy.Radios(True, True, policy.TOGETHER), quiet_for=0))
        self.assertTrue(policy.hotspot_due(policy.Radios(True, False, policy.BLUETOOTH_FIRST), quiet_for=0))


class Radios(unittest.TestCase):
    def test_each_board_by_its_radio(self):
        for model, expected in {
            "Raspberry Pi 3 Model B Rev 1.2": policy.BLUETOOTH_FIRST,
            "Raspberry Pi Zero 2 W Rev 1.0": policy.BLUETOOTH_FIRST,
            "Raspberry Pi 3 Model B Plus Rev 1.3": policy.TOGETHER,
            "Raspberry Pi 4 Model B Rev 1.5": policy.TOGETHER,
            "Raspberry Pi 400 Rev 1.0": policy.TOGETHER,
            "Raspberry Pi 5 Model B Rev 1.0": policy.TOGETHER,
        }.items():
            self.assertEqual(policy.sharing(model, "sdio", "serial"), expected, model)
        self.assertEqual(policy.sharing("Raspberry Pi 3 Model B Rev 1.2", "usb", "serial"), policy.TOGETHER)
        with mock.patch.dict(os.environ, {"ZIRBEL_SETUP_RADIOS": policy.TOGETHER}):
            self.assertEqual(policy.sharing("Raspberry Pi Zero 2 W Rev 1.0", "sdio", "serial"), policy.TOGETHER)

    def test_detection_from_the_system(self):
        root, model = fake_box(self, "Raspberry Pi Zero 2 W Rev 1.0", "sdio", "serial")
        self.assertEqual(policy.detect(root, model), policy.Radios(True, True, policy.BLUETOOTH_FIRST))
        root, model = fake_box(self, "Raspberry Pi 2 Model B Rev 1.1", None, None)
        self.assertEqual(policy.detect(root, model).wifi, False)
        root, model = fake_box(self, "Raspberry Pi 2 Model B Rev 1.1", "usb", None)
        self.assertEqual(policy.detect(root, model), policy.Radios(True, False, policy.TOGETHER))
        self.assertEqual(policy.model_name(model), "Raspberry Pi 2 Model B Rev 1.1")
        self.assertEqual(policy.model_name(root / "none"), "Raspberry Pi")


class CardReset(unittest.TestCase):
    def test_an_empty_file_on_the_boot_partition_resets_the_wifi_with_or_without_an_extension(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as folder:
            boot = Path(folder)
            self.assertIsNone(policy.reset_marker(boot))
            (boot / "zirbel-report.txt").write_text("report")
            (boot / "zirbel-reset-wifi-later").mkdir()
            self.assertIsNone(policy.reset_marker(boot))
            for name in ("zirbel-reset-wifi", "Zirbel-Reset-WiFi.txt"):
                marker = boot / name
                marker.write_text("")
                self.assertEqual(policy.reset_marker(boot), marker)
                marker.unlink()
        self.assertIsNone(policy.reset_marker(Path("/no/such/boot")))


if __name__ == "__main__":
    unittest.main()
