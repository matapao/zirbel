"""The TV console's follower (zirbel_tv.py), over a DRM tree in sysfs's shape and the editor's answers."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import zirbel_tv


def connectors(root: Path, **statuses: str) -> Path:
    """A /sys/class/drm with these connectors (card1-HDMI-A-1=connected, ...)."""
    for name, status in statuses.items():
        folder = root / name.replace("_", "-")
        folder.mkdir(parents=True)
        (folder / "status").write_text(status + "\n", encoding="ascii")
    (root / "card1").mkdir(exist_ok=True)
    (root / "version").write_text("drm 1.1.0\n", encoding="ascii")
    return root


class Displays(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self) -> None:
        self.folder.cleanup()

    def test_a_connector_with_something_plugged_in_is_a_display(self) -> None:
        drm = connectors(
            self.root,
            card1_HDMI_A_1="disconnected",
            card1_HDMI_A_2="connected",
            card1_Writeback_1="connected",
            card0_Composite_1="unknown",
        )
        self.assertEqual(zirbel_tv.displays(drm), ["card1-HDMI-A-2"])

    def test_none_plugged_in_or_no_drm_at_all(self) -> None:
        self.assertEqual(zirbel_tv.displays(connectors(self.root, card1_HDMI_A_1="disconnected")), [])
        self.assertEqual(zirbel_tv.displays(self.root / "missing"), [])


class Switch(unittest.TestCase):
    def test_the_switch_as_the_editor_says_it(self) -> None:
        self.assertIs(zirbel_tv.switch(ask=lambda: {"settings": {"tv": True}}), True)
        self.assertIs(zirbel_tv.switch(ask=lambda: {"settings": {"tv": False, "ownNetwork": True}}), False)

    def test_an_editor_that_doesnt_say_is_asked_again_then_not_known(self) -> None:
        answers = [OSError("refused"), {"error": "starting"}, {"settings": {"tv": True}}]
        waits: list[float] = []

        def ask() -> object:
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        self.assertIs(zirbel_tv.switch(attempts=3, wait=2.0, ask=ask, sleep=waits.append), True)
        self.assertEqual(waits, [2.0, 2.0])
        self.assertIsNone(zirbel_tv.switch(attempts=2, ask=lambda: {"settings": {"tv": "on"}}, sleep=lambda _: None))
        self.assertIsNone(zirbel_tv.switch(ask=lambda: [1, 2]))

        def broken() -> object:
            raise ValueError("not JSON")

        self.assertIsNone(zirbel_tv.switch(ask=broken))


class Follow(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.wake = self.root / "run" / "wake"
        self.wake.parent.mkdir()
        self.commands: list[list[str]] = []

    def tearDown(self) -> None:
        self.folder.cleanup()

    def follow(self, drm: Path, answer: object) -> str | None:
        def ask() -> object:
            if isinstance(answer, Exception):
                raise answer
            return answer

        return zirbel_tv.follow(drm=drm, wake=self.wake, ask=ask, run=self.commands.append, sleep=lambda _: None)

    def test_the_console_starts_with_a_display_and_the_switch_on(self) -> None:
        self.wake.touch()
        drm = connectors(self.root / "drm", card1_HDMI_A_1="connected")
        self.assertEqual(self.follow(drm, {"settings": {"tv": True}}), "start")
        self.assertEqual(self.commands, [["/usr/bin/systemctl", "--no-block", "start", "zirbel-tv.service"]])
        self.assertFalse(self.wake.exists(), "the wake file goes")

    def test_it_stops_with_the_switch_off_or_no_display_and_waits_on_an_editor_that_doesnt_say(self) -> None:
        drm = connectors(self.root / "drm", card1_HDMI_A_1="connected")
        self.assertEqual(self.follow(drm, {"settings": {"tv": False}}), "stop")
        self.assertIsNone(self.follow(drm, OSError("refused")))
        unplugged = connectors(self.root / "unplugged", card1_HDMI_A_1="disconnected")
        self.assertEqual(self.follow(unplugged, OSError("not asked")), "stop")
        self.assertEqual([command[2] for command in self.commands], ["stop", "stop"])

    def test_decisions(self) -> None:
        self.assertEqual(zirbel_tv.decide(True, True), "start")
        self.assertEqual(zirbel_tv.decide(True, False), "stop")
        self.assertIsNone(zirbel_tv.decide(True, None))
        self.assertEqual(zirbel_tv.decide(False, True), "stop")
        self.assertEqual(zirbel_tv.decide(False, None), "stop")


if __name__ == "__main__":
    unittest.main()
