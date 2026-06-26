"""Tests for build_static_system_prompt and _get_os_info (P2-102)."""

import unittest
from unittest.mock import patch

from stupidex.domain.message import MessageRole, MessageType
from stupidex.llm import static_system_prompt as ssp


class GetOsInfoTest(unittest.TestCase):
    def test_linux_with_freedesktop_os_release(self):
        info = {"NAME": "Ubuntu", "VERSION_ID": "24.04"}
        with (
            patch("platform.system", return_value="Linux"),
            patch("platform.machine", return_value="x86_64"),
            patch("platform.release", return_value="6.8.0"),
            patch("platform.freedesktop_os_release", return_value=info),
        ):
            result = ssp._get_os_info()
        self.assertIn("Linux", result)
        self.assertIn("Ubuntu 24.04", result)
        self.assertIn("6.8.0", result)
        self.assertIn("x86_64", result)

    def test_linux_without_freedesktop_os_release_falls_back_to_unknown(self):
        with (
            patch("platform.system", return_value="Linux"),
            patch("platform.machine", return_value="aarch64"),
            patch("platform.release", return_value="6.1.0"),
            patch("platform.freedesktop_os_release", side_effect=OSError("no")),
        ):
            result = ssp._get_os_info()
        self.assertIn("Linux", result)
        self.assertIn("Unknown", result)
        self.assertIn("6.1.0", result)
        self.assertIn("aarch64", result)

    def test_linux_freedesktop_os_release_missing_keys_uses_unknown(self):
        with (
            patch("platform.system", return_value="Linux"),
            patch("platform.machine", return_value="x86_64"),
            patch("platform.release", return_value="6.8.0"),
            patch("platform.freedesktop_os_release", return_value={}),
        ):
            result = ssp._get_os_info()
        self.assertIn("Linux", result)
        self.assertIn("Unknown", result)

    def test_macos_branch(self):
        with (
            patch("platform.system", return_value="Darwin"),
            patch("platform.machine", return_value="arm64"),
            patch("platform.mac_ver", return_value=("14.5", (), "")),
        ):
            result = ssp._get_os_info()
        self.assertTrue(result.startswith("macOS"))
        self.assertIn("14.5", result)
        self.assertIn("arm64", result)

    def test_windows_branch(self):
        win_ver = ("10", "19045", "sp", "win32")
        with (
            patch("platform.system", return_value="Windows"),
            patch("platform.machine", return_value="AMD64"),
            patch("platform.win32_ver", return_value=win_ver),
        ):
            result = ssp._get_os_info()
        self.assertTrue(result.startswith("Windows"))
        self.assertIn("10", result)
        self.assertIn("19045", result)
        self.assertIn("AMD64", result)

    def test_unknown_platform_falls_through_to_generic_branch(self):
        with (
            patch("platform.system", return_value="Plan9"),
            patch("platform.machine", return_value="vax"),
            patch("platform.release", return_value="2.0"),
        ):
            result = ssp._get_os_info()
        self.assertIsInstance(result, str)
        self.assertIn("Plan9", result)
        self.assertIn("2.0", result)

    def test_returns_str_for_known_and_unknown_platforms(self):
        cases = [
            ("Windows", "AMD64"),
            ("Darwin", "arm64"),
            ("Linux", "x86_64"),
            ("Plan9", "vax"),
        ]
        for system, machine in cases:
            with self.subTest(system=system, machine=machine):
                with (
                    patch("platform.system", return_value=system),
                    patch("platform.machine", return_value=machine),
                    patch("platform.release", return_value="rel"),
                    patch("platform.win32_ver", return_value=("10", "b", "sp", "win32")),
                    patch("platform.mac_ver", return_value=("14.5", (), "")),
                    patch("platform.freedesktop_os_release", return_value={"NAME": "Distro"}),
                ):
                    result = ssp._get_os_info()
                self.assertIsInstance(result, str)
                self.assertTrue(result)


class BuildStaticSystemPromptTest(unittest.TestCase):
    def test_returns_system_role_text_message_with_prompt_and_os_info(self):
        with (
            patch("platform.system", return_value="Linux"),
            patch("platform.machine", return_value="x86_64"),
            patch("platform.release", return_value="6.8.0"),
            patch("platform.freedesktop_os_release", return_value={"NAME": "Ubuntu", "VERSION_ID": "24.04"}),
        ):
            msg = ssp.build_static_system_prompt("You are helpful.")
        self.assertEqual(msg.role, MessageRole.SYSTEM)
        self.assertEqual(msg.type, MessageType.TEXT)
        self.assertIn("You are helpful.", msg.content)
        self.assertIn("<user_operating_system>", msg.content)
        self.assertIn("</user_operating_system>", msg.content)
        self.assertIn("Ubuntu 24.04", msg.content)

    def test_message_structure_identical_across_linux_macos_windows_envs(self):
        envs = [
            ("Linux", "x86_64", "6.8.0", {"NAME": "Ubuntu", "VERSION_ID": "24.04"}),
            ("Darwin", "arm64", None, None),
            ("Windows", "AMD64", None, None),
        ]
        for system, machine, release, release_info in envs:
            with self.subTest(system=system):
                with (
                    patch("platform.system", return_value=system),
                    patch("platform.machine", return_value=machine),
                    patch("platform.release", return_value=release or "rel"),
                    patch("platform.win32_ver", return_value=("10", "b", "sp", "win32")),
                    patch("platform.mac_ver", return_value=("14.5", (), "")),
                    patch("platform.freedesktop_os_release", return_value=release_info or {}),
                ):
                    msg = ssp.build_static_system_prompt("base prompt")
                self.assertEqual(msg.role, MessageRole.SYSTEM)
                self.assertEqual(msg.type, MessageType.TEXT)
                self.assertIn("<instructions>", msg.content)
                self.assertIn("base prompt", msg.content)
                self.assertIn("<user_operating_system>", msg.content)
                self.assertTrue(msg.content.strip())


if __name__ == "__main__":
    unittest.main()
