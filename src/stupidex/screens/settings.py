"""Full-screen settings modal with tabbed navigation for all config sections."""

from dataclasses import asdict
from functools import partial

from textual.app import ComposeResult
from textual.containers import Horizontal, ScrollableContainer, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Select, Static, Tab, Tabs

from stupidex.commands.session_commands import _build_model_picker_items
from stupidex.config import (
    Config,
    RAGConfig,
    validate_config,
)
from stupidex.screens.picker import OptionPicker, PickerItem


def _list_fastembed_models() -> list[str]:
    try:
        from fastembed import TextEmbedding

        return [m["model"] for m in TextEmbedding.list_supported_models()]
    except Exception:
        return []


class NewProviderForm(ModalScreen[dict | None]):
    """Modal form to add or edit a provider entry.

    Per-model attributes are edited inline in a table-like grid.
    """

    CSS = """
    NewProviderForm {
        align: center middle;
    }
    #provider-form-container {
        width: 110;
        height: auto;
        max-height: 85%;
        border: thick $primary;
        background: $surface;
        padding: 1 2;
    }
    #provider-form-scroll {
        height: 1fr;
        max-height: 55;
        overflow-y: auto;
    }
    #provider-form-container Label {
        text-style: bold;
        height: 1;
        margin-top: 1;
    }
    #provider-form-container Input {
        height: 3;
    }
    #provider-form-buttons {
        width: 100%;
        height: auto;
        align-horizontal: center;
        margin-top: 1;
    }
    #provider-form-buttons Button {
        margin: 0 1;
        height: 3;
    }
    #provider-form-error {
        color: $error;
        height: 1;
    }
    #pf-models-list {
        margin-top: 0;
        height: auto;
    }
    .pf-model-table-header {
        height: 1;
        margin-top: 1;
    }
    #provider-form-container .pf-model-table-header Label {
        text-style: bold;
        color: $text-muted;
        height: 1;
        margin-top: 0;
        padding: 0 1;
    }
    .pf-model-table-rule {
        height: 1;
        color: $surface-lighten-2;
    }
    .pf-model-row {
        height: 5;
        border: solid $surface-lighten-1;
        padding: 0 1;
        margin-bottom: 0;
        align-vertical: middle;
    }
    .pf-model-row Input {
        height: 3;
    }
    .pf-model-row Select {
        height: 3;
    }
    .pf-col-id {
        width: 1fr;
    }
    .pf-col-small {
        width: 16;
    }
    .pf-col-vision {
        width: 14;
    }
    .pf-col-mode {
        width: 14;
    }
    .pf-col-remove {
        width: 5;
        min-width: 0;
        content-align: center middle;
    }
    """

    def __init__(self, title: str, initial: dict | None = None) -> None:
        super().__init__()
        self._title = title
        self._initial = initial or {}
        self._model_entries: list[dict] = []
        self._model_seq = 0

    def compose(self) -> ComposeResult:
        with Vertical(id="provider-form-container"):
            yield Static(self._title, id="provider-form-title")
            yield Static("", id="provider-form-error")
            with ScrollableContainer(id="provider-form-scroll"):
                yield Label("Alias (e.g. 'work-openai')")
                yield Input(
                    placeholder="my-provider",
                    value=self._initial.get("_alias", ""),
                    id="pf-alias",
                )
                yield Label("Base URL")
                yield Input(
                    placeholder="https://api.openai.com/v1",
                    value=self._initial.get("base_url", ""),
                    id="pf-base-url",
                )
                yield Label("API Key")
                yield Input(
                    placeholder="sk-...",
                    value=self._initial.get("api_key", ""),
                    password=True,
                    id="pf-api-key",
                )
                yield Label("API Key Env Var")
                yield Input(
                    placeholder="OPENAI_API_KEY",
                    value=self._initial.get("api_key_env", ""),
                    id="pf-api-key-env",
                )
                yield Label("LiteLLM Provider")
                yield Input(
                    placeholder="openai",
                    value=self._initial.get("litellm_provider", ""),
                    id="pf-litellm-provider",
                )
                yield Label("Models")
                with Horizontal(classes="pf-model-table-header"):
                    yield Label("Model ID", classes="pf-col-id")
                    yield Label("Max Input", classes="pf-col-small")
                    yield Label("Max Output", classes="pf-col-small")
                    yield Label("Vision", classes="pf-col-vision")
                    yield Label("Mode", classes="pf-col-mode")
                    yield Label("", classes="pf-col-remove")
                yield Static("─" * 108, classes="pf-model-table-rule")
                yield Vertical(id="pf-models-list")
            with Horizontal(id="provider-form-buttons"):
                yield Button("Add Model", id="pf-add-model")
                yield Button("Save", variant="primary", id="pf-save")
                yield Button("Cancel", variant="default", id="pf-cancel")

    def on_mount(self) -> None:
        initial_models = self._initial.get("models", {}) if isinstance(self._initial, dict) else {}
        if isinstance(initial_models, dict):
            for model_id, overrides in initial_models.items():
                if not isinstance(overrides, dict):
                    overrides = {}
                self._add_model_entry(model_id=model_id, overrides=overrides)
        if not self._model_entries:
            self._add_model_entry()
        self.query_one("#pf-alias", Input).focus()

    def _add_model_entry(
        self,
        model_id: str = "",
        overrides: dict | None = None,
    ) -> None:
        overrides = overrides or {}
        idx = self._model_seq
        self._model_seq += 1
        supports_vision = bool(overrides.get("supports_vision", False))
        entry = {
            "idx": idx,
            "model_id": model_id,
            "max_input_tokens": str(overrides.get("max_input_tokens", ""))
            if overrides.get("max_input_tokens") is not None
            else "",
            "max_output_tokens": str(overrides.get("max_output_tokens", ""))
            if overrides.get("max_output_tokens") is not None
            else "",
            "supports_vision": supports_vision,
            "mode": str(overrides.get("mode", "")) if overrides.get("mode") else "",
        }
        self._model_entries.append(entry)
        models_list = self.query_one("#pf-models-list", Vertical)
        models_list.mount(self._build_model_row(entry))
        try:
            self.query_one(f"#pf-model-id-{idx}", Input).focus()
        except Exception:
            pass

    def _build_model_row(self, entry: dict) -> Horizontal:
        idx = entry["idx"]
        vision_select = Select(
            [("false", False), ("true", True)],
            value=entry["supports_vision"],
            id=f"pf-model-vision-{idx}",
            classes="pf-col-vision",
            allow_blank=False,
        )
        mode_value = entry["mode"] if entry["mode"] in ("chat", "embeddings") else "chat"
        mode_select = Select(
            [("Chat", "chat"), ("Embeddings", "embeddings")],
            value=mode_value,
            id=f"pf-model-mode-{idx}",
            classes="pf-col-mode",
            allow_blank=False,
        )
        return Horizontal(
            Input(
                placeholder="model id",
                value=entry["model_id"],
                id=f"pf-model-id-{idx}",
                classes="pf-col-id",
            ),
            Input(
                placeholder="max_input",
                value=entry["max_input_tokens"],
                id=f"pf-model-mit-{idx}",
                classes="pf-col-small",
            ),
            Input(
                placeholder="max_output",
                value=entry["max_output_tokens"],
                id=f"pf-model-mot-{idx}",
                classes="pf-col-small",
            ),
            vision_select,
            mode_select,
            Button("✕", id=f"pf-model-rm-{idx}", classes="pf-col-remove"),
            classes="pf-model-row",
        )

    def _remove_model_entry(self, idx: int) -> None:
        self._model_entries = [e for e in self._model_entries if e["idx"] != idx]
        for row in self.query(".pf-model-row"):
            try:
                row.query_one(f"#pf-model-rm-{idx}", Button)
            except Exception:
                continue
            row.remove()
            break

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn_id = event.button.id or ""
        if btn_id == "pf-save":
            self._do_save()
        elif btn_id == "pf-cancel":
            self.dismiss(None)
        elif btn_id == "pf-add-model":
            self._add_model_entry()
        elif btn_id.startswith("pf-model-rm-"):
            idx = int(btn_id[len("pf-model-rm-") :])
            self._remove_model_entry(idx)

    def on_input_changed(self, event: Input.Changed) -> None:
        input_id = event.input.id or ""
        for entry in self._model_entries:
            i = entry["idx"]
            if input_id == f"pf-model-id-{i}":
                entry["model_id"] = event.value
            elif input_id == f"pf-model-mit-{i}":
                entry["max_input_tokens"] = event.value
            elif input_id == f"pf-model-mot-{i}":
                entry["max_output_tokens"] = event.value

    def on_select_changed(self, event: Select.Changed) -> None:
        select_id = event.select.id or ""
        for entry in self._model_entries:
            i = entry["idx"]
            if select_id == f"pf-model-vision-{i}":
                entry["supports_vision"] = bool(event.value)
            elif select_id == f"pf-model-mode-{i}":
                entry["mode"] = str(event.value)

    def key_escape(self) -> None:
        self.dismiss(None)

    def _do_save(self) -> None:
        alias = self.query_one("#pf-alias", Input).value.strip()
        if not alias:
            self.query_one("#provider-form-error", Static).update("Alias is required.")
            return
        if "/" in alias:
            self.query_one("#provider-form-error", Static).update("Alias cannot contain '/'.")
            return

        base_url = self.query_one("#pf-base-url", Input).value.strip()
        api_key = self.query_one("#pf-api-key", Input).value.strip()
        api_key_env = self.query_one("#pf-api-key-env", Input).value.strip()
        litellm_provider = self.query_one("#pf-litellm-provider", Input).value.strip()

        entry: dict = {}
        if base_url:
            entry["base_url"] = base_url
        if api_key:
            entry["api_key"] = api_key
        if api_key_env:
            entry["api_key_env"] = api_key_env
        if litellm_provider:
            entry["litellm_provider"] = litellm_provider

        models: dict[str, dict] = {}
        seen_ids: set[str] = set()
        for entry_data in self._model_entries:
            model_id = entry_data["model_id"].strip()
            if not model_id:
                continue
            if model_id in seen_ids:
                self.query_one("#provider-form-error", Static).update(f"Duplicate model id: {model_id}")
                return
            seen_ids.add(model_id)
            overrides: dict = {}
            mit = entry_data["max_input_tokens"].strip()
            if mit:
                try:
                    overrides["max_input_tokens"] = int(mit)
                except ValueError:
                    self.query_one("#provider-form-error", Static).update(
                        f"max_input_tokens must be an integer for {model_id!r}."
                    )
                    return
            mot = entry_data["max_output_tokens"].strip()
            if mot:
                try:
                    overrides["max_output_tokens"] = int(mot)
                except ValueError:
                    self.query_one("#provider-form-error", Static).update(
                        f"max_output_tokens must be an integer for {model_id!r}."
                    )
                    return
            if entry_data["supports_vision"]:
                overrides["supports_vision"] = True
            mode = entry_data["mode"].strip()
            if mode:
                overrides["mode"] = mode
            models[model_id] = overrides
        if models:
            entry["models"] = models

        result = {"_alias": alias, **entry}
        self.dismiss(result)


class NewMCPServerForm(ModalScreen[dict | None]):
    """Modal form to add or edit an MCP server entry."""

    CSS = """
    NewMCPServerForm {
        align: center middle;
    }
    #mcp-form-container {
        width: 60;
        height: auto;
        border: thick $primary;
        background: $surface;
        padding: 1 2;
    }
    #mcp-form-container Label {
        text-style: bold;
        height: 1;
        margin-top: 1;
    }
    #mcp-form-container Input {
        height: 3;
    }
    #mcp-form-buttons {
        width: 100%;
        height: auto;
        align-horizontal: center;
        margin-top: 1;
    }
    #mcp-form-buttons Button {
        margin: 0 1;
        height: 3;
    }
    #mcp-form-error {
        color: $error;
        height: 1;
    }
    """

    def __init__(self, title: str, initial: dict | None = None) -> None:
        super().__init__()
        self._title = title
        self._initial = initial or {}

    def compose(self) -> ComposeResult:
        with Vertical(id="mcp-form-container"):
            yield Static(self._title, id="mcp-form-title")
            yield Static("", id="mcp-form-error")
            yield Label("Name (e.g. 'my-server')")
            yield Input(
                placeholder="my-server",
                value=self._initial.get("_name", ""),
                id="mf-name",
            )
            yield Label("Command")
            yield Input(
                placeholder="node",
                value=self._initial.get("command", ""),
                id="mf-command",
            )
            yield Label("Args (comma-separated)")
            yield Input(
                placeholder="server.js, --port, 3000",
                value=", ".join(self._initial.get("args", [])) if self._initial.get("args") else "",
                id="mf-args",
            )
            yield Label("URL (for SSE servers, leave command/args blank)")
            yield Input(
                placeholder="http://localhost:3000/sse",
                value=self._initial.get("url", ""),
                id="mf-url",
            )
            with Horizontal(id="mcp-form-buttons"):
                yield Button("Save", variant="primary", id="mf-save")
                yield Button("Cancel", variant="default", id="mf-cancel")

    def on_mount(self) -> None:
        self.query_one("#mf-name", Input).focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "mf-save":
            self._do_save()
        else:
            self.dismiss(None)

    def key_escape(self) -> None:
        self.dismiss(None)

    def _do_save(self) -> None:
        name = self.query_one("#mf-name", Input).value.strip()
        if not name:
            self.query_one("#mcp-form-error", Static).update("Name is required.")
            return

        command = self.query_one("#mf-command", Input).value.strip()
        args_str = self.query_one("#mf-args", Input).value.strip()
        url = self.query_one("#mf-url", Input).value.strip()

        entry: dict = {}
        if url:
            entry["url"] = url
        elif command:
            entry["command"] = command
            if args_str:
                entry["args"] = [a.strip() for a in args_str.split(",") if a.strip()]
            else:
                entry["args"] = []
        else:
            self.query_one("#mcp-form-error", Static).update("Either command or url is required.")
            return

        result = {"_name": name, **entry}
        self.dismiss(result)


class ConfirmScreen(ModalScreen[str | None]):
    """Confirmation modal used for discarding/saving unsaved settings.

    Dismisses with one of:
      - "discard"     → discard changes and close settings
      - "save_close"  → save changes and close settings
      - None          → keep editing (cancel)
    """

    CSS = """
    ConfirmScreen {
        align: center middle;
    }
    #settings-confirm-container {
        width: 72;
        height: auto;
        max-height: 20;
        background: $surface;
        padding: 1 2;
    }
    #settings-confirm-container Label {
        text-align: center;
        margin-bottom: 1;
    }
    #settings-confirm-buttons {
        height: 3;
        align-horizontal: center;
        align-vertical: middle;
    }
    #settings-confirm-buttons Button {
        margin: 0 1;
        height: 3;
    }
    """

    def __init__(self, title: str, message: str) -> None:
        super().__init__()
        self._title = title
        self._message = message

    def compose(self) -> ComposeResult:
        with Vertical(id="settings-confirm-container"):
            yield Label(self._title)
            yield Label(self._message)
            with Horizontal(id="settings-confirm-buttons"):
                yield Button("Discard", variant="error", id="settings-confirm-yes")
                yield Button("Keep Editing", variant="default", id="settings-confirm-no")
                yield Button("Close and Save", variant="success", id="settings-confirm-save")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "settings-confirm-yes":
            self.dismiss("discard")
        elif event.button.id == "settings-confirm-save":
            self.dismiss("save_close")
        else:
            self.dismiss(None)

    def key_escape(self) -> None:
        self.dismiss(None)


class SettingsScreen(ModalScreen[Config | None]):
    """Full-screen settings modal with tabbed navigation.

    Returns the modified `Config` on Save, or `None` on Cancel.

    Esc behavior:
      - On a sub-form (provider/MCP) → dismisses the sub-form back to settings
      - On the settings tabs → closes the settings modal
    """

    CSS = """
    SettingsScreen {
        align: center middle;
    }

    #settings-container {
        width: 90%;
        height: 90%;
        background: $surface;
        padding: 0;
    }

    #settings-header {
        dock: top;
        height: 1;
        padding: 0 2;
        background: $primary-darken-2;
        text-style: bold;
    }

    #settings-tabs {
        dock: top;
        width: 100%;
        height: 1;
    }

    #settings-content {
        height: 1fr;
        padding: 1 2;
    }

    #settings-footer {
        dock: bottom;
        height: 1;
        min-height: 1;
        padding: 0 2;
        background: $surface;
    }

    #settings-footer-info {
        height: 1;
        width: 100%;
        align-horizontal: left;
        align-vertical: middle;
    }

    #settings-hint {
        width: 1fr;
        height: 1;
        color: $text-muted;
    }

    #settings-error {
        color: $error;
        height: 1;
        width: 1fr;
    }

    .settings-section-title {
        text-style: bold;
        height: 1;
        margin-bottom: 1;
    }

    .settings-row {
        height: 3;
        margin-bottom: 0;
        align-vertical: middle;
    }

    .settings-label {
        width: 30;
        height: 3;
        padding: 0 1;
        content-align: left middle;
    }

    .settings-input {
        width: 1fr;
        height: 3;
    }

    .settings-list-item {
        margin-bottom: 0;
        border: solid $surface-lighten-1;
        padding: 0 1;
        height: 5;
        align-vertical: middle;
    }

    .settings-list-item-label {
        text-style: bold;
        width: 20;
        height: 1;
    }

    .settings-list-item-detail {
        color: $text-muted;
        width: 1fr;
        height: 1;
    }

    .mcp-list-item {
        margin-bottom: 0;
        border: solid $surface-lighten-1;
        padding: 0 1;
        height: 5;
        align-vertical: middle;
    }

    .tier-row {
        height: 3;
        margin-bottom: 0;
        align-vertical: middle;
    }

    .tier-label {
        width: 20;
        height: 3;
        padding: 0 1;
        text-style: bold;
        content-align: left middle;
    }

    .tier-current {
        width: 1fr;
        height: 3;
        padding: 0 1;
        color: $text-muted;
        content-align: left middle;
    }

    .item-actions {
        dock: right;
        width: auto;
        height: 3;
        align-vertical: middle;
    }

    .item-actions Button {
        margin: 0 1;
        height: 3;
        min-width: 0;
        width: auto;
        content-align: center middle;
    }

    .tier-row Button {
        height: 3;
        min-width: 0;
        width: auto;
        content-align: center middle;
    }

    #providers-add, #mcp-add {
        height: 3;
        margin-top: 0;
        content-align: center middle;
        text-align: center;
    }

    .settings-add-row {
        align-vertical: middle;
        height: 3;
        margin-top: 1;
    }
    """

    TAB_FIELDS: dict[str, tuple[str, ...]] = {
        "Providers": ("providers",),
        "MCP Servers": ("mcp_servers",),
        "Tier Models": ("tier_models", "default_model"),
        "RAG": ("rag",),
        "General": (
            "default_model",
            "command_timeout",
            "read_line_limit",
            "grep_max_results",
            "directory_tree_depth",
            "ast_max_file_size",
            "theme",
            "personality",
        ),
    }

    TABS = ["Providers", "MCP Servers", "Tier Models", "RAG", "General"]

    # Config fields that map directly to Input widgets
    _RAG_INT_FIELDS = {
        "rag-chunk_size": "chunk_size",
        "rag-chunk_overlap": "chunk_overlap",
        "rag-top_k": "top_k",
        "rag-max_file_size": "max_file_size",
    }
    _GEN_INT_FIELDS = {
        "gen-command_timeout": "command_timeout",
        "gen-read_line_limit": "read_line_limit",
        "gen-grep_max_results": "grep_max_results",
        "gen-directory_tree_depth": "directory_tree_depth",
        "gen-ast_max_file_size": "ast_max_file_size",
    }

    def __init__(self, config: Config) -> None:
        super().__init__()
        self._config = self._clone_config(config)
        self._original = self._clone_config(config)
        self._items_cache: list[tuple[str, str]] = []

    def compose(self) -> ComposeResult:
        with Vertical(id="settings-container"):
            yield Static("Settings", id="settings-header")
            yield Tabs(*[Tab(name, id=name.lower().replace(" ", "-")) for name in self.TABS], id="settings-tabs")
            yield ScrollableContainer(id="settings-content")
            with Vertical(id="settings-footer"), Horizontal(id="settings-footer-info"):
                yield Static("Ctrl+S save • Esc close without saving", id="settings-hint")
                yield Static("", id="settings-error")

    def on_mount(self) -> None:
        self._render_tab("providers")
        self._update_tab_labels()

    def on_tabs_tab_activated(self, event: Tabs.TabActivated) -> None:
        tab_id = event.tab.id or "providers"
        self._render_tab(tab_id)

    def on_input_changed(self, event: Input.Changed) -> None:
        """Update self._config in real-time as inputs change.

        This prevents losing values when switching tabs (since only the
        active tab's widgets exist in the DOM).
        """
        wid = event.input.id or ""
        val = event.value.strip()

        if wid in self._RAG_INT_FIELDS:
            field = self._RAG_INT_FIELDS[wid]
            try:
                intval = int(val) if val else 0
                self._config.rag = RAGConfig(**{**asdict(self._config.rag), field: intval})
            except ValueError:
                pass
            self._mark_dirty("rag")
        elif wid in self._GEN_INT_FIELDS:
            field = self._GEN_INT_FIELDS[wid]
            try:
                intval = int(val) if val else 0
                setattr(self._config, field, intval)
            except ValueError:
                pass
            self._mark_dirty("general")

    def _render_tab(self, tab_id: str) -> None:
        container = self.query_one("#settings-content", ScrollableContainer)
        container.remove_children()
        getattr(self, f"_render_{tab_id.replace('-', '_')}")(container)

    # ── Providers tab ─────────────────────────────────────────────────

    def _render_providers(self, container: ScrollableContainer) -> None:
        container.mount(Static("Providers", classes="settings-section-title"))
        container.mount(Static("Configure API providers and their models.", classes="settings-list-item-detail"))

        items = []
        for alias, entry in self._config.providers.items():
            models = list(entry.get("models", {}).keys())[:3]
            models_str = ", ".join(models) if models else "no models"
            detail = f"{entry.get('base_url', '') or entry.get('litellm_provider', 'unknown')} — {models_str}"
            items.append((alias, detail))

        self._render_keyed_list(container, items, "prov")

        container.mount(
            Horizontal(
                Button("Add Provider", variant="primary", id="providers-add", classes="settings-add-btn"),
                classes="settings-row settings-add-row",
            )
        )

    def _on_provider_action(self, alias: str, action: str) -> None:
        if action == "edit":
            entry = self._config.providers.get(alias, {})
            initial = {"_alias": alias, **entry}
            self.app.push_screen(
                NewProviderForm(f"Edit Provider: {alias}", initial),
                partial(self._on_edit_provider_result, original_alias=alias),
            )
        elif action == "delete":
            self._config.providers.pop(alias, None)
            self._refresh_tab()
            self._mark_dirty("providers")

    def _on_edit_provider_result(self, result: dict | None, original_alias: str | None = None) -> None:
        if result is not None:
            alias = result.pop("_alias")
            if original_alias and original_alias != alias:
                if alias in self._config.providers:
                    self.notify(
                        f"Provider '{alias}' already exists; rename cancelled.",
                        severity="warning",
                    )
                    self._refresh_tab()
                    self._mark_dirty("providers")
                    return
                self._config.providers.pop(original_alias, None)
            self._config.providers[alias] = result
            self._refresh_tab()
            self._mark_dirty("providers")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn_id = event.button.id or ""

        if btn_id.startswith("prov-edit-") or btn_id.startswith("prov-del-"):
            idx = int(btn_id.split("-")[-1])
            if 0 <= idx < len(self._items_cache):
                alias = self._items_cache[idx][0]
                if btn_id.startswith("prov-edit-"):
                    self._on_provider_action(alias, "edit")
                else:
                    self._on_provider_action(alias, "delete")
            return

        if btn_id.startswith("mcp-edit-") or btn_id.startswith("mcp-del-"):
            idx = int(btn_id.split("-")[-1])
            if 0 <= idx < len(self._items_cache):
                name = self._items_cache[idx][0]
                if btn_id.startswith("mcp-edit-"):
                    self._on_mcp_action(name, "edit")
                else:
                    self._on_mcp_action(name, "delete")
            return

        if btn_id.startswith("tier-change-"):
            tier = btn_id[len("tier-change-") :]
            self._open_tier_model_picker(tier)
            return

        if btn_id.startswith("gen-pick-"):
            field = btn_id[len("gen-pick-") :]
            self._open_general_picker(field)
            return

        if btn_id.startswith("rag-pick-"):
            field = btn_id[len("rag-pick-") :]
            self._open_rag_picker(field)
            return

        if btn_id == "providers-add":
            self.app.push_screen(NewProviderForm("Add Provider"), self._on_add_provider_result)
        elif btn_id == "mcp-add":
            self.app.push_screen(NewMCPServerForm("Add MCP Server"), self._on_add_mcp_result)

    def _on_add_provider_result(self, result: dict | None) -> None:
        if result is not None:
            alias = result.pop("_alias")
            self._config.providers[alias] = result
            self._refresh_tab()
            self._mark_dirty("providers")

    def _refresh_tab(self) -> None:
        tabs = self.query_one("#settings-tabs", Tabs)
        active = tabs.active
        if active:
            self._render_tab(active)
        self._update_tab_labels()

    # ── MCP Servers tab ───────────────────────────────────────────────

    def _render_mcp_servers(self, container: ScrollableContainer) -> None:
        container.mount(Static("MCP Servers", classes="settings-section-title"))
        container.mount(Static("Configure MCP tool servers.", classes="settings-list-item-detail"))

        self._render_mcp_list(container)

        container.mount(
            Horizontal(
                Button("Add MCP Server", variant="primary", id="mcp-add", classes="settings-add-btn"),
                classes="settings-row settings-add-row",
            )
        )

    def _render_mcp_list(self, container: ScrollableContainer) -> None:
        items = []
        for name, entry in self._config.mcp_servers.items():
            if "url" in entry:
                detail = f"SSE: {entry['url']}"
            else:
                detail = f"{entry.get('command', '?')} {' '.join(entry.get('args', []))}"
            items.append((name, detail))
        self._items_cache = items

        for idx, (name, detail) in enumerate(items):
            container.mount(
                Horizontal(
                    Label(name, classes="settings-list-item-label"),
                    Static(detail, classes="settings-list-item-detail"),
                    Horizontal(
                        Button("Edit", id=f"mcp-edit-{idx}"),
                        Button("Delete", id=f"mcp-del-{idx}"),
                        classes="item-actions",
                    ),
                    classes="mcp-list-item",
                )
            )

    def _on_mcp_action(self, name: str, action: str) -> None:
        if action == "edit":
            entry = self._config.mcp_servers.get(name, {})
            initial = {"_name": name, **entry}
            self.app.push_screen(
                NewMCPServerForm(f"Edit MCP Server: {name}", initial),
                partial(self._on_edit_mcp_result, original_name=name),
            )
        elif action == "delete":
            self._config.mcp_servers.pop(name, None)
            self._refresh_tab()
            self._mark_dirty("mcp_servers")

    def _on_edit_mcp_result(self, result: dict | None, original_name: str | None = None) -> None:
        if result is not None:
            name = result.pop("_name")
            if original_name and original_name != name:
                if name in self._config.mcp_servers:
                    self.notify(
                        f"MCP server '{name}' already exists; rename cancelled.",
                        severity="warning",
                    )
                    self._refresh_tab()
                    self._mark_dirty("mcp_servers")
                    return
                self._config.mcp_servers.pop(original_name, None)
            self._config.mcp_servers[name] = result
            self._refresh_tab()
            self._mark_dirty("mcp_servers")

    def _on_add_mcp_result(self, result: dict | None) -> None:
        if result is not None:
            name = result.pop("_name")
            self._config.mcp_servers[name] = result
            self._refresh_tab()
            self._mark_dirty("mcp_servers")

    # ── Tier Models tab ───────────────────────────────────────────────

    TIERS = ["tolo", "tainha", "papudo", "papaca"]

    def _render_tier_models(self, container: ScrollableContainer) -> None:
        container.mount(Static("Tier Models", classes="settings-section-title"))
        container.mount(
            Static(
                "Map each agent tier to a model (alias/model format). Click Change to pick from configured providers.",
                classes="settings-list-item-detail",
            )
        )

        picker_items = _build_model_picker_items(self._config)
        if not picker_items:
            container.mount(
                Static(
                    "No models available. Add providers and models in the Providers tab first.",
                    classes="settings-list-item-detail",
                )
            )
            return

        for tier in self.TIERS:
            current = self._config.tier_models.get(tier, self._config.default_model)
            container.mount(
                Horizontal(
                    Label(f"  {tier}:", classes="tier-label"),
                    Static(current or "—", classes="tier-current"),
                    Button("Change", id=f"tier-change-{tier}"),
                    classes="tier-row",
                )
            )

    def _open_tier_model_picker(self, tier: str) -> None:
        items = _build_model_picker_items(self._config)
        if not items:
            return

        def _on_picked(selected: str | None) -> None:
            if not selected:
                return
            self._config.tier_models[tier] = selected
            self._refresh_tab()
            self._mark_dirty("tier_models")

        self.app.push_screen(OptionPicker(items), _on_picked)

    # ── RAG tab ───────────────────────────────────────────────────────

    def _render_rag(self, container: ScrollableContainer) -> None:
        container.mount(Static("RAG Settings", classes="settings-section-title"))
        container.mount(
            Static("Configure retrieval-augmented generation parameters.", classes="settings-list-item-detail")
        )

        fields = [
            ("chunk_size", "Chunk Size", str(self._config.rag.chunk_size)),
            ("chunk_overlap", "Chunk Overlap", str(self._config.rag.chunk_overlap)),
            ("top_k", "Top K", str(self._config.rag.top_k)),
            ("max_file_size", "Max File Size (bytes)", str(self._config.rag.max_file_size)),
        ]
        for field_id, label, value in fields:
            container.mount(
                Horizontal(
                    Label(f"  {label}:", classes="settings-label"),
                    Input(value=value, id=f"rag-{field_id}", classes="settings-input"),
                    classes="settings-row",
                )
            )

        container.mount(
            Horizontal(
                Label("  Embedding Model:", classes="settings-label"),
                Static(
                    self._config.rag.embedding_model or "—", id="rag-embedding_model-display", classes="tier-current"
                ),
                Button("Change", id="rag-pick-embedding_model"),
                classes="settings-row",
            )
        )

    def _open_rag_picker(self, field: str) -> None:
        if field == "embedding_model":
            self._open_embedding_model_picker()

    def _open_embedding_model_picker(self) -> None:
        items: list[PickerItem] = []

        for model_id in _list_fastembed_models():
            ref = f"fastembed/{model_id}"
            items.append(PickerItem(label=f"  {ref}", id=ref))

        items.extend(_build_model_picker_items(self._config, mode="embeddings"))

        if not items:
            return

        current = self._config.rag.embedding_model
        if current:
            for item in items:
                if item.id == current:
                    item.label = f"● {item.label.strip()}"
                    break

        def _on_picked(selected: str | None) -> None:
            if not selected:
                return
            self._config.rag = RAGConfig(**{**asdict(self._config.rag), "embedding_model": selected})
            self._refresh_tab()
            self._mark_dirty("rag")

        self.app.push_screen(OptionPicker(items, header="Embedding Models"), _on_picked)

    # ── General tab ───────────────────────────────────────────────────

    def _render_general(self, container: ScrollableContainer) -> None:
        container.mount(Static("General Settings", classes="settings-section-title"))
        container.mount(Static("Default model, directory options, and timeouts.", classes="settings-list-item-detail"))

        container.mount(
            Horizontal(
                Label("  Default Model:", classes="settings-label"),
                Static(self._config.default_model or "—", id="gen-default_model-display", classes="tier-current"),
                Button("Change", id="gen-pick-default_model"),
                classes="settings-row",
            )
        )

        gen_int_fields = [
            ("command_timeout", "Command Timeout (s)", str(self._config.command_timeout)),
            ("read_line_limit", "Read Line Limit", str(self._config.read_line_limit)),
            ("grep_max_results", "Grep Max Results", str(self._config.grep_max_results)),
            ("directory_tree_depth", "Directory Tree Depth", str(self._config.directory_tree_depth)),
            ("ast_max_file_size", "AST Max File Size (bytes)", str(self._config.ast_max_file_size)),
        ]
        for field_id, label, value in gen_int_fields:
            container.mount(
                Horizontal(
                    Label(f"  {label}:", classes="settings-label"),
                    Input(value=value, id=f"gen-{field_id}", classes="settings-input"),
                    classes="settings-row",
                )
            )

        container.mount(
            Horizontal(
                Label("  Theme:", classes="settings-label"),
                Static(self._config.theme or "—", id="gen-theme-display", classes="tier-current"),
                Button("Change", id="gen-pick-theme"),
                classes="settings-row",
            )
        )

        container.mount(
            Horizontal(
                Label("  Personality:", classes="settings-label"),
                Static(self._config.personality or "—", id="gen-personality-display", classes="tier-current"),
                Button("Change", id="gen-pick-personality"),
                classes="settings-row",
            )
        )

    def _open_general_picker(self, field: str) -> None:
        if field == "default_model":
            self._open_default_model_picker()
        elif field == "theme":
            self._open_theme_picker()
        elif field == "personality":
            self._open_personality_picker()

    def _open_default_model_picker(self) -> None:
        items = _build_model_picker_items(self._config)
        if not items:
            return

        current = self._config.default_model
        if current:
            for item in items:
                if item.id == current:
                    item.label = f"● {item.label.strip()}"
                    break

        def _on_picked(selected: str | None) -> None:
            if not selected:
                return
            self._config.default_model = selected
            self._refresh_tab()
            self._mark_dirty("general")

        self.app.push_screen(OptionPicker(items), _on_picked)

    def _open_theme_picker(self) -> None:
        from stupidex.themes import get_theme_registry

        registry = get_theme_registry()
        current = self._config.theme
        items = [
            PickerItem(label=f"● {name}" if name == current else f"  {name}", id=name)
            for name in registry.list_themes()
        ]

        def _on_picked(selected: str | None) -> None:
            if not selected:
                return
            self._config.theme = selected
            self._refresh_tab()
            self._mark_dirty("general")

        self.app.push_screen(OptionPicker(items, header="Themes"), _on_picked)

    def _open_personality_picker(self) -> None:
        from stupidex.personality import load_personalities

        personalities = load_personalities()
        current = self._config.personality
        items = [PickerItem(label=f"● {p}" if p == current else f"  {p}", id=p) for p in personalities]

        def _on_picked(selected: str | None) -> None:
            if not selected:
                return
            self._config.personality = selected
            self._refresh_tab()
            self._mark_dirty("general")

        self.app.push_screen(OptionPicker(items, header="Personalities"), _on_picked)

    # ── Helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _clone_config(config: Config) -> Config:
        return Config(**asdict(config))

    def _render_keyed_list(
        self,
        container: ScrollableContainer,
        items: list[tuple[str, str]],
        action_prefix: str,
    ) -> None:
        self._items_cache = items
        for idx, (key, detail) in enumerate(items):
            item = Horizontal(
                Label(key, classes="settings-list-item-label"),
                Static(detail, classes="settings-list-item-detail"),
                Horizontal(
                    Button("Edit", id=f"{action_prefix}-edit-{idx}"),
                    Button("Delete", id=f"{action_prefix}-del-{idx}"),
                    classes="item-actions",
                ),
                classes="settings-list-item",
            )
            container.mount(item)

    def _collect_modified_config(self) -> Config:
        """Return the config with all live edits applied.

        RAG and General numeric fields are updated in real-time via
        ``on_input_changed``, so we just return ``self._config``.
        Picker-based fields (default_model, theme, personality,
        embedding_model, tier_models) are also set directly on ``self._config``.
        """
        return self._config

    def _do_save(self, close: bool = False) -> None:
        """Validate, persist and (optionally) close.

        On every save the config is written to disk and live-applied: the
        theme is switched in-place via ``app.switch_theme`` so it takes effect
        immediately without a restart. ``mcp_servers`` is the only field that
        still binds at startup, so a restart is only needed when it changed —
        the caller handles that prompt on close.
        """
        config = self._collect_modified_config()
        errors = validate_config(config)
        if errors:
            self.query_one("#settings-error", Static).update("  ".join(f"• {e}" for e in errors[:3]))
            return

        from stupidex.config import ConfigManager

        ConfigManager._instance = config
        ConfigManager.save()

        if config.theme != self._original.theme:
            self.app.switch_theme(config.theme)

        self._config = self._clone_config(config)
        self._original = self._clone_config(config)
        self.query_one("#settings-error", Static).update("")
        self._update_tab_labels()

        if close:
            self.dismiss(self._config)
        else:
            self.app.notify("Settings saved.", severity="information")

    def key_ctrl_s(self) -> None:
        self._do_save(close=False)

    def key_escape(self) -> None:
        self._attempt_close()

    def _attempt_close(self) -> None:
        if self._config_differs():
            self._push_confirm_discard()
        else:
            self.dismiss(None)

    # ── Dirty tracking & confirmation ─────────────────────────────────

    def _field_differs(self, field: str) -> bool:
        cur = getattr(self._config, field, None)
        orig = getattr(self._original, field, None)
        if field == "rag":
            return asdict(cur) != asdict(orig)
        return cur != orig

    def _tab_differs(self, tab: str) -> bool:
        return any(self._field_differs(f) for f in self.TAB_FIELDS.get(tab, ()))

    def _config_differs(self) -> bool:
        return any(self._field_differs(f) for fields in self.TAB_FIELDS.values() for f in fields)

    def _dirty_tab_names(self) -> list[str]:
        return [tab for tab in self.TAB_FIELDS if self._tab_differs(tab)]

    def _mark_dirty(self, field: str, _from_tab: str | None = None) -> None:
        self._update_tab_labels()

    def _update_tab_labels(self) -> None:
        """Refresh tab labels, prefixing changed tabs with '● '."""
        try:
            tabs = self.query_one("#settings-tabs", Tabs)
        except Exception:
            return
        for tab in tabs.query(Tab):
            name = tab.label.plain.lstrip("● ").strip()
            if self._tab_differs(name):
                tab.label = f"● {name}"
            else:
                tab.label = name

    def _push_confirm_discard(self) -> None:
        tabs = self._dirty_tab_names()
        summary = ", ".join(tabs) if tabs else "settings"
        self.app.push_screen(
            ConfirmScreen(
                "Unsaved changes",
                f"You have unsaved changes to: {summary}.",
            ),
            self._on_confirm_discard,
        )

    def _on_confirm_discard(self, choice: str | None) -> None:
        if choice == "discard":
            self.dismiss(None)
        elif choice == "save_close":
            self._do_save(close=True)
