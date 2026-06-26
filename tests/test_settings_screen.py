"""Tests for the SettingsScreen modal, NewProviderForm, and NewMCPServerForm."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, PropertyMock, patch

import pytest
from textual.widgets import Button, Input, Select

from stupidex.config import (
    Config,
    ConfigManager,
    RAGConfig,
    _convert_from_dict,
    validate_config,
)
from stupidex.screens.picker import OptionPicker, PickerItem
from stupidex.screens.settings import NewMCPServerForm, NewProviderForm, SettingsScreen

# ── _convert_from_dict ───────────────────────────────────────────────────────


class TestConvertFromDict:
    def test_flat_rag_fields_are_not_converted(self):
        """No backward compatibility: legacy flat RAG fields pass through
        unchanged and are NOT synthesized into a nested `rag` key. They are
        later ignored by ConfigManager.load (unknown top-level keys), so the
        RAG config falls back to RAGConfig defaults."""
        data = {
            "rag_chunk_size": 1000,
            "rag_chunk_overlap": 100,
            "rag_top_k": 10,
            "rag_max_file_size": 99999,
            "rag_embedding_model": "test/model",
            "default_model": "default/test",
        }
        result = _convert_from_dict(data)
        # Flat keys remain as-is (no conversion to nested `rag`)
        assert result["rag_chunk_size"] == 1000
        assert result["rag_top_k"] == 10
        assert "rag" not in result
        assert result["default_model"] == "default/test"

    def test_nested_rag_preserved_flat_not_removed(self):
        """Nested `rag` is preserved; legacy flat keys are NOT stripped
        (no special-case handling). They are simply ignored downstream by
        ConfigManager.load since they don't match a Config field."""
        data = {
            "rag": {"chunk_size": 500, "embedding_model": "new/model"},
            "rag_chunk_size": 999,
        }
        result = _convert_from_dict(data)
        assert result["rag"]["chunk_size"] == 500
        assert result["rag"]["embedding_model"] == "new/model"
        # Flat key is NOT removed (no backward-compat stripping)
        assert result["rag_chunk_size"] == 999

    def test_no_rag_data_leaves_absent(self):
        result = _convert_from_dict({"default_model": "test/model"})
        assert "rag" not in result

    def test_empty_dict_has_no_rag(self):
        result = _convert_from_dict({})
        assert "rag" not in result

    def test_flat_none_values_handled(self):
        data = {"rag_chunk_size": None, "default_model": "test/model"}
        result = _convert_from_dict(data)
        # None values stripped; no `rag` synthesized from flat fields
        assert "rag_chunk_size" not in result
        assert "rag" not in result
        assert result["default_model"] == "test/model"


# ── validate_config (new RAG edge cases) ─────────────────────────────────────


class TestValidateConfigRAGEdgeCases:
    def test_rag_chunk_overlap_negative_is_error(self):
        cfg = Config(rag=RAGConfig(chunk_overlap=-5))
        errors = validate_config(cfg)
        assert any("chunk_overlap" in e for e in errors)

    def test_rag_embedding_model_empty_string_is_error(self):
        cfg = Config(rag=RAGConfig(embedding_model=""))
        errors = validate_config(cfg)
        assert any("embedding_model" in e for e in errors)

    def test_rag_not_an_object_is_error(self):
        cfg = Config(rag="not-a-ragconfig")  # type: ignore[assignment]
        errors = validate_config(cfg)
        assert any("rag" in e for e in errors)

    def test_rag_top_k_zero_is_error(self):
        cfg = Config(rag=RAGConfig(top_k=0))
        errors = validate_config(cfg)
        assert any("rag.top_k" in e for e in errors)

    def test_all_rag_fields_valid_returns_no_errors(self):
        cfg = Config(rag=RAGConfig(chunk_size=500, chunk_overlap=50, top_k=3, max_file_size=100000))
        errors = validate_config(cfg)
        assert errors == []


# ── validate_config (tier_models edge cases) ─────────────────────────────────


class TestValidateConfigTierModels:
    def test_tier_models_not_a_dict_is_error(self):
        cfg = Config(tier_models="invalid")  # type: ignore[assignment]
        errors = validate_config(cfg)
        assert any("tier_models" in e for e in errors)

    def test_tier_models_empty_key_is_error(self):
        cfg = Config(tier_models={"": "model"})
        errors = validate_config(cfg)
        assert any("tier_models" in e for e in errors)

    def test_tier_models_empty_value_is_error(self):
        cfg = Config(tier_models={"tolo": ""})
        errors = validate_config(cfg)
        assert any("tier_models.tolo" in e for e in errors)


# ── validate_config (mcp_servers edge cases) ─────────────────────────────────


class TestValidateConfigMCPEdgeCases:
    def test_mcp_servers_not_a_dict_is_error(self):
        cfg = Config(mcp_servers="invalid")  # type: ignore[assignment]
        errors = validate_config(cfg)
        assert any("mcp_servers" in e for e in errors)

    def test_mcp_servers_bad_name_is_error(self):
        cfg = Config(mcp_servers={"bad name/": {"command": "x"}})
        errors = validate_config(cfg)
        assert any("bad name" in e for e in errors)

    def test_mcp_servers_args_not_a_list(self):
        cfg = Config(mcp_servers={"srv": {"command": "x", "args": "not-a-list"}})
        errors = validate_config(cfg)
        assert any("srv.args" in e for e in errors)

    def test_mcp_servers_env_not_a_dict(self):
        cfg = Config(mcp_servers={"srv": {"command": "x", "env": "not-a-dict"}})
        errors = validate_config(cfg)
        assert any("srv.env" in e for e in errors)


# ── validate_config (theme, personality) ─────────────────────────────────────


class TestValidateConfigGeneral:
    def test_empty_theme_is_error(self):
        cfg = Config(theme="")
        errors = validate_config(cfg)
        assert any("theme" in e for e in errors)

    def test_empty_personality_is_error(self):
        cfg = Config(personality="")
        errors = validate_config(cfg)
        assert any("personality" in e for e in errors)

    def test_non_negative_read_line_limit_is_valid(self):
        cfg = Config(read_line_limit=1)
        errors = validate_config(cfg)
        assert errors == []


# ── SettingsScreen pure-logic tests ──────────────────────────────────────────


class TestSettingsScreenCollectModifiedConfig:
    """Tests for _collect_modified_config and on_input_changed.

    Values are updated in real-time via on_input_changed, so
    _collect_modified_config just returns self._config.
    """

    def _make_mock_input(self, value: str):
        m = MagicMock()
        m.value = value
        return m

    def test_tier_models_kept_from_config(self):
        """Tier models are stored directly on `_config.tier_models` via the
        OptionPicker callbacks, so `_collect_modified_config` must preserve
        whatever is already there."""
        base = Config()
        base.tier_models = {
            "tolo": "provider-a/model-x",
            "tainha": "provider-a/model-y",
            "papudo": "provider-b/model-z",
            "papaca": "provider-b/model-w",
        }
        screen = SettingsScreen(base)
        cfg = screen._collect_modified_config()
        assert cfg.tier_models["tolo"] == "provider-a/model-x"
        assert cfg.tier_models["tainha"] == "provider-a/model-y"
        assert cfg.tier_models["papudo"] == "provider-b/model-z"
        assert cfg.tier_models["papaca"] == "provider-b/model-w"

    def test_rag_fields_updated_via_on_input_changed(self):
        """RAG numeric fields are updated live via on_input_changed."""
        screen = SettingsScreen(Config())
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-chunk_size"), value="500"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-chunk_overlap"), value="50"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-top_k"), value="3"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-max_file_size"), value="100000"))
        cfg = screen._collect_modified_config()
        assert cfg.rag.chunk_size == 500
        assert cfg.rag.chunk_overlap == 50
        assert cfg.rag.top_k == 3
        assert cfg.rag.max_file_size == 100000

    def test_general_fields_updated_via_on_input_changed(self):
        """General numeric fields are updated live via on_input_changed."""
        screen = SettingsScreen(Config())
        screen.on_input_changed(MagicMock(input=MagicMock(id="gen-command_timeout"), value="60"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="gen-read_line_limit"), value="500"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="gen-grep_max_results"), value="200"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="gen-directory_tree_depth"), value="3"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="gen-ast_max_file_size"), value="999999"))
        cfg = screen._collect_modified_config()
        assert cfg.command_timeout == 60
        assert cfg.read_line_limit == 500
        assert cfg.grep_max_results == 200
        assert cfg.directory_tree_depth == 3
        assert cfg.ast_max_file_size == 999999

    def test_empty_input_value_zeroes_field(self):
        """Clearing an input sets the field to 0 (current behavior)."""
        screen = SettingsScreen(Config())
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-chunk_size"), value=""))
        cfg = screen._collect_modified_config()
        assert cfg.rag.chunk_size == 0

    def test_non_integer_input_ignored(self):
        """Non-integer input is silently ignored, preserving prior value."""
        screen = SettingsScreen(Config())
        original = screen._config.rag.chunk_size
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-chunk_size"), value="not-a-number"))
        cfg = screen._collect_modified_config()
        assert cfg.rag.chunk_size == original


class TestSettingsScreenDoSave:
    def _make_screen(self, cfg):
        screen = SettingsScreen(cfg)
        screen.dismiss = MagicMock()
        app_mock = MagicMock()
        return screen, app_mock

    def test_do_save_close_dismisses_with_config(self):
        """`_do_save(close=True)` persists, applies theme, and dismisses."""
        cfg = Config()
        screen, app_mock = self._make_screen(cfg)
        screen.query_one = MagicMock(return_value=MagicMock())

        with (
            patch.object(screen, "_collect_modified_config", return_value=cfg),
            patch("stupidex.screens.settings.validate_config", return_value=[]),
            patch("stupidex.config.ConfigManager") as cfg_mgr_cls,
            patch.object(type(screen), "app", new_callable=PropertyMock, return_value=app_mock),
        ):
            screen._do_save(close=True)

        screen.dismiss.assert_called_once()
        cfg_mgr_cls.save.assert_called_once()

    def test_do_save_stay_open_does_not_dismiss(self):
        """`_do_save(close=False)` saves in place and notifies, without dismissing."""
        cfg = Config()
        screen, app_mock = self._make_screen(cfg)
        screen.query_one = MagicMock(return_value=MagicMock())

        with (
            patch.object(screen, "_collect_modified_config", return_value=cfg),
            patch("stupidex.screens.settings.validate_config", return_value=[]),
            patch("stupidex.config.ConfigManager"),
            patch.object(type(screen), "app", new_callable=PropertyMock, return_value=app_mock),
        ):
            screen._do_save(close=False)

        screen.dismiss.assert_not_called()
        app_mock.notify.assert_called_once()

    def test_do_save_applies_theme_when_changed(self):
        """Switching the theme live calls app.switch_theme only when it differs."""
        screen, app_mock = self._make_screen(Config(theme="default"))
        screen.query_one = MagicMock(return_value=MagicMock())
        changed = Config(theme="monokai")

        with (
            patch.object(screen, "_collect_modified_config", return_value=changed),
            patch("stupidex.screens.settings.validate_config", return_value=[]),
            patch("stupidex.config.ConfigManager"),
            patch.object(type(screen), "app", new_callable=PropertyMock, return_value=app_mock),
        ):
            screen._do_save(close=False)

        app_mock.switch_theme.assert_called_once_with("monokai")

    def test_do_save_with_errors_does_not_dismiss(self):
        """On validation failure, writes errors to the error widget, does not dismiss."""
        cfg = Config()
        screen = SettingsScreen(cfg)
        screen.dismiss = MagicMock()
        err_widget = MagicMock()
        screen.query_one = MagicMock(return_value=err_widget)

        with (
            patch.object(screen, "_collect_modified_config", return_value=cfg),
            patch("stupidex.screens.settings.validate_config", return_value=["bad field"]),
        ):
            screen._do_save(close=True)

        screen.dismiss.assert_not_called()
        err_widget.update.assert_called_once()
        assert "bad field" in err_widget.update.call_args[0][0]

    def test_escape_dismisses_with_none(self):
        screen = SettingsScreen(Config())
        screen.dismiss = MagicMock()
        screen.key_escape()
        screen.dismiss.assert_called_once_with(None)


class TestSettingsScreenDirtyTracking:
    """Tests for detecting unsaved changes and tab dirty markers."""

    def test_no_changes_is_clean(self):
        screen = SettingsScreen(Config())
        assert screen._config_differs() is False
        assert screen._dirty_tab_names() == []

    def test_rag_input_change_marks_dirty(self):
        screen = SettingsScreen(Config())
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-chunk_size"), value="999"))
        assert screen._config_differs() is True
        assert "RAG" in screen._dirty_tab_names()

    def test_general_input_change_marks_dirty(self):
        screen = SettingsScreen(Config())
        screen.on_input_changed(MagicMock(input=MagicMock(id="gen-command_timeout"), value="99"))
        assert "General" in screen._dirty_tab_names()

    def test_provider_add_marks_dirty(self):
        screen = SettingsScreen(Config())
        screen._refresh_tab = MagicMock()
        screen._on_add_provider_result({"_alias": "p", "base_url": "x"})
        assert "Providers" in screen._dirty_tab_names()
        assert screen._config_differs() is True

    def test_provider_delete_marks_dirty(self):
        cfg = Config()
        cfg.providers = {"p": {"models": {"m": {}}}}
        screen = SettingsScreen(cfg)
        screen._refresh_tab = MagicMock()
        screen._on_provider_action("p", "delete")
        assert "Providers" in screen._dirty_tab_names()

    def test_mcp_add_marks_dirty(self):
        screen = SettingsScreen(Config())
        screen._refresh_tab = MagicMock()
        screen._on_add_mcp_result({"_name": "srv", "command": "node"})
        assert "MCP Servers" in screen._dirty_tab_names()

    def test_tier_change_marks_dirty(self):
        cfg = Config()
        cfg.providers = {"p": {"models": {"m": {}}}}
        screen = SettingsScreen(cfg)
        screen._config.tier_models["tolo"] = "p/m"
        screen._mark_dirty("tier_models")
        assert "Tier Models" in screen._dirty_tab_names()

    def test_escape_with_changes_pushes_confirm(self):
        screen = SettingsScreen(Config())
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-chunk_size"), value="999"))
        screen._push_confirm_discard = MagicMock()
        screen.key_escape()
        screen._push_confirm_discard.assert_called_once()

    def test_escape_without_changes_dismisses(self):
        screen = SettingsScreen(Config())
        screen.dismiss = MagicMock()
        screen.key_escape()
        screen.dismiss.assert_called_once_with(None)

    def test_confirm_discard_dismisses(self):
        screen = SettingsScreen(Config())
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-chunk_size"), value="999"))
        screen.dismiss = MagicMock()
        screen._on_confirm_discard("discard")
        screen.dismiss.assert_called_once_with(None)

    def test_confirm_keep_does_not_dismiss(self):
        screen = SettingsScreen(Config())
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-chunk_size"), value="999"))
        screen.dismiss = MagicMock()
        screen._on_confirm_discard(None)
        screen.dismiss.assert_not_called()


class TestConfirmScreen:
    def test_yes_button_dismisses_true(self):
        from stupidex.screens.settings import ConfirmScreen

        screen = ConfirmScreen("title", "msg")
        screen.dismiss = MagicMock()
        from textual.widgets import Button

        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="settings-confirm-yes")))
        screen.dismiss.assert_called_once_with("discard")

    def test_no_button_dismisses_false(self):
        from stupidex.screens.settings import ConfirmScreen

        screen = ConfirmScreen("title", "msg")
        screen.dismiss = MagicMock()
        from textual.widgets import Button

        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="settings-confirm-no")))
        screen.dismiss.assert_called_once_with(None)

    def test_escape_dismisses_false(self):
        from stupidex.screens.settings import ConfirmScreen

        screen = ConfirmScreen("title", "msg")
        screen.dismiss = MagicMock()
        screen.key_escape()
        screen.dismiss.assert_called_once_with(None)


class TestSettingsScreenRenderKeyedList:
    def test_render_keyed_list_mounts_items(self):
        screen = SettingsScreen(Config())
        container = MagicMock()
        items = [("alias-a", "http://a.com — model1, model2"), ("alias-b", "http://b.com — model3")]
        screen._render_keyed_list(container, items, "prov")
        assert screen._items_cache == items
        # Each item results in 2 mounts (the item container + the "Add" button row)
        # Actually each item results in: Static(label) + Static(detail) + Horizontal(actions)
        # mount count = 3 per item
        assert container.mount.call_count >= 2


# ── NewProviderForm tests ────────────────────────────────────────────────────


class TestNewProviderForm:
    def _make_form(self, field_values: dict[str, str]) -> NewProviderForm:
        form = NewProviderForm("Test Form")
        form.query_one = MagicMock()

        def qo(selector: str, _cls=None):
            m = MagicMock()
            m.value = field_values.get(selector, "")
            return m

        form.query_one = qo
        return form

    def _add_entry(self, form: NewProviderForm, **fields) -> dict:
        """Append an in-memory model entry (bypasses widget mounting)."""
        entry = {
            "idx": form._model_seq,
            "model_id": fields.get("model_id", ""),
            "max_input_tokens": fields.get("max_input_tokens", ""),
            "max_output_tokens": fields.get("max_output_tokens", ""),
            "supports_vision": fields.get("supports_vision", False),
            "mode": fields.get("mode", ""),
        }
        form._model_seq += 1
        form._model_entries.append(entry)
        return entry

    def test_alias_required(self):
        form = self._make_form({"#pf-alias": ""})
        error_static = MagicMock()
        form.query_one = MagicMock(
            side_effect=lambda sid, _cls=None: error_static if "#provider-form-error" in sid else MagicMock(value="")
        )
        form.dismiss = MagicMock()
        form._do_save()
        error_static.update.assert_called_once()
        form.dismiss.assert_not_called()

    def test_alias_with_slash_rejected(self):
        form = self._make_form({"#pf-alias": "bad/alias"})
        error_static = MagicMock()
        form.query_one = MagicMock(
            side_effect=lambda sid, _cls=None: (
                error_static if "#provider-form-error" in sid else MagicMock(value="bad/alias")
            )
        )
        form.dismiss = MagicMock()
        form._do_save()
        error_static.update.assert_called_once()
        assert "/" in error_static.update.call_args[0][0]
        form.dismiss.assert_not_called()

    def test_valid_provider_saves_without_extra_fields(self):
        """Minimal valid provider: alias only, no models."""

        def qo(selector: str, _cls=None):
            return MagicMock(
                value={
                    "#pf-alias": "my-provider",
                    "#pf-base-url": "",
                    "#pf-api-key": "",
                    "#pf-api-key-env": "",
                    "#pf-litellm-provider": "",
                }.get(selector, "")
            )

        form = NewProviderForm("Test")
        form.query_one = qo
        form.dismiss = MagicMock()
        form._do_save()
        result = form.dismiss.call_args[0][0]
        assert result["_alias"] == "my-provider"
        assert "base_url" not in result
        assert "api_key" not in result
        assert "models" not in result

    def test_valid_provider_with_all_fields(self):
        def qo(selector: str, _cls=None):
            return MagicMock(
                value={
                    "#pf-alias": "my-provider",
                    "#pf-base-url": "https://api.example.com/v1",
                    "#pf-api-key": "sk-secret",
                    "#pf-api-key-env": "",
                    "#pf-litellm-provider": "openai",
                }.get(selector, "")
            )

        form = NewProviderForm("Test")
        form.query_one = qo
        form.dismiss = MagicMock()
        self._add_entry(form, model_id="gpt-4o")
        self._add_entry(form, model_id="gpt-4o-mini")
        form._do_save()
        result = form.dismiss.call_args[0][0]
        assert result["_alias"] == "my-provider"
        assert result["base_url"] == "https://api.example.com/v1"
        assert result["api_key"] == "sk-secret"
        assert result["litellm_provider"] == "openai"
        assert set(result["models"].keys()) == {"gpt-4o", "gpt-4o-mini"}

    def test_model_attributes_collected_into_overrides(self):
        """max_input_tokens, max_output_tokens, supports_vision, mode round-trip."""

        def qo(selector: str, _cls=None):
            return MagicMock(
                value={
                    "#pf-alias": "p",
                    "#pf-base-url": "",
                    "#pf-api-key": "",
                    "#pf-api-key-env": "",
                    "#pf-litellm-provider": "",
                }.get(selector, "")
            )

        error_static = MagicMock()
        form = NewProviderForm("Test")
        form.query_one = MagicMock(
            side_effect=lambda sid, _cls=None: error_static if "#provider-form-error" in sid else qo(sid, _cls)
        )
        form.dismiss = MagicMock()
        self._add_entry(
            form,
            model_id="gpt-4o",
            max_input_tokens="128000",
            max_output_tokens="16384",
            supports_vision=True,
            mode="chat",
        )
        self._add_entry(form, model_id="plain-model")
        form._do_save()
        result = form.dismiss.call_args[0][0]
        assert result["models"]["gpt-4o"] == {
            "max_input_tokens": 128000,
            "max_output_tokens": 16384,
            "supports_vision": True,
            "mode": "chat",
        }
        assert result["models"]["plain-model"] == {}

    def test_non_integer_token_is_error(self):
        def qo(selector: str, _cls=None):
            return MagicMock(
                value={
                    "#pf-alias": "p",
                    "#pf-base-url": "",
                    "#pf-api-key": "",
                    "#pf-api-key-env": "",
                    "#pf-litellm-provider": "",
                }.get(selector, "")
            )

        error_static = MagicMock()
        form = NewProviderForm("Test")
        form.query_one = MagicMock(
            side_effect=lambda sid, _cls=None: error_static if "#provider-form-error" in sid else qo(sid, _cls)
        )
        form.dismiss = MagicMock()
        self._add_entry(form, model_id="gpt-4o", max_input_tokens="not-a-number")
        form._do_save()
        error_static.update.assert_called_once()
        assert "max_input_tokens" in error_static.update.call_args[0][0]
        form.dismiss.assert_not_called()

    def test_duplicate_model_id_is_error(self):
        def qo(selector: str, _cls=None):
            return MagicMock(
                value={
                    "#pf-alias": "p",
                    "#pf-base-url": "",
                    "#pf-api-key": "",
                    "#pf-api-key-env": "",
                    "#pf-litellm-provider": "",
                }.get(selector, "")
            )

        error_static = MagicMock()
        form = NewProviderForm("Test")
        form.query_one = MagicMock(
            side_effect=lambda sid, _cls=None: error_static if "#provider-form-error" in sid else qo(sid, _cls)
        )
        form.dismiss = MagicMock()
        self._add_entry(form, model_id="gpt-4o")
        self._add_entry(form, model_id="gpt-4o")
        form._do_save()
        error_static.update.assert_called_once()
        assert "Duplicate" in error_static.update.call_args[0][0]
        form.dismiss.assert_not_called()


# ── NewMCPServerForm tests ────────────────────────────────────────────────────


class TestNewMCPServerForm:
    def _make_form(self, field_values: dict[str, str]) -> NewMCPServerForm:
        form = NewMCPServerForm("Test MCP Form")
        form.query_one = MagicMock()

        def qo(selector: str, _cls=None):
            m = MagicMock()
            m.value = field_values.get(selector, "")
            return m

        form.query_one = qo
        return form

    def test_name_required(self):
        form = self._make_form({"#mf-name": ""})
        error_static = MagicMock()
        form.query_one = MagicMock(
            side_effect=lambda sid, _cls=None: error_static if "#mcp-form-error" in sid else MagicMock(value="")
        )
        form.dismiss = MagicMock()
        form._do_save()
        error_static.update.assert_called_once()
        form.dismiss.assert_not_called()

    def test_command_or_url_required(self):
        form = self._make_form({"#mf-name": "myserver", "#mf-command": "", "#mf-url": ""})
        error_static = MagicMock()
        form.query_one = MagicMock(
            side_effect=lambda sid, _cls=None: (
                error_static
                if "#mcp-form-error" in sid
                else MagicMock(
                    value={
                        "#mf-name": "myserver",
                        "#mf-command": "",
                        "#mf-args": "",
                        "#mf-url": "",
                    }.get(sid, "")
                )
            )
        )
        form.dismiss = MagicMock()
        form._do_save()
        error_static.update.assert_called_once()
        form.dismiss.assert_not_called()

    def test_valid_url_server(self):
        form = self._make_form(
            {"#mf-name": "myserver", "#mf-command": "", "#mf-args": "", "#mf-url": "http://localhost:3000/sse"}
        )
        form.dismiss = MagicMock()
        form._do_save()
        result = form.dismiss.call_args[0][0]
        assert result["_name"] == "myserver"
        assert result["url"] == "http://localhost:3000/sse"

    def test_valid_command_server(self):
        form = self._make_form(
            {"#mf-name": "myserver", "#mf-command": "node", "#mf-args": "server.js, --port, 3000", "#mf-url": ""}
        )
        form.dismiss = MagicMock()
        form._do_save()
        result = form.dismiss.call_args[0][0]
        assert result["_name"] == "myserver"
        assert result["command"] == "node"
        assert result["args"] == ["server.js", "--port", "3000"]

    def test_command_without_args(self):
        form = self._make_form({"#mf-name": "myserver", "#mf-command": "python", "#mf-args": "", "#mf-url": ""})
        form.dismiss = MagicMock()
        form._do_save()
        result = form.dismiss.call_args[0][0]
        assert result["command"] == "python"
        assert result["args"] == []


# ── ConfigManager save / load with settings screen flow ──────────────────────


class TestConfigManagerSettingsFlow:
    """Integration-style tests for the save flow ConfigManager is part of."""

    def test_settings_screen_returns_modified_config(self):
        """Verify that validate_config accepts a config modified via on_input_changed."""
        orig = Config()
        orig.tier_models = {
            "tolo": "custom/tolo-model",
            "tainha": "custom/tainha-model",
            "papudo": "custom/papudo-model",
            "papaca": "custom/papaca-model",
        }
        orig.default_model = "custom/default-model"
        orig.theme = "dracula"
        orig.personality = "concise"
        orig.rag = RAGConfig(
            chunk_size=3000,
            chunk_overlap=300,
            top_k=8,
            max_file_size=99999,
            embedding_model="test/embed",
        )
        screen = SettingsScreen(orig)
        # Simulate user editing numeric fields via on_input_changed
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-chunk_size"), value="3000"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-chunk_overlap"), value="300"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-top_k"), value="8"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="rag-max_file_size"), value="99999"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="gen-command_timeout"), value="45"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="gen-read_line_limit"), value="800"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="gen-grep_max_results"), value="150"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="gen-directory_tree_depth"), value="5"))
        screen.on_input_changed(MagicMock(input=MagicMock(id="gen-ast_max_file_size"), value="500000"))
        modified = screen._collect_modified_config()

        # Should pass validation
        errors = validate_config(modified)
        assert errors == [], f"Validation failed: {errors}"

        # Verify key changes took effect
        assert modified.tier_models["tolo"] == "custom/tolo-model"
        assert modified.rag.chunk_size == 3000
        assert modified.default_model == "custom/default-model"
        assert modified.theme == "dracula"
        assert modified.personality == "concise"

    def test_save_roundtrip_with_temporary_file(self):
        """Simulate the full save flow: modify config, save to file, reload."""
        with tempfile.TemporaryDirectory() as tmpdir_str:
            tmpdir = Path(tmpdir_str)
            home_path = tmpdir / "config.json"

            with (
                patch("stupidex.config.HOME_CONFIG_DIR", tmpdir),
                patch("stupidex.config.HOME_CONFIG_PATH", home_path),
                patch("stupidex.config.HOME_AGENTS_DIR", tmpdir / "agents"),
                patch("stupidex.config.HOME_SKILLS_DIR", tmpdir / "skills"),
                patch("stupidex.config.PROJECT_CONFIG_NAME", "nonexistent-project-config.json"),
                patch("stupidex.agents.seed_agents_dir"),
                patch("stupidex.agents.load_agents"),
                patch("stupidex.skills.seed_skills_dir"),
                patch("stupidex.skills.load_skills"),
                patch("stupidex.personality.load_personalities"),
            ):
                ConfigManager.reset()
                ConfigManager.ensure_home_config()
                ConfigManager.reset()
                cfg = ConfigManager.load()
                assert cfg.theme == "default"

                # Simulate SettingsScreen save by modifying config
                cfg.theme = "dracula"
                cfg.rag = RAGConfig(chunk_size=1000)
                ConfigManager._instance = cfg
                ConfigManager.save()

                # Reload
                ConfigManager.reset()
                reloaded = ConfigManager.load()
                assert reloaded.theme == "dracula"
                assert reloaded.rag.chunk_size == 1000
                ConfigManager.reset()


# ── main.py startup gate ─────────────────────────────────────────────────────


class TestMainStartupGate:
    def test_gate_exits_on_errors(self):
        from stupidex import main

        with (
            patch.object(main.ConfigManager, "load"),
            patch.object(main.ConfigManager, "errors", return_value=["bad field"]),
            patch.object(main.ConfigManager, "ensure_home_config"),
            patch.object(main, "sys") as mock_sys,
        ):
            # A real sys.exit raises SystemExit; without this the mocked call
            # is a no-op and execution would continue past the gate.
            mock_sys.exit.side_effect = SystemExit
            with pytest.raises(SystemExit):
                main.main()

        mock_sys.exit.assert_called_once_with(1)
        # Should have printed to stderr
        assert mock_sys.stderr.write.called or mock_sys.stderr.writelines.called

    def test_gate_starts_app_on_no_errors(self):
        from stupidex import main

        with (
            patch.object(main.ConfigManager, "load"),
            patch.object(main.ConfigManager, "errors", return_value=[]),
            patch.object(main.ConfigManager, "ensure_home_config"),
            patch.object(main, "Stupidex") as mock_app_cls,
        ):
            mock_app = MagicMock()
            # MagicMock attributes are truthy by default; ``restart_requested``
            # must be falsy or main() calls os.execv, re-exec'ing the process.
            mock_app.restart_requested = False
            mock_app_cls.return_value = mock_app

            main.main()

        mock_app_cls.assert_called_once()
        mock_app.run.assert_called_once()


# ── _on_edit_provider_result (rename / overwrite behavior) ──────────────────


class TestOnEditProviderResult(unittest.TestCase):
    def _make_screen(self, providers=None):
        cfg = Config()
        cfg.providers = dict(providers) if providers else {}
        screen = SettingsScreen(cfg)
        screen._refresh_tab = MagicMock()
        screen._mark_dirty = MagicMock()
        screen.notify = MagicMock()
        return screen

    def test_rename_removes_old_alias_adds_new(self):
        screen = self._make_screen({"old": {"base_url": "u"}})
        screen._on_edit_provider_result(
            result={"_alias": "new", "models": {}}, original_alias="old"
        )
        self.assertIn("new", screen._config.providers)
        self.assertNotIn("old", screen._config.providers)

    def test_same_alias_overwrites_in_place_no_pop(self):
        screen = self._make_screen({"old": {"base_url": "u"}})
        screen._on_edit_provider_result(
            result={"_alias": "old", "models": {"m": {}}}, original_alias="old"
        )
        self.assertEqual(set(screen._config.providers.keys()), {"old"})
        self.assertEqual(screen._config.providers["old"]["models"], {"m": {}})

    def test_rename_to_existing_alias_rejected(self):
        screen = self._make_screen(
            {"old": {"base_url": "old-url"}, "existing": {"base_url": "exist-url"}}
        )
        screen._on_edit_provider_result(
            result={"_alias": "existing", "models": {}}, original_alias="old"
        )
        # rename cancelled: original entry UNCHANGED, existing untouched
        self.assertIn("old", screen._config.providers)
        self.assertIn("existing", screen._config.providers)
        self.assertEqual(screen._config.providers["existing"]["base_url"], "exist-url")
        self.assertEqual(screen._config.providers["old"]["base_url"], "old-url")
        screen.notify.assert_called_once()
        args, kwargs = screen.notify.call_args
        self.assertEqual(kwargs.get("severity"), "warning")
        screen._refresh_tab.assert_called_once()
        screen._mark_dirty.assert_called_once_with("providers")

    def test_original_alias_none_just_inserts(self):
        screen = self._make_screen({"keep": {"base_url": "u"}})
        screen._on_edit_provider_result(
            result={"_alias": "new", "models": {}}, original_alias=None
        )
        self.assertIn("new", screen._config.providers)
        self.assertIn("keep", screen._config.providers)

    def test_result_missing_alias_key_raises_keyerror(self):
        screen = self._make_screen({"old": {"base_url": "u"}})
        with self.assertRaises(KeyError):
            screen._on_edit_provider_result(
                result={"models": {}}, original_alias="old"
            )

    def test_edit_marks_providers_dirty(self):
        screen = self._make_screen({"old": {"base_url": "u"}})
        screen._on_edit_provider_result(
            result={"_alias": "old", "models": {}}, original_alias="old"
        )
        screen._mark_dirty.assert_called_once_with("providers")


# ── _on_edit_mcp_result (rename / overwrite behavior) ───────────────────────


class TestOnEditMcpResult(unittest.TestCase):
    def _make_screen(self, mcp_servers=None):
        cfg = Config()
        cfg.mcp_servers = dict(mcp_servers) if mcp_servers else {}
        screen = SettingsScreen(cfg)
        screen._refresh_tab = MagicMock()
        screen._mark_dirty = MagicMock()
        screen.notify = MagicMock()
        return screen

    def test_rename_removes_old_name_adds_new(self):
        screen = self._make_screen({"old": {"command": "x"}})
        screen._on_edit_mcp_result(
            result={"_name": "new", "command": "x"}, original_name="old"
        )
        self.assertIn("new", screen._config.mcp_servers)
        self.assertNotIn("old", screen._config.mcp_servers)

    def test_same_name_overwrites_in_place(self):
        screen = self._make_screen({"old": {"command": "x"}})
        screen._on_edit_mcp_result(
            result={"_name": "old", "command": "y", "args": ["a"]}, original_name="old"
        )
        self.assertEqual(set(screen._config.mcp_servers.keys()), {"old"})
        self.assertEqual(screen._config.mcp_servers["old"]["command"], "y")

    def test_rename_to_existing_name_rejected(self):
        screen = self._make_screen(
            {
                "old": {"command": "old-cmd"},
                "existing": {"command": "exist-cmd"},
            }
        )
        screen._on_edit_mcp_result(
            result={"_name": "existing", "command": "new-cmd"}, original_name="old"
        )
        # rename cancelled: original entry UNCHANGED, existing untouched
        self.assertIn("old", screen._config.mcp_servers)
        self.assertIn("existing", screen._config.mcp_servers)
        self.assertEqual(screen._config.mcp_servers["existing"]["command"], "exist-cmd")
        self.assertEqual(screen._config.mcp_servers["old"]["command"], "old-cmd")
        screen.notify.assert_called_once()
        args, kwargs = screen.notify.call_args
        self.assertEqual(kwargs.get("severity"), "warning")
        screen._refresh_tab.assert_called_once()
        screen._mark_dirty.assert_called_once_with("mcp_servers")

    def test_edit_marks_mcp_servers_dirty(self):
        screen = self._make_screen({"old": {"command": "x"}})
        screen._on_edit_mcp_result(
            result={"_name": "old", "command": "x"}, original_name="old"
        )
        screen._mark_dirty.assert_called_once_with("mcp_servers")


# ── NewProviderForm model-row removal (P2-210) ───────────────────────────────


class TestNewProviderFormRemoveModelRow(unittest.TestCase):
    def _make_form(self) -> NewProviderForm:
        form = NewProviderForm("Test")
        form.query_one = MagicMock()
        form.query = MagicMock(return_value=[])
        return form

    def _entry(self, idx: int, model_id: str = "") -> dict:
        return {
            "idx": idx,
            "model_id": model_id,
            "max_input_tokens": "",
            "max_output_tokens": "",
            "supports_vision": False,
            "mode": "",
        }

    def test_remove_model_entry_removes_from_internal_state(self):
        form = self._make_form()
        form._model_entries = [self._entry(0, "a"), self._entry(1, "b")]
        form._remove_model_entry(0)
        self.assertEqual(len(form._model_entries), 1)
        self.assertEqual(form._model_entries[0]["idx"], 1)
        self.assertEqual(form._model_entries[0]["model_id"], "b")

    def test_remove_model_entry_removes_matching_dom_row(self):
        form = self._make_form()
        matching_row = MagicMock()
        matching_row.query_one.return_value = MagicMock()
        other_row = MagicMock()
        other_row.query_one.side_effect = Exception("no button")
        form.query = MagicMock(return_value=[other_row, matching_row])
        form._model_entries = [self._entry(0, "x")]
        form._remove_model_entry(0)
        matching_row.remove.assert_called_once()
        other_row.remove.assert_not_called()

    def test_on_button_pressed_pf_model_rm_removes_entry(self):
        form = self._make_form()
        form._model_entries = [self._entry(5, "to-remove")]
        event = Button.Pressed(button=MagicMock(id="pf-model-rm-5"))
        form.on_button_pressed(event)
        self.assertEqual(form._model_entries, [])


# ── NewProviderForm on_input_changed / on_select_changed (P2-211) ────────────


class TestNewProviderFormStateSync(unittest.TestCase):
    """on_input_changed / on_select_changed sync model-row widget state into
    `self._model_entries`. (Provider alias is read at save time, not synced.)"""

    def _make_form_with_entry(self) -> NewProviderForm:
        form = NewProviderForm("Test")
        form.query_one = MagicMock()
        form.query = MagicMock(return_value=[])
        form._model_entries = [self._entry(0)]
        return form

    def _entry(self, idx: int) -> dict:
        return {
            "idx": idx,
            "model_id": "",
            "max_input_tokens": "",
            "max_output_tokens": "",
            "supports_vision": False,
            "mode": "",
        }

    def test_on_input_changed_updates_model_id(self):
        form = self._make_form_with_entry()
        event = MagicMock(spec=Input.Changed)
        event.input = MagicMock(id="pf-model-id-0")
        event.value = "gpt-4o"
        form.on_input_changed(event)
        self.assertEqual(form._model_entries[0]["model_id"], "gpt-4o")

    def test_on_input_changed_updates_max_input_tokens(self):
        form = self._make_form_with_entry()
        event = MagicMock(spec=Input.Changed)
        event.input = MagicMock(id="pf-model-mit-0")
        event.value = "128000"
        form.on_input_changed(event)
        self.assertEqual(form._model_entries[0]["max_input_tokens"], "128000")

    def test_on_input_changed_updates_max_output_tokens(self):
        form = self._make_form_with_entry()
        event = MagicMock(spec=Input.Changed)
        event.input = MagicMock(id="pf-model-mot-0")
        event.value = "16384"
        form.on_input_changed(event)
        self.assertEqual(form._model_entries[0]["max_output_tokens"], "16384")

    def test_on_input_changed_ignores_unrelated_input(self):
        form = self._make_form_with_entry()
        before = dict(form._model_entries[0])
        event = MagicMock(spec=Input.Changed)
        event.input = MagicMock(id="pf-alias")
        event.value = "ignored"
        form.on_input_changed(event)
        self.assertEqual(form._model_entries[0], before)

    def test_on_select_changed_updates_supports_vision(self):
        form = self._make_form_with_entry()
        event = MagicMock(spec=Select.Changed)
        event.select = MagicMock(id="pf-model-vision-0")
        event.value = True
        form.on_select_changed(event)
        self.assertIs(form._model_entries[0]["supports_vision"], True)

    def test_on_select_changed_updates_mode(self):
        form = self._make_form_with_entry()
        event = MagicMock(spec=Select.Changed)
        event.select = MagicMock(id="pf-model-mode-0")
        event.value = "embeddings"
        form.on_select_changed(event)
        self.assertEqual(form._model_entries[0]["mode"], "embeddings")

    def test_on_select_changed_ignores_unrelated_select(self):
        form = self._make_form_with_entry()
        before = dict(form._model_entries[0])
        event = MagicMock(spec=Select.Changed)
        event.select = MagicMock(id="something-else-0")
        event.value = "chat"
        form.on_select_changed(event)
        self.assertEqual(form._model_entries[0], before)


# ── ConfirmScreen 'Close and Save' path (P2-212) ────────────────────────────


class TestConfirmScreenSaveClose(unittest.TestCase):
    def test_save_button_dismisses_save_close(self):
        from stupidex.screens.settings import ConfirmScreen

        screen = ConfirmScreen("title", "msg")
        screen.dismiss = MagicMock()
        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="settings-confirm-save")))
        screen.dismiss.assert_called_once_with("save_close")

    def test_on_confirm_discard_save_close_calls_do_save_close_true(self):
        screen = SettingsScreen(Config())
        screen._do_save = MagicMock()
        screen._on_confirm_discard("save_close")
        screen._do_save.assert_called_once_with(close=True)

    def test_on_confirm_discard_discard_dismisses_none(self):
        screen = SettingsScreen(Config())
        screen.dismiss = MagicMock()
        screen._on_confirm_discard("discard")
        screen.dismiss.assert_called_once_with(None)

    def test_on_confirm_discard_none_does_nothing(self):
        screen = SettingsScreen(Config())
        screen.dismiss = MagicMock()
        screen._do_save = MagicMock()
        screen._on_confirm_discard(None)
        screen.dismiss.assert_not_called()
        screen._do_save.assert_not_called()


# ── NewMCPServerForm Cancel and Escape (P3-92) ───────────────────────────────


class TestNewMCPServerFormCancel(unittest.TestCase):
    def test_cancel_button_dismisses_none(self):
        form = NewMCPServerForm("Test")
        form.dismiss = MagicMock()
        form.on_button_pressed(Button.Pressed(button=MagicMock(id="mf-cancel")))
        form.dismiss.assert_called_once_with(None)

    def test_escape_dismisses_none(self):
        form = NewMCPServerForm("Test")
        form.dismiss = MagicMock()
        form.key_escape()
        form.dismiss.assert_called_once_with(None)


# ── SettingsScreen.key_ctrl_s save-in-place (P3-93) ──────────────────────────


class TestSettingsScreenCtrlS(unittest.TestCase):
    def test_key_ctrl_s_invokes_do_save_close_false(self):
        screen = SettingsScreen(Config())
        screen._do_save = MagicMock()
        screen.key_ctrl_s()
        screen._do_save.assert_called_once_with(close=False)


# ── SettingsScreen.on_button_pressed routing (P2-213) ───────────────────────


class TestSettingsScreenButtonRouting(unittest.TestCase):
    def _make_screen(self) -> SettingsScreen:
        screen = SettingsScreen(Config())
        screen._refresh_tab = MagicMock()
        screen._mark_dirty = MagicMock()
        screen._update_tab_labels = MagicMock()
        app_mock = MagicMock()
        patcher = patch.object(type(screen), "app", new_callable=PropertyMock, return_value=app_mock)
        patcher.start()
        self.addCleanup(patcher.stop)
        return screen

    def test_prov_edit_routes_to_on_provider_action_edit(self):
        screen = self._make_screen()
        screen._items_cache = [("alias-a", "detail-a")]
        screen._on_provider_action = MagicMock()
        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="prov-edit-0")))
        screen._on_provider_action.assert_called_once_with("alias-a", "edit")

    def test_prov_del_routes_to_on_provider_action_delete(self):
        screen = self._make_screen()
        screen._items_cache = [("alias-a", "detail-a")]
        screen._on_provider_action = MagicMock()
        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="prov-del-0")))
        screen._on_provider_action.assert_called_once_with("alias-a", "delete")

    def test_mcp_edit_routes_to_on_mcp_action_edit(self):
        screen = self._make_screen()
        screen._items_cache = [("srv-a", "detail-a")]
        screen._on_mcp_action = MagicMock()
        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="mcp-edit-0")))
        screen._on_mcp_action.assert_called_once_with("srv-a", "edit")

    def test_mcp_del_routes_to_on_mcp_action_delete(self):
        screen = self._make_screen()
        screen._items_cache = [("srv-a", "detail-a")]
        screen._on_mcp_action = MagicMock()
        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="mcp-del-0")))
        screen._on_mcp_action.assert_called_once_with("srv-a", "delete")

    def test_tier_change_routes_to_open_tier_model_picker(self):
        screen = self._make_screen()
        screen._open_tier_model_picker = MagicMock()
        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="tier-change-tolo")))
        screen._open_tier_model_picker.assert_called_once_with("tolo")

    def test_gen_pick_routes_to_open_general_picker(self):
        screen = self._make_screen()
        screen._open_general_picker = MagicMock()
        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="gen-pick-theme")))
        screen._open_general_picker.assert_called_once_with("theme")

    def test_rag_pick_routes_to_open_rag_picker(self):
        screen = self._make_screen()
        screen._open_rag_picker = MagicMock()
        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="rag-pick-embedding_model")))
        screen._open_rag_picker.assert_called_once_with("embedding_model")

    def test_providers_add_pushes_new_provider_form(self):
        screen = self._make_screen()
        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="providers-add")))
        screen.app.push_screen.assert_called_once()
        args = screen.app.push_screen.call_args[0]
        self.assertIsInstance(args[0], NewProviderForm)

    def test_mcp_add_pushes_new_mcp_server_form(self):
        screen = self._make_screen()
        screen.on_button_pressed(Button.Pressed(button=MagicMock(id="mcp-add")))
        screen.app.push_screen.assert_called_once()
        args = screen.app.push_screen.call_args[0]
        self.assertIsInstance(args[0], NewMCPServerForm)


# ── SettingsScreen picker flows (P2-214) ──────────────────────────────────────


class TestSettingsScreenPickerFlows(unittest.TestCase):
    def _make_screen(self) -> SettingsScreen:
        screen = SettingsScreen(Config())
        screen._refresh_tab = MagicMock()
        screen._mark_dirty = MagicMock()
        screen._update_tab_labels = MagicMock()
        app_mock = MagicMock()
        patcher = patch.object(type(screen), "app", new_callable=PropertyMock, return_value=app_mock)
        patcher.start()
        self.addCleanup(patcher.stop)
        return screen

    def _capture_callback(self, screen):
        captured: dict = {}

        def fake_push(picker, callback):
            captured["picker"] = picker
            captured["callback"] = callback

        screen.app.push_screen.side_effect = fake_push
        return captured

    def test_theme_picker_callback_updates_config(self):
        screen = self._make_screen()
        captured = self._capture_callback(screen)
        with patch("stupidex.themes.get_theme_registry") as reg:
            reg.return_value.list_themes.return_value = ["default", "monokai", "dracula"]
            screen._open_theme_picker()
        self.assertIsInstance(captured["picker"], OptionPicker)
        captured["callback"]("monokai")
        self.assertEqual(screen._config.theme, "monokai")
        screen._refresh_tab.assert_called_once()
        screen._mark_dirty.assert_called_once_with("general")

    def test_personality_picker_callback_updates_config(self):
        screen = self._make_screen()
        captured = self._capture_callback(screen)
        with patch("stupidex.personality.load_personalities", return_value={"concise": "x", "verbose": "y"}):
            screen._open_personality_picker()
        self.assertIsInstance(captured["picker"], OptionPicker)
        captured["callback"]("verbose")
        self.assertEqual(screen._config.personality, "verbose")
        screen._refresh_tab.assert_called_once()
        screen._mark_dirty.assert_called_once_with("general")

    def test_default_model_picker_callback_updates_config(self):
        screen = self._make_screen()
        captured = self._capture_callback(screen)
        items = [PickerItem(label="prov-a / gpt-4o", id="prov-a/gpt-4o")]
        with patch("stupidex.screens.settings._build_model_picker_items", return_value=items):
            screen._open_default_model_picker()
        self.assertIsInstance(captured["picker"], OptionPicker)
        captured["callback"]("prov-a/gpt-4o")
        self.assertEqual(screen._config.default_model, "prov-a/gpt-4o")
        screen._refresh_tab.assert_called_once()
        screen._mark_dirty.assert_called_once_with("general")

    def test_default_model_picker_no_items_does_not_push(self):
        screen = self._make_screen()
        with patch("stupidex.screens.settings._build_model_picker_items", return_value=[]):
            screen._open_default_model_picker()
        screen.app.push_screen.assert_not_called()

    def test_embedding_model_picker_callback_updates_config(self):
        screen = self._make_screen()
        captured = self._capture_callback(screen)
        with (
            patch("stupidex.screens.settings._list_fastembed_models", return_value=["X"]),
            patch("stupidex.screens.settings._build_model_picker_items", return_value=[]),
        ):
            screen._open_embedding_model_picker()
        self.assertIsInstance(captured["picker"], OptionPicker)
        captured["callback"]("fastembed/X")
        self.assertEqual(screen._config.rag.embedding_model, "fastembed/X")
        screen._refresh_tab.assert_called_once()
        screen._mark_dirty.assert_called_once_with("rag")

    def test_embedding_model_picker_no_items_does_not_push(self):
        screen = self._make_screen()
        with (
            patch("stupidex.screens.settings._list_fastembed_models", return_value=[]),
            patch("stupidex.screens.settings._build_model_picker_items", return_value=[]),
        ):
            screen._open_embedding_model_picker()
        screen.app.push_screen.assert_not_called()
