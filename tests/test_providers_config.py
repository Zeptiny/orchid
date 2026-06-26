"""Tests for multi-provider config — updated for validate_config() return-as-errors."""
import json
import os
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

import stupidex.config as cfg_mod
from stupidex.config import (
    Config,
    ConfigManager,
    _deep_merge_provider_dict,
    _merge_from_env,
    get_model_for_tier,
    validate_config,
)

_RESERVED_ENV_KEYS = (
    "STUPIDEX_DEFAULT_MODEL",
    "STUPIDEX_RAG_EMBEDDING_MODEL",
)


class TestProvidersConfigValidation(unittest.TestCase):

    def setUp(self) -> None:
        self._saved_env = {k: os.environ.pop(k, None) for k in _RESERVED_ENV_KEYS}

    def tearDown(self) -> None:
        for k, v in self._saved_env.items():
            if v is not None:
                os.environ[k] = v
            else:
                os.environ.pop(k, None)

    def test_two_valid_providers_validate_cleanly(self):
        providers = {
            "work-openai": {
                "base_url": "https://api.openai.com",
                "api_key": "sk-test",
                "litellm_provider": "openai",
                "models": {"gpt-4o": {}},
            },
            "anthropic-prod": {
                "api_key_env": "ANTHROPIC_KEY",
                "litellm_provider": "anthropic",
                "models": {"claude-3-opus": {}},
            },
        }
        cfg = Config(providers=providers)
        errors = validate_config(cfg)
        self.assertEqual(errors, [])

    def test_empty_providers_validates_cleanly(self):
        cfg = Config(providers={})
        errors = validate_config(cfg)
        self.assertEqual(errors, [])

    def test_provider_alias_with_slash_flagged_as_error(self):
        providers = {"work/openai": {"api_key": "sk-test"}, "ok-alias": {"api_key": "sk-test"}}
        cfg = Config(providers=providers)
        errors = validate_config(cfg)
        self.assertTrue(any("work/openai" in e for e in errors), f"Expected error about bad alias, got: {errors}")
        # ok-alias should NOT appear in any error
        self.assertFalse(any("ok-alias" in e and "error" not in e.lower() for e in errors if "work" not in e))

    def test_both_api_key_and_api_key_env_flagged(self):
        cfg = Config(providers={"prov1": {"api_key": "sk-lit", "api_key_env": "ENV_NAME"}})
        errors = validate_config(cfg)
        self.assertTrue(any("api_key_env" in e for e in errors))

    def test_non_dict_provider_entry_flagged(self):
        cfg = Config(providers={"bad-prov": "not-a-dict", "good-prov": {"api_key": "sk"}})
        errors = validate_config(cfg)
        self.assertTrue(any("bad-prov" in e for e in errors))

    def test_rag_embedding_defaults_via_nested_config(self):
        cfg = Config()
        self.assertEqual(cfg.rag.embedding_model, "fastembed/BAAI/bge-small-en-v1.5")

    def test_reserved_fastembed_alias_flagged(self):
        cfg = Config(providers={"fastembed": {"models": {"x": {}}}})
        errors = validate_config(cfg)
        self.assertTrue(any("fastembed" in e for e in errors))


class TestProvidersConfigMerge(unittest.TestCase):

    def test_models_subdict_recursively_merged(self):
        home = {"work-openai": {"models": {"gpt-4o": {}, "gpt-4o-mini": {}}}}
        project = {"work-openai": {"models": {"gpt-4o": {"max_input_tokens": 32768}}}}
        merged = _deep_merge_provider_dict(home, project)
        models = merged["work-openai"]["models"]
        self.assertIn("gpt-4o-mini", models)
        self.assertEqual(models["gpt-4o"], {"max_input_tokens": 32768})

    def test_home_only_entry_fields_preserved_when_project_adds_model(self):
        home = {"work-openai": {"api_key": "sk-home", "models": {"gpt-4o": {}}}}
        project = {
            "work-openai": {
                "models": {"gpt-4o": {"max_input_tokens": 32768}, "gpt-4o-mini": {}}
            }
        }
        merged = _deep_merge_provider_dict(home, project)
        self.assertEqual(merged["work-openai"]["api_key"], "sk-home")
        self.assertIn("gpt-4o-mini", merged["work-openai"]["models"])

    def test_project_only_aliases_added(self):
        home = {"home-alias": {"api_key": "sk"}}
        project = {"project-alias": {"api_key": "sk2"}}
        merged = _deep_merge_provider_dict(home, project)
        self.assertIn("home-alias", merged)
        self.assertIn("project-alias", merged)

    def test_mcp_servers_still_shallow_merges_entry_fields(self):
        home = {"shared": {"command": "home-cmd"}, "home-only": {"command": "home-cmd"}}
        project = {"shared": {"command": "project-cmd"}}
        merged = _deep_merge_provider_dict(home, project)
        self.assertEqual(merged["shared"]["command"], "project-cmd")
        self.assertEqual(merged["home-only"]["command"], "home-cmd")


class TestProvidersConfigEnvOverride(unittest.TestCase):

    def test_rag_embedding_model_env_override(self):
        prior = os.environ.get("STUPIDEX_RAG_EMBEDDING_MODEL")
        os.environ["STUPIDEX_RAG_EMBEDDING_MODEL"] = "work-openai/text-embedding-3-large"
        try:
            cfg = Config()
            merged = _merge_from_env(cfg)
            self.assertEqual(merged.rag.embedding_model, "work-openai/text-embedding-3-large")
        finally:
            if prior is None:
                os.environ.pop("STUPIDEX_RAG_EMBEDDING_MODEL", None)
            else:
                os.environ["STUPIDEX_RAG_EMBEDDING_MODEL"] = prior


class TestProvidersConfigDefaults(unittest.TestCase):

    def test_default_model_and_tier_models_emit_alias_model_strings(self):
        cfg = Config()
        self.assertEqual(cfg.default_model, "default/mimo-v2.5")
        for tier in ("tolo", "tainha", "papudo", "papaca"):
            self.assertEqual(cfg.tier_models[tier], "default/mimo-v2.5", f"tier {tier}")

    def test_default_providers_entry_has_url_and_model(self):
        cfg = Config()
        default = cfg.providers["default"]
        self.assertEqual(default["base_url"], "https://opencode.ai/zen/go/v1")
        self.assertEqual(default["litellm_provider"], "openai")
        self.assertIn("mimo-v2.5", default["models"])
        self.assertNotIn("api_key", default)
        self.assertNotIn("api_key_env", default)

    def test_first_run_install_seeds_default_provider_and_loads(self):
        with tempfile.TemporaryDirectory() as tmpdir_str:
            tmpdir = Path(tmpdir_str)
            home_path = tmpdir / "config.json"
            home_agents = tmpdir / "agents"
            home_skills = tmpdir / "skills"

            with (
                patch.object(cfg_mod, "HOME_CONFIG_DIR", tmpdir),
                patch.object(cfg_mod, "HOME_CONFIG_PATH", home_path),
                patch.object(cfg_mod, "HOME_AGENTS_DIR", home_agents),
                patch.object(cfg_mod, "HOME_SKILLS_DIR", home_skills),
                patch.object(cfg_mod, "PROJECT_CONFIG_NAME", "nonexistent-project-config.json"),
                patch("stupidex.agents.seed_agents_dir"),
                patch("stupidex.agents.load_agents"),
                patch("stupidex.skills.seed_skills_dir"),
                patch("stupidex.skills.load_skills"),
                patch("stupidex.personality.load_personalities"),
            ):
                ConfigManager.reset()
                ConfigManager.ensure_home_config()

                self.assertTrue(home_path.exists())
                with open(home_path) as f:
                    data = json.load(f)
                self.assertIn("providers", data)
                self.assertIn("default", data["providers"])
                self.assertEqual(
                    data["providers"]["default"]["base_url"],
                    "https://opencode.ai/zen/go/v1",
                )

                ConfigManager.reset()
                cfg = ConfigManager.load()
                self.assertEqual(cfg.default_model, "default/mimo-v2.5")
                self.assertEqual(get_model_for_tier("tolo"), "default/mimo-v2.5")
                self.assertIn("default", cfg.providers)
                self.assertEqual(
                    cfg.providers["default"]["litellm_provider"], "openai"
                )

    def test_custom_tier_model_resolution_returns_string(self):
        cfg = Config(tier_models={"tolo": "work-openai/gpt-4o-mini"})
        self.assertEqual(cfg.tier_models["tolo"], "work-openai/gpt-4o-mini")
        original_instance = ConfigManager._instance
        try:
            ConfigManager._instance = cfg
            self.assertEqual(get_model_for_tier("tolo"), "work-openai/gpt-4o-mini")
        finally:
            ConfigManager._instance = original_instance

    def test_tier_model_with_unknown_alias_validates_cleanly(self):
        cfg = Config(tier_models={"tolo": "missing-alias/gpt-4o"})
        self.assertEqual(cfg.tier_models["tolo"], "missing-alias/gpt-4o")
        errors = validate_config(cfg)
        self.assertEqual(errors, [])


class TestProvidersConfigRoundtripDefaults(unittest.TestCase):

    def test_asdict_config_writes_providers(self):
        data = asdict(Config())
        self.assertIn("providers", data)
        self.assertEqual(
            data["providers"]["default"]["base_url"], "https://opencode.ai/zen/go/v1"
        )


if __name__ == "__main__":
    unittest.main()
