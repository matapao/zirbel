"""When the box sets itself up (policy.py): the grace period, the end of setup, the retries of the saved networks, and
the boards with a Wi-Fi radio, built in or a USB adapter, and without one."""

import shutil
import tempfile
import unittest
from pathlib import Path

import policy


def fake_sys(test: unittest.TestCase, *phys: str) -> Path:
    """A /sys with these Wi-Fi radios."""
    root = Path(tempfile.mkdtemp())
    test.addCleanup(shutil.rmtree, root)
    (root / "class" / "ieee80211").mkdir(parents=True)
    for name in phys:
        (root / "class" / "ieee80211" / name).mkdir()
    return root


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
        self.assertFalse(policy.finished(online=False, requested=False, provisioned=False))
        self.assertTrue(policy.abandoned(requested=True, since_use=policy.ABANDONED_SECONDS))
        self.assertFalse(policy.abandoned(requested=False, since_use=10_000))

    def test_saved_networks_are_tried_again_only_when_no_one_is_using_setup(self):
        idle = {"since_retry": policy.RETRY_SECONDS, "since_use": policy.IDLE_SECONDS}
        self.assertTrue(policy.retry_saved(saved=True, requested=False, **idle))
        self.assertFalse(policy.retry_saved(saved=False, requested=False, **idle))
        self.assertFalse(policy.retry_saved(saved=True, requested=True, **idle))
        self.assertFalse(policy.retry_saved(saved=True, requested=False, since_retry=policy.RETRY_SECONDS, since_use=10))


class Radio(unittest.TestCase):
    def test_a_box_is_set_up_over_wifi_only_where_it_has_a_wifi_radio(self):
        self.assertTrue(policy.has_wifi(fake_sys(self, "phy0")))
        self.assertTrue(policy.has_wifi(fake_sys(self, "phy0", "phy1")))  # with a USB adapter beside it
        self.assertFalse(policy.has_wifi(fake_sys(self)))  # a Pi 2 B: set up over Ethernet
        self.assertFalse(policy.has_wifi(Path("/no/such/sys")))


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
