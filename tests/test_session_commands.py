"""Tests for the `/model` picker construction (unit U5).

Covers R7, R10 (see
docs/plans/2026-06-18-001-feat-multi-provider-support-plan.md).

Pattern mirrors `tests/test_providers_config.py` and `tests/test_mcp_config.py`:
`unittest.TestCase` classes that exercise the construction helper as a pure
function, with `resolve_model_metadata` mocked to avoid litellm/network
calls. One integration-style case (`TestExecuteCommandEmptyConfig`) drives the
`/model` dispatch path via `execute_command` with a mock `app`.
"""
import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from stupidex.commands.session_commands import (
    _build_model_picker_items,
    _format_model_label,
    execute_command,
)
from stupidex.config import Config


def _meta(
    max_in: int | None = None,
    max_out: int | None = None,
    supports_vision: bool = False,
    mode: str = "chat",
) -> dict:
    """Build the resolved-metadata dict shape returned by `resolve_model_metadata`."""
    return {
        "max_input_tokens": max_in,
        "max_output_tokens": max_out,
        "supports_vision": supports_vision,
        "mode": mode,
    }


_RESOLVER = "stupidex.commands.session_commands.resolve_model_metadata"
_GET_CONFIG = "stupidex.commands.session_commands.get_config"
_DISCOVER = "stupidex.commands.session_commands.discover_provider_models"


class TestBuildModelPickerItems(unittest.TestCase):
    """Pure-function tests for the picker-item construction helper (scenarios 1-9)."""

    def _cfg(self, providers: dict) -> Config:
        return Config(providers=providers)

    # ------------------------------------------------------------------
    # Scenarios 1 + 2: happy paths
    # ------------------------------------------------------------------

    def test_happy_path_two_providers_one_model_each(self):
        """Scenario 1: two providers, one model each -- 2 picker items, fully labeled."""
        cfg = self._cfg(
            {
                "work-openai": {"models": {"gpt-4o": {}}},
                "anthropic-prod": {"models": {"claude-3-opus": {}}},
            }
        )

        def fake_resolver(alias: str, model_id: str) -> dict:
            if (alias, model_id) == ("work-openai", "gpt-4o"):
                return _meta(max_in=128000, max_out=16384, supports_vision=True)
            if (alias, model_id) == ("anthropic-prod", "claude-3-opus"):
                return _meta(max_in=200000, max_out=4096)
            raise AssertionError(f"unexpected resolver call: ({alias!r}, {model_id!r})")

        with patch(_RESOLVER, side_effect=fake_resolver) as mock:
            items = _build_model_picker_items(cfg)

        self.assertEqual(len(items), 2)
        self.assertEqual(items[0].id, "work-openai/gpt-4o")
        self.assertEqual(items[1].id, "anthropic-prod/claude-3-opus")
        # Label is tabular: model_ref + token shorthand + yes/no vision.
        self.assertIn("work-openai/gpt-4o", items[0].label)
        self.assertIn("128k", items[0].label)
        self.assertIn("16k", items[0].label)
        self.assertIn("yes", items[0].label)  # supports_vision=True
        self.assertIn("anthropic-prod/claude-3-opus", items[1].label)
        self.assertIn("200k", items[1].label)
        self.assertIn("4k", items[1].label)
        self.assertIn("no", items[1].label)  # supports_vision default False
        mock.assert_any_call("work-openai", "gpt-4o")
        mock.assert_any_call("anthropic-prod", "claude-3-opus")

    def test_covers_ae5_multiple_providers_multiple_models(self):
        """Scenario 2 (covers AE5): two providers, three models; tokens + vision on each."""
        cfg = self._cfg(
            {
                "work-openai": {"models": {"gpt-4o": {}, "gpt-4o-mini": {}}},
                "anthropic-prod": {"models": {"claude-3-opus": {}}},
            }
        )
        responses = {
            ("work-openai", "gpt-4o"): _meta(max_in=128000, max_out=16384, supports_vision=True),
            ("work-openai", "gpt-4o-mini"): _meta(max_in=128000, max_out=16384, supports_vision=True),
            ("anthropic-prod", "claude-3-opus"): _meta(max_in=200000, max_out=4096, supports_vision=True),
        }

        def fake_resolver(alias: str, model_id: str) -> dict:
            return responses[(alias, model_id)]

        with patch(_RESOLVER, side_effect=fake_resolver):
            items = _build_model_picker_items(cfg)

        self.assertEqual(len(items), 3)
        self.assertEqual(
            [item.id for item in items],
            [
                "work-openai/gpt-4o",
                "work-openai/gpt-4o-mini",
                "anthropic-prod/claude-3-opus",
            ],
        )
        # Each label carries both token shorthands and a vision indicator.
        for item in items:
            self.assertIn("yes", item.label)
        self.assertIn("128k", items[0].label)
        self.assertIn("16k", items[0].label)
        self.assertIn("200k", items[2].label)
        self.assertIn("4k", items[2].label)

    # ------------------------------------------------------------------
    # Scenarios 3 + 4: capability columns
    # ------------------------------------------------------------------

    def test_vision_yes_shown_when_supported(self):
        """Scenario 3: supports_vision=True -> 'yes' appears in label."""
        cfg = self._cfg({"p1": {"models": {"m1": {}}}})
        with patch(_RESOLVER, return_value=_meta(supports_vision=True)):
            items = _build_model_picker_items(cfg)
        self.assertEqual(len(items), 1)
        self.assertIn("yes", items[0].label)
        self.assertNotIn("no", items[0].label)

    def test_vision_no_shown_when_unsupported(self):
        """Scenario 3: supports_vision=False -> 'no' appears in label."""
        cfg = self._cfg({"p1": {"models": {"m1": {}}}})
        with patch(_RESOLVER, return_value=_meta(supports_vision=False)):
            items = _build_model_picker_items(cfg)
        self.assertEqual(len(items), 1)
        self.assertIn("no", items[0].label)
        self.assertNotIn("yes", items[0].label)

    # ------------------------------------------------------------------
    # Scenarios 5 + 6: token shorthand
    # ------------------------------------------------------------------

    def test_token_shorthand_rendered_when_both_int(self):
        """Scenario 5: max_input=128000, max_output=16384 -> shorthands appear in label."""
        cfg = self._cfg({"p1": {"models": {"m1": {}}}})
        with patch(_RESOLVER, return_value=_meta(max_in=128000, max_out=16384)):
            items = _build_model_picker_items(cfg)
        self.assertIn("128k", items[0].label)
        self.assertIn("16k", items[0].label)
        self.assertNotIn("n/a", items[0].label)

    def test_na_rendered_when_max_in_none(self):
        """Scenario 6: max_input_tokens=None -> 'n/a' shown in input column."""
        cfg = self._cfg({"p1": {"models": {"m1": {}}}})
        with patch(_RESOLVER, return_value=_meta(max_in=None, max_out=16384)):
            items = _build_model_picker_items(cfg)
        self.assertIn("n/a", items[0].label)
        self.assertIn("16k", items[0].label)  # output still rendered
        self.assertNotIn("None", items[0].label)

    def test_na_rendered_when_max_out_none(self):
        """Scenario 6: max_output_tokens=None -> 'n/a' shown in output column."""
        cfg = self._cfg({"p1": {"models": {"m1": {}}}})
        with patch(_RESOLVER, return_value=_meta(max_in=128000, max_out=None)):
            items = _build_model_picker_items(cfg)
        self.assertIn("n/a", items[0].label)
        self.assertIn("128k", items[0].label)
        self.assertNotIn("None", items[0].label)

    def test_na_rendered_when_both_none(self):
        """Scenario 6: both limits None -> 'n/a' shown for both columns."""
        cfg = self._cfg({"p1": {"models": {"m1": {}}}})
        with patch(_RESOLVER, return_value=_meta(max_in=None, max_out=None)):
            items = _build_model_picker_items(cfg)
        # Both columns render 'n/a' -- the string appears at least twice.
        self.assertEqual(items[0].label.count("n/a"), 2)

    # ------------------------------------------------------------------
    # Scenario 7: empty models
    # ------------------------------------------------------------------

    def test_empty_models_dict_contributes_no_items(self):
        """Scenario 7: a provider with models={} contributes nothing; others still appear."""
        cfg = self._cfg(
            {
                "work-openai": {"models": {}},
                "anthropic-prod": {"models": {"claude-3-opus": {}}},
            }
        )
        with patch(_RESOLVER, return_value=_meta()):
            items = _build_model_picker_items(cfg)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].id, "anthropic-prod/claude-3-opus")

    def test_all_providers_empty_models_produces_empty_list(self):
        """Scenario 7 (alt): every provider's models dict empty -> empty list (no exception)."""
        cfg = self._cfg(
            {
                "work-openai": {"models": {}},
                "local": {"models": {}},
            }
        )
        with patch(_RESOLVER) as mock_resolver:
            items = _build_model_picker_items(cfg)
        self.assertEqual(items, [])
        mock_resolver.assert_not_called()

    # ------------------------------------------------------------------
    # Scenario 8: id format
    # ------------------------------------------------------------------

    def test_id_format_is_alias_slash_model_with_no_badges(self):
        """Scenario 8: PickerItem.id is exactly 'alias/model' (no badges or tokens)."""
        cfg = self._cfg({"work-openai": {"models": {"gpt-4o": {}}}})
        with patch(
            _RESOLVER,
            return_value=_meta(max_in=128000, max_out=16384, supports_vision=True),
        ):
            items = _build_model_picker_items(cfg)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].id, "work-openai/gpt-4o")
        # ID must be badge-free -- this is what `change_model` stores.
        self.assertNotIn("[", items[0].id)
        self.assertNotIn("→", items[0].id)

    # ------------------------------------------------------------------
    # Scenario 9: resolver integration
    # ------------------------------------------------------------------

    def test_resolver_called_with_alias_and_model_id(self):
        """Scenario 9: resolve_model_metadata is called with (alias, model_id) per entry."""
        cfg = self._cfg(
            {
                "work-openai": {"models": {"gpt-4o": {}, "gpt-4o-mini": {}}},
                "local": {"models": {"llama-70b": {}}},
            }
        )
        with patch(_RESOLVER, return_value=_meta()) as mock:
            _build_model_picker_items(cfg)

        mock.assert_any_call("work-openai", "gpt-4o")
        mock.assert_any_call("work-openai", "gpt-4o-mini")
        mock.assert_any_call("local", "llama-70b")
        self.assertEqual(mock.call_count, 3)

    # ------------------------------------------------------------------
    # Defensive: resolver failure
    # ------------------------------------------------------------------

    def test_resolver_exception_skips_model_keeps_others(self):
        """Defensive: a model whose resolver raises is skipped; the rest remain."""
        cfg = self._cfg(
            {
                "work-openai": {
                    "models": {"gpt-4o": {}, "broken-model": {}, "gpt-4o-mini": {}}
                }
            }
        )

        def fake_resolver(alias: str, model_id: str) -> dict:
            if model_id == "broken-model":
                raise RuntimeError("simulated resolver failure")
            return _meta()

        with patch(_RESOLVER, side_effect=fake_resolver):
            items = _build_model_picker_items(cfg)

        self.assertEqual(
            [item.id for item in items],
            ["work-openai/gpt-4o", "work-openai/gpt-4o-mini"],
        )

    def test_non_dict_provider_entry_is_skipped(self):
        """Defensive: a non-dict provider entry is skipped without raising."""
        cfg = self._cfg(
            {
                "broken": "not-a-dict",  # type: ignore[dict-item]
                "ok": {"models": {"m1": {}}},
            }
        )
        with patch(_RESOLVER, return_value=_meta()):
            items = _build_model_picker_items(cfg)
        self.assertEqual([item.id for item in items], ["ok/m1"])

    def test_non_dict_models_field_is_skipped(self):
        """Defensive: a provider whose 'models' field is not a dict is skipped."""
        cfg = self._cfg(
            {
                "broken": {"models": "not-a-dict"},  # type: ignore[dict-item]
                "ok": {"models": {"m1": {}}},
            }
        )
        with patch(_RESOLVER, return_value=_meta()):
            items = _build_model_picker_items(cfg)
        self.assertEqual([item.id for item in items], ["ok/m1"])


class TestBuildModelPickerItemsDiscovery(unittest.TestCase):
    """Hybrid fallback (R10): undeclared models trigger GET /models discovery."""

    def _cfg(self, providers: dict) -> Config:
        return Config(providers=providers)

    def test_empty_models_dict_triggers_discovery(self):
        """Provider with no declared models falls back to endpoint discovery."""
        cfg = self._cfg({
            "openai-prod": {
                "base_url": "https://api.openai.com/v1",
                "litellm_provider": "openai",
                "api_key": "sk-test",
            }
        })
        with (
            patch(_DISCOVER, return_value=["gpt-4o", "gpt-4o-mini"]),
            patch(_RESOLVER, return_value=_meta()),
        ):
            items = _build_model_picker_items(cfg)
        ids = [i.id for i in items]
        self.assertEqual(ids, ["openai-prod/gpt-4o", "openai-prod/gpt-4o-mini"])

    def test_declared_models_skip_discovery(self):
        """When models are declared, the GET /models endpoint is never hit."""
        cfg = self._cfg({
            "openai-prod": {
                "base_url": "https://api.openai.com/v1",
                "models": {"gpt-4o": {}},
            }
        })
        with patch(_DISCOVER) as mock_discover, patch(_RESOLVER, return_value=_meta()):
            _build_model_picker_items(cfg)
        mock_discover.assert_not_called()

    def test_discovery_returns_empty_skips_provider_silently(self):
        """Empty discovery result = no items for that provider, no raise."""
        cfg = self._cfg({
            "dead-endpoint": {
                "base_url": "http://localhost:9999/v1",
                "litellm_provider": "openai",
            },
            "ok": {"models": {"m1": {}}},
        })
        with (
            patch(_DISCOVER, return_value=[]),
            patch(_RESOLVER, return_value=_meta()),
        ):
            items = _build_model_picker_items(cfg)
        self.assertEqual([item.id for item in items], ["ok/m1"])

    def test_discovery_failure_swallowed_silently(self):
        """If discovery raises, that provider is skipped, others still appear."""
        cfg = self._cfg({
            "broken": {"base_url": "http://example.com"},
            "ok": {"models": {"m1": {}}},
        })
        with (
            patch(_DISCOVER, side_effect=RuntimeError("boom")),
            patch(_RESOLVER, return_value=_meta()),
        ):
            items = _build_model_picker_items(cfg)
        self.assertEqual([item.id for item in items], ["ok/m1"])


class TestFormatModelLabel(unittest.TestCase):
    """Direct unit tests for the label formatter (covers each column combination)."""

    def test_no_metadata_renders_na_and_no(self):
        """All fields absent: 'no' for vision, 'n/a' for both token columns."""
        label = _format_model_label(
            "p1", "m1", _meta(supports_vision=False, mode="embedding")
        )
        self.assertIn("p1/m1", label)
        self.assertIn("n/a", label)
        self.assertIn("no", label)
        self.assertNotIn("yes", label)

    def test_vision_yes_shown_when_supported(self):
        """supports_vision=True -> 'yes' renders in the vision column."""
        label = _format_model_label(
            "p1", "m1", _meta(supports_vision=True, mode="embedding")
        )
        self.assertIn("yes", label)
        self.assertNotIn("no", label)

    def test_tokens_rendered_when_present(self):
        """Both max_input_tokens + max_output_tokens present -> shorthand formatted."""
        label = _format_model_label(
            "p1",
            "m1",
            _meta(max_in=128000, max_out=16384, supports_vision=False, mode="embedding"),
        )
        self.assertIn("128k", label)
        self.assertIn("16k", label)
        self.assertNotIn("n/a", label)

    def test_full_label_with_all_fields(self):
        """Happy path: alias, model_id, max_in, max_out, vision all populated."""
        label = _format_model_label(
            "work-openai",
            "gpt-4o",
            _meta(max_in=128000, max_out=16384, supports_vision=True, mode="chat"),
        )
        self.assertIn("work-openai/gpt-4o", label)
        self.assertIn("128k", label)
        self.assertIn("16k", label)
        self.assertIn("yes", label)

    def test_token_shorthand_sub_1000(self):
        """Sub-1000 token counts render as plain decimals (no 'k' misrepresentation)."""
        label = _format_model_label(
            "p1",
            "m1",
            _meta(
                max_in=500,
                max_out=200,
                supports_vision=False,
                mode="embedding",
            ),
        )
        self.assertIn("500", label)
        self.assertIn("200", label)
        self.assertNotIn("500k", label)
        self.assertNotIn("200k", label)

    def test_long_model_ref_is_truncated_with_ellipsis(self):
        """A model ref wider than the column width is truncated with an ellipsis char.

        The truncated prefix + ellipsis must fit in `_MODEL_COL_REF_WIDTH`; the
        full ref is preserved on the PickerItem.id (not the label).
        """
        from stupidex.commands.session_commands import _MODEL_COL_REF_WIDTH

        long_alias = "very-long-alias-name-that-exceeds-the-column"
        long_model = "model-with-an-exceptionally-long-identifier"
        label = _format_model_label(long_alias, long_model, _meta())
        # Truncated to the column width including the ellipsis character.
        ref_part = label.split(" ")[0]  # everything up to the first space
        self.assertEqual(len(ref_part), _MODEL_COL_REF_WIDTH)
        self.assertTrue(ref_part.endswith("\u2026"))
        self.assertIn(long_alias[:10], ref_part)


class TestModelPickerHeader(unittest.TestCase):
    """Verify the column-titles header is built with the right widths + labels."""

    def test_header_contains_column_titles(self):
        from stupidex.commands.session_commands import _MODEL_PICKER_HEADER

        self.assertIn("Model", _MODEL_PICKER_HEADER)
        self.assertIn("In", _MODEL_PICKER_HEADER)
        self.assertIn("Out", _MODEL_PICKER_HEADER)
        self.assertIn("Vision", _MODEL_PICKER_HEADER)

    def test_header_width_matches_label_width(self):
        """Header and label rows share the same column widths so they align."""
        from stupidex.commands.session_commands import _MODEL_PICKER_HEADER

        label = _format_model_label("p1", "m1", _meta())
        # Strip trailing whitespace for an exact comparison (both end together).
        self.assertEqual(len(_MODEL_PICKER_HEADER.rstrip()), len(label.rstrip()))


class TestExecuteCommandEmptyConfig(unittest.TestCase):
    """Integration-style tests for the `/model` dispatch path on empty configs."""

    def test_empty_providers_notifies_warning_and_does_not_push(self):
        """Scenario 7: empty providers dict -> 'No models configured' notify, no push_screen."""
        cfg = Config(providers={})
        app = MagicMock()
        with patch(_GET_CONFIG, return_value=cfg):
            asyncio.run(execute_command(app, "/model"))
        app.notify.assert_called_once_with(
            "No models configured. Add providers to your config.",
            severity="warning",
        )
        app.push_screen.assert_not_called()

    def test_all_empty_model_dicts_notifies_warning(self):
        """Scenario 7 (alt): providers present but every models dict empty -> still notifies."""
        cfg = Config(
            providers={
                "work-openai": {"models": {}},
                "local": {"models": {}},
            }
        )
        app = MagicMock()
        with patch(_GET_CONFIG, return_value=cfg), patch(_RESOLVER) as mock_resolver:
            asyncio.run(execute_command(app, "/model"))
        # Resolver is never consulted when no models exist.
        mock_resolver.assert_not_called()
        app.notify.assert_called_once()
        self.assertEqual(
            app.notify.call_args.args[0],
            "No models configured. Add providers to your config.",
        )
        self.assertEqual(app.notify.call_args.kwargs["severity"], "warning")
        app.push_screen.assert_not_called()

    def test_non_empty_config_pushes_picker(self):
        """Happy path: a non-empty config pushes OptionPicker (resolver mocked)."""
        cfg = Config(providers={"p1": {"models": {"m1": {}}}})
        app = MagicMock()
        # `rerender_footer` is awaited inside `on_picked`; MagicMock is not awaitable.
        app.rerender_footer = AsyncMock()
        with patch(_GET_CONFIG, return_value=cfg), patch(
            _RESOLVER, return_value=_meta()
        ):
            asyncio.run(execute_command(app, "/model"))
        app.notify.assert_not_called()
        app.push_screen.assert_called_once()
        # The pushed OptionPicker carries one item with id 'p1/m1'.
        pushed_picker = app.push_screen.call_args.args[0]
        self.assertEqual(len(pushed_picker._items), 1)
        self.assertEqual(pushed_picker._items[0].id, "p1/m1")
        # on_picked callback is the second positional arg; invoke it to verify wiring.
        on_picked = app.push_screen.call_args.args[1]
        asyncio.run(on_picked("p1/m1"))
        app.sessions.change_model.assert_called_once_with("p1/m1")
        app.rerender_footer.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
