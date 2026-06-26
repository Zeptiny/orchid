"""Tests for MCP server config validation in Config (U7)."""
import unittest

from stupidex.config import Config, validate_config


class TestMCPConfigValidation(unittest.TestCase):
    def test_valid_mcp_servers_validate_cleanly(self):
        servers = {"my-server": {"command": "node", "args": ["server.js"]}}
        cfg = Config(mcp_servers=servers)
        errors = validate_config(cfg)
        self.assertEqual(errors, [])

    def test_empty_mcp_servers_validates_cleanly(self):
        cfg = Config(mcp_servers={})
        errors = validate_config(cfg)
        self.assertEqual(errors, [])

    def test_mcp_servers_not_a_dict_is_flagged(self):
        cfg = Config()
        # Can't set mcp_servers to non-dict via dataclass ctor with type checking,
        # but validate_config checks isinstance.
        object.__setattr__(cfg, "mcp_servers", "not-a-dict")
        errors = validate_config(cfg)
        self.assertTrue(any("mcp_servers" in e for e in errors))

    def test_invalid_server_name_with_underscores_is_flagged(self):
        servers = {"bad_name": {"command": "node"}, "good-name": {"command": "node"}}
        cfg = Config(mcp_servers=servers)
        errors = validate_config(cfg)
        self.assertTrue(any("bad_name" in e for e in errors))
        self.assertFalse(any("good-name" in e for e in errors))

    def test_invalid_server_name_with_special_chars_is_flagged(self):
        servers = {"bad@name!": {"command": "node"}, "ok": {"command": "node"}}
        cfg = Config(mcp_servers=servers)
        errors = validate_config(cfg)
        self.assertTrue(any("bad@name!" in e for e in errors))
        self.assertFalse(any("ok" in e for e in errors))

    def test_server_config_not_a_dict_is_flagged(self):
        servers = {"bad-server": "not-a-dict", "good-server": {"command": "node"}}
        cfg = Config(mcp_servers=servers)
        errors = validate_config(cfg)
        self.assertTrue(any("bad-server" in e for e in errors))
        self.assertFalse(any("good-server" in e for e in errors))

    def test_deep_merge_project_overrides_same_name_home_entry(self):
        home_servers = {"shared": {"command": "home-cmd"}}
        project_servers = {"shared": {"command": "project-cmd"}}
        merged = {**home_servers, **project_servers}
        self.assertEqual(merged["shared"]["command"], "project-cmd")
        cfg = Config(mcp_servers=merged)
        errors = validate_config(cfg)
        self.assertEqual(errors, [])

    def test_deep_merge_home_entries_not_in_project_are_preserved(self):
        home_servers = {"home-only": {"command": "home-cmd"}, "shared": {"command": "home-cmd"}}
        project_servers = {"shared": {"command": "project-cmd"}}
        merged = {**home_servers, **project_servers}
        self.assertIn("home-only", merged)
        self.assertEqual(merged["home-only"]["command"], "home-cmd")
        cfg = Config(mcp_servers=merged)
        errors = validate_config(cfg)
        self.assertEqual(errors, [])

    def test_command_must_be_string_for_stdio_server(self):
        servers = {"bad": {"command": ["python", "-m", "foo"]}, "good": {"command": "python"}}
        cfg = Config(mcp_servers=servers)
        errors = validate_config(cfg)
        self.assertTrue(any("bad" in e for e in errors))
        self.assertFalse(any("good" in e for e in errors))

    def test_args_must_be_list(self):
        servers = {"bad": {"command": "python", "args": "not-a-list"}, "good": {"command": "python", "args": ["-m", "foo"]}}
        cfg = Config(mcp_servers=servers)
        errors = validate_config(cfg)
        self.assertTrue(any("bad" in e for e in errors))
        self.assertFalse(any("good" in e for e in errors))

    def test_command_validation_skipped_for_url_servers(self):
        servers = {"sse": {"url": "http://localhost:3000"}}
        cfg = Config(mcp_servers=servers)
        errors = validate_config(cfg)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
