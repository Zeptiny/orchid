"""Tests for provider resolution and metadata hydration (U2).

Covers R6, R8, R9 (see
docs/plans/2026-06-18-001-feat-multi-provider-support-plan.md, unit U2).

Pattern mirrors `tests/test_providers_config.py` (pure-function + Config
construction) and `tests/test_streaming_messages.py` (unittest.mock.patch
for litellm functions). `get_config` is patched at the import site so tests
do not touch the on-disk singleton; `_metadata_cache` is reset between tests.
"""

import os
import unittest
from unittest.mock import MagicMock, patch

import httpx
import litellm

from stupidex.config import Config
from stupidex.llm import providers as providers_mod
from stupidex.llm.providers import (
    ProviderResolutionError,
    discover_provider_models,
    reset_cache,
    resolve_embedding_ref,
    resolve_model_metadata,
    resolve_model_ref,
)

_RESERVED_ENV_KEYS = ("DEFINITELY_UNSET_TEST_ENV_VAR",)


def _cfg(providers: dict) -> Config:
    """Build a Config carrying the given provider entries."""
    return Config(providers=providers)


def _litellm_info(
    *,
    max_input: int | None = 128000,
    max_output: int | None = 16384,
    vision: bool = True,
    mode: str = "chat",
) -> dict:
    return {
        "max_input_tokens": max_input,
        "max_output_tokens": max_output,
        "supports_vision": vision,
        "mode": mode,
        "extra_field_we_should_drop": "ignored",
    }


class ProviderResolutionTestCase(unittest.TestCase):
    """Base class: resets the metadata cache and reserved env keys per test."""

    def setUp(self) -> None:
        reset_cache()
        self._saved_env = {k: os.environ.pop(k, None) for k in _RESERVED_ENV_KEYS}

    def tearDown(self) -> None:
        reset_cache()
        for k, v in self._saved_env.items():
            if v is not None:
                os.environ[k] = v
            else:
                os.environ.pop(k, None)

    def _patch_cfg(self, providers: dict):
        return patch.object(providers_mod, "get_config", return_value=_cfg(providers))


class TestResolveModelMetadata(ProviderResolutionTestCase):
    def test_happy_path_returns_litellm_registry_fields(self):
        """Scenario 1: no override -> litellm registry fields pass through."""
        providers = {
            "work-openai": {
                "litellm_provider": "openai",
                "models": {"gpt-4o": {}},
            }
        }
        with (
            self._patch_cfg(providers),
            patch.object(litellm, "get_model_info", return_value=_litellm_info()) as mock_info,
        ):
            result = resolve_model_metadata("work-openai", "gpt-4o")

        self.assertEqual(
            result,
            {
                "max_input_tokens": 128000,
                "max_output_tokens": 16384,
                "supports_vision": True,
                "mode": "chat",
            },
        )
        mock_info.assert_called_once_with("openai/gpt-4o")

    def test_override_wins_over_litellm_registry(self):
        """Scenario 2 (AE2): partial override fills registry on the rest."""
        providers = {
            "work-openai": {
                "litellm_provider": "openai",
                "models": {"gpt-4o": {"max_input_tokens": 32768}},
            }
        }
        with (
            self._patch_cfg(providers),
            patch.object(litellm, "get_model_info", return_value=_litellm_info()) as mock_info,
        ):
            result = resolve_model_metadata("work-openai", "gpt-4o")

        self.assertEqual(result["max_input_tokens"], 32768)  # override wins
        self.assertEqual(result["max_output_tokens"], 16384)  # registry fills
        self.assertIs(result["supports_vision"], True)
        self.assertEqual(result["mode"], "chat")
        mock_info.assert_called_once_with("openai/gpt-4o")

    def test_litellm_raises_falls_back_to_default(self):
        """Scenario 3 (AE3): litellm raises -> user fields + text-only defaults."""
        providers = {
            "local-llama": {
                "litellm_provider": "openai",
                "models": {"local-llama-70b": {"max_input_tokens": 8192}},
            }
        }
        with (
            self._patch_cfg(providers),
            patch.object(litellm, "get_model_info", side_effect=ValueError("not mapped")),
        ):
            result = resolve_model_metadata("local-llama", "local-llama-70b")

        self.assertEqual(result["max_input_tokens"], 8192)  # user-supplied
        self.assertIsNone(result["max_output_tokens"])  # default
        self.assertIs(result["supports_vision"], False)  # default
        self.assertEqual(result["mode"], "chat")  # default
        self.assertEqual(set(result), {"max_input_tokens", "max_output_tokens", "supports_vision", "mode"})

    def test_litellm_provider_unset_uses_bare_model_id(self):
        """Scenario 4: provider without litellm_provider -> bare model_id query."""
        providers = {
            "custom": {
                "models": {"some-model": {}},
            }
        }
        with (
            self._patch_cfg(providers),
            patch.object(litellm, "get_model_info", return_value=_litellm_info(vision=False)) as mock_info,
        ):
            result = resolve_model_metadata("custom", "some-model")

        mock_info.assert_called_once_with("some-model")
        self.assertIs(result["supports_vision"], False)

    def test_unknown_alias_metadata_returns_text_only_default(self):
        """Scenario 11: unknown alias never raises; returns default; bare model query."""
        with (
            self._patch_cfg({}),
            patch.object(litellm, "get_model_info", side_effect=Exception("unmapped")) as mock_info,
        ):
            result = resolve_model_metadata("ghost", "anything")

        self.assertEqual(
            result,
            {
                "max_input_tokens": None,
                "max_output_tokens": None,
                "supports_vision": False,
                "mode": "chat",
            },
        )
        mock_info.assert_called_once_with("anything")

    def test_metadata_caches_second_call_skips_litellm(self):
        """Scenario 12: second call for the same pair reuses the cached result."""
        providers = {
            "work-openai": {
                "litellm_provider": "openai",
                "models": {"gpt-4o": {}},
            }
        }
        with (
            self._patch_cfg(providers),
            patch.object(litellm, "get_model_info", return_value=_litellm_info()) as mock_info,
        ):
            first = resolve_model_metadata("work-openai", "gpt-4o")
            second = resolve_model_metadata("work-openai", "gpt-4o")

        self.assertIs(first, second)
        mock_info.assert_called_once()

    def test_reset_cache_requeries_litellm(self):
        """Scenario 13: reset_cache() between calls -> litellm queried twice."""
        providers = {
            "work-openai": {
                "litellm_provider": "openai",
                "models": {"gpt-4o": {}},
            }
        }
        with (
            self._patch_cfg(providers),
            patch.object(litellm, "get_model_info", return_value=_litellm_info()) as mock_info,
        ):
            resolve_model_metadata("work-openai", "gpt-4o")
            reset_cache()
            resolve_model_metadata("work-openai", "gpt-4o")

        self.assertEqual(mock_info.call_count, 2)


class TestResolveModelRef(ProviderResolutionTestCase):
    def test_unknown_alias_raises(self):
        """Scenario 5: unknown alias -> ProviderResolutionError naming the alias."""
        with self._patch_cfg({}), self.assertRaises(ProviderResolutionError) as ctx:
            resolve_model_ref("nonexistent/model")

        self.assertIn("nonexistent", str(ctx.exception))

    def test_no_slash_raises(self):
        """Scenario 10: missing '/' -> ProviderResolutionError."""
        with self._patch_cfg({}), self.assertRaises(ProviderResolutionError):
            resolve_model_ref("gpt-4o")

    def test_undeclared_model_resolves_successfully(self):
        """Scenario 6: model not in provider['models'] still resolves."""
        providers = {
            "work-openai": {
                "litellm_provider": "openai",
                "base_url": "https://api.openai.com/v1",
                "api_key": "sk-test",
                "models": {"gpt-4o": {}},  # gpt-4o-mini NOT declared
            }
        }
        with self._patch_cfg(providers):
            resolved = resolve_model_ref("work-openai/gpt-4o-mini")

        self.assertEqual(resolved, ("openai", "gpt-4o-mini", "https://api.openai.com/v1", "sk-test"))

    def test_undeclared_model_metadata_falls_through(self):
        """Scenario 6 (metadata half): undeclared model -> text-only default."""
        providers = {
            "work-openai": {
                "litellm_provider": "openai",
                "models": {"gpt-4o": {}},
            }
        }
        with (
            self._patch_cfg(providers),
            patch.object(litellm, "get_model_info", side_effect=Exception("unmapped")),
        ):
            result = resolve_model_metadata("work-openai", "gpt-4o-mini")

        self.assertEqual(result["max_input_tokens"], None)
        self.assertEqual(result["mode"], "chat")

    def test_api_key_env_unset_returns_none(self):
        """Scenario 14: api_key_env pointing at an unset var -> api_key=None (no raise)."""
        providers = {
            "work-openai": {
                "litellm_provider": "openai",
                "api_key_env": "DEFINITELY_UNSET_TEST_ENV_VAR",
            }
        }
        self.assertNotIn("DEFINITELY_UNSET_TEST_ENV_VAR", os.environ)
        with self._patch_cfg(providers):
            resolved = resolve_model_ref("work-openai/gpt-4o")

        litellm_provider, model_id, base_url, api_key = resolved
        self.assertEqual(litellm_provider, "openai")
        self.assertEqual(model_id, "gpt-4o")
        self.assertEqual(base_url, "")
        self.assertIsNone(api_key)

    def test_api_key_env_set_returns_env_value(self):
        """Bonus: api_key_env pointing at a set var -> api_key is the env value."""
        os.environ["DEFINITELY_UNSET_TEST_ENV_VAR"] = "sk-from-env"
        providers = {
            "work-openai": {
                "litellm_provider": "openai",
                "api_key_env": "DEFINITELY_UNSET_TEST_ENV_VAR",
            }
        }
        with self._patch_cfg(providers):
            resolved = resolve_model_ref("work-openai/gpt-4o")

        self.assertEqual(resolved[3], "sk-from-env")


class TestResolveEmbeddingRef(ProviderResolutionTestCase):
    def test_fastembed_short_circuit(self):
        """Scenario 7: fastembed/<id> -> ('fastembed', <id>); no provider/litellm."""
        with patch.object(litellm, "get_model_info") as mock_info:
            result = resolve_embedding_ref("fastembed/BAAI/bge-small-en-v1.5")

        self.assertEqual(result, ("fastembed", "BAAI/bge-small-en-v1.5"))
        mock_info.assert_not_called()

    def test_fastembed_no_model_id_raises(self):
        """Scenario 9: bare 'fastembed' -> ProviderResolutionError."""
        with self.assertRaises(ProviderResolutionError):
            resolve_embedding_ref("fastembed")
        with self.assertRaises(ProviderResolutionError):
            resolve_embedding_ref("fastembed/")

    def test_litellm_path_matches_resolve_model_ref(self):
        """Scenario 8: embedding ref via a real provider == resolve_model_ref."""
        providers = {
            "work-openai": {
                "litellm_provider": "openai",
                "base_url": "https://api.openai.com/v1",
                "api_key": "sk-test",
                "models": {"text-embedding-3-small": {}},
            }
        }
        with self._patch_cfg(providers):
            embedding = resolve_embedding_ref("work-openai/text-embedding-3-small")
            direct = resolve_model_ref("work-openai/text-embedding-3-small")

        self.assertEqual(embedding, direct)
        self.assertEqual(embedding, ("openai", "text-embedding-3-small", "https://api.openai.com/v1", "sk-test"))


class TestDefaultConfigIntegration(ProviderResolutionTestCase):
    """Light integration: the shipped default config resolves without crashing."""

    def test_default_provider_default_model_resolves(self):
        """Verification: resolve_model_metadata('default', 'mimo-v2.5') returns the 4 fields."""
        with (
            patch.object(providers_mod, "get_config", return_value=Config()),
            patch.object(litellm, "get_model_info", side_effect=Exception("mimo-v2.5 unmapped")),
        ):
            result = resolve_model_metadata("default", "mimo-v2.5")

        self.assertEqual(
            result,
            {
                "max_input_tokens": None,
                "max_output_tokens": None,
                "supports_vision": False,
                "mode": "chat",
            },
        )


class TestDiscoverProviderModels(ProviderResolutionTestCase):
    """Hybrid fallback: GET /models discovery for providers without declared `models`."""

    _PROVIDERS = {
        "openai-prod": {
            "base_url": "https://api.openai.com/v1",
            "litellm_provider": "openai",
            "api_key": "sk-test",
        },
        "no-url": {
            "litellm_provider": "anthropic",
            "api_key_env": "DEFINITELY_UNSET_TEST_ENV_VAR",
        },
    }

    def _patch_providers(self):
        """Local variant: this class always uses `_PROVIDERS` (overriding base signature)."""
        return patch.object(providers_mod, "get_config", return_value=_cfg(self._PROVIDERS))

    def _patch_httpx(self, fake_client):
        """Patch the httpx module on providers_mod so `httpx.Client(...)` returns our mock."""
        return patch.object(providers_mod, "httpx", MagicMock(Client=MagicMock(return_value=fake_client)))

    def _fake_response(self, model_ids: list[str]):
        fake = MagicMock()
        fake.raise_for_status.return_value = None
        fake.json.return_value = {"data": [{"id": mid} for mid in model_ids]}
        return fake

    def _fake_client(self, response=None, side_effect=None):
        client = MagicMock()
        client.__enter__.return_value = client
        client.__exit__.return_value = None
        if side_effect is not None:
            client.get.side_effect = side_effect
        else:
            client.get.return_value = response or self._fake_response([])
        return client

    def test_unknown_alias_raises(self):
        """Discovery propagates ProviderResolutionError for bad aliases."""
        with self._patch_providers(), self.assertRaises(ProviderResolutionError):
            discover_provider_models("does-not-exist")

    def test_provider_without_base_url_returns_empty(self):
        """Providers with no base_url (e.g. native anthropic) cannot discover."""
        with self._patch_providers():
            self.assertEqual(discover_provider_models("no-url"), [])

    def test_successful_discovery_returns_model_ids(self):
        """Happy path: GET /models returns {"data": [{"id": ...}, ...]}."""
        client = self._fake_client(self._fake_response(["gpt-4o", "gpt-4o-mini", "text-embedding-3-small"]))
        with self._patch_providers(), self._patch_httpx(client):
            result = discover_provider_models("openai-prod")
        self.assertEqual(result, ["gpt-4o", "gpt-4o-mini", "text-embedding-3-small"])

    def test_discovery_passes_api_key_in_authorization_header(self):
        """Resolved api_key becomes a Bearer header (OpenAI-compatible endpoints require it)."""
        client = self._fake_client(self._fake_response([]))
        with self._patch_providers(), self._patch_httpx(client):
            discover_provider_models("openai-prod")
        headers = client.get.call_args.kwargs.get("headers", {})
        self.assertEqual(headers.get("Authorization"), "Bearer sk-test")

    def test_discovery_skips_authorization_when_api_key_missing(self):
        """When api_key resolves to None, no Authorization header is set."""
        providers = {
            "local": {"base_url": "http://localhost:11434/v1", "litellm_provider": "openai"},
        }
        client = self._fake_client(self._fake_response(["llama3.1"]))
        with patch.object(providers_mod, "get_config", return_value=_cfg(providers)), self._patch_httpx(client):
            result = discover_provider_models("local")
        self.assertEqual(result, ["llama3.1"])
        headers = client.get.call_args.kwargs.get("headers", {})
        self.assertNotIn("Authorization", headers)

    def test_network_failure_returns_empty_list(self):
        """Any exception (timeout, 401, malformed JSON) -> empty list, no raise."""
        client = self._fake_client(side_effect=httpx.ConnectError("server down"))
        with self._patch_providers(), self._patch_httpx(client):
            result = discover_provider_models("openai-prod")
        self.assertEqual(result, [])

    def test_discovered_models_are_cached(self):
        """Second call within session returns cached list (no second HTTP call)."""
        client = self._fake_client(self._fake_response(["gpt-4o"]))
        with self._patch_providers(), self._patch_httpx(client):
            first = discover_provider_models("openai-prod")
            second = discover_provider_models("openai-prod")
        self.assertEqual(first, ["gpt-4o"])
        self.assertEqual(second, ["gpt-4o"])
        self.assertEqual(client.get.call_count, 1)

    def test_force_refetch_bypasses_cache(self):
        """force=True triggers a new HTTP call even if cached."""
        client = self._fake_client(self._fake_response(["gpt-4o"]))
        with self._patch_providers(), self._patch_httpx(client):
            discover_provider_models("openai-prod")
            discover_provider_models("openai-prod", force=True)
        self.assertEqual(client.get.call_count, 2)

    def test_env_disable_flag_short_circuits_to_empty(self):
        """STUPIDEX_DISABLE_MODEL_DISCOVERY=true short-circuits discovery, no HTTP call."""
        client = self._fake_client(self._fake_response(["gpt-4o"]))
        with self._patch_providers(), self._patch_httpx(client), patch.dict(os.environ, {"STUPIDEX_DISABLE_MODEL_DISCOVERY": "true"}):
            result = discover_provider_models("openai-prod")
        self.assertEqual(result, [])
        client.get.assert_not_called()

    def test_malformed_response_yields_empty_list(self):
        """Missing 'data' key or non-dict entries return empty, not crash."""
        fake = MagicMock()
        fake.raise_for_status.return_value = None
        fake.json.return_value = {"unexpected": "shape"}
        client = self._fake_client(fake)
        with self._patch_providers(), self._patch_httpx(client):
            result = discover_provider_models("openai-prod")
        self.assertEqual(result, [])

    def test_reset_cache_clears_discovery_cache(self):
        """reset_cache() invalidates both metadata and discovery caches."""
        client = self._fake_client(self._fake_response(["gpt-4o"]))
        with self._patch_providers(), self._patch_httpx(client):
            discover_provider_models("openai-prod")
            reset_cache()
            discover_provider_models("openai-prod")
        self.assertEqual(client.get.call_count, 2)


if __name__ == "__main__":
    unittest.main()
