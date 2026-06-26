import unittest

from orchid.app import Orchid
from orchid.config import Config, ConfigManager


class ThemeStartupTest(unittest.TestCase):
    def tearDown(self):
        ConfigManager.reset()

    def test_default_theme_config_resolves_to_registered_theme_name(self):
        ConfigManager._instance = Config(theme="default")

        app = Orchid()

        self.assertEqual(app.theme, "textual-dark")


if __name__ == "__main__":
    unittest.main()
