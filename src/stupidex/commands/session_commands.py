import logging
from functools import partial

from textual.app import App
from textual.command import DiscoveryHit, Hit, Hits, Matcher, Provider

from stupidex.config import (
    Config,
    get_config,
    get_current_personality,
    get_current_theme,
    set_current_personality,
    set_current_theme,
)
from stupidex.llm.providers import discover_provider_models, resolve_model_metadata
from stupidex.personality import load_personalities
from stupidex.screens.picker import OptionPicker, PickerItem

log = logging.getLogger(__name__)

COMMANDS = {
    "/new": "Start a new session",
    "/sessions": "Load a saved session from disk",
    "/rename": "Rename the active session",
    "/delete": "Delete a session",
    "/model": "Change the model for the current session",
    "/theme": "Switch the application theme",
    "/personality": "Switch the agent personality",
    "/settings": "Open the configuration settings screen",
    "/index-rag": "Index the project for RAG semantic search",
    "/index-ast": "Re-scan the project for AST symbol indexing",
    "/rag status": "Show RAG index status",
    "/rag clear": "Clear the RAG index",
}


def _token_shorthand(tokens: int) -> str:
    """Render an integer token count as an `Nk` shorthand (128000 -> '128k').

    Values below 1000 are returned as a plain decimal (`500` -> `'500'`) so
    the suffix does not misrepresent the magnitude.
    """
    if tokens >= 1000:
        return f"{tokens // 1000}k"
    return str(tokens)


# Column widths for the /model picker's pseudo-table layout. Picked so the
# widest realistic alias/model_id (e.g. `anthropic-prod/claude-3-opus`) fits
# while keeping the picker container at ~70 columns (see main.tcss).
_MODEL_COL_REF_WIDTH = 36
_MODEL_COL_TOKEN_WIDTH = 6
_MODEL_COL_VISION_WIDTH = 6

# Header shown above the option list -- same column widths as the row labels
# produced by `_format_model_label` so the columns line up visually.
_MODEL_PICKER_HEADER = (
    f"{'Model'.ljust(_MODEL_COL_REF_WIDTH)}  "
    f"{'In'.rjust(_MODEL_COL_TOKEN_WIDTH)}  "
    f"{'Out'.rjust(_MODEL_COL_TOKEN_WIDTH)}  "
    f"{'Vision'.rjust(_MODEL_COL_VISION_WIDTH)}"
)


def _format_model_label(alias: str, model_id: str, metadata: dict) -> str:
    """Render a tabular label for the `/model` picker.

    Each label is a single padded row with four fixed-width columns so multiple
    options align as a pseudo-table when listed together:

        ```
        work-openai/gpt-4o                          128k    16k     yes
        anthropic-prod/claude-3-opus               200k     4k      no
        custom/unknown-model                       n/a    n/a      n/a
        ```

    The `_MODEL_PICKER_HEADER` constant uses the same column widths for a
    column-titles row placed above the option list (via `OptionPicker`'s
    optional `header=` parameter).

    * `max_input_tokens` / `max_output_tokens` -- rendered with `_token_shorthand`
      when present (int), otherwise `n/a` (unknown).
    * `supports_vision` -- `yes` if truthy, `no` otherwise.
    * Model refs that exceed `_MODEL_COL_REF_WIDTH` are truncated with an ellipsis
      so the columns stay aligned; the option `id` retains the full ref.
    """
    ref = f"{alias}/{model_id}"
    if len(ref) > _MODEL_COL_REF_WIDTH:
        ref = ref[: _MODEL_COL_REF_WIDTH - 1] + "\u2026"
    ref_str = ref.ljust(_MODEL_COL_REF_WIDTH)

    max_in = metadata.get("max_input_tokens")
    max_out = metadata.get("max_output_tokens")
    in_str = _token_shorthand(max_in) if isinstance(max_in, int) else "n/a"
    out_str = _token_shorthand(max_out) if isinstance(max_out, int) else "n/a"

    vision_str = "yes" if metadata.get("supports_vision") else "no"

    return (
        f"{ref_str}  "
        f"{in_str.rjust(_MODEL_COL_TOKEN_WIDTH)}  "
        f"{out_str.rjust(_MODEL_COL_TOKEN_WIDTH)}  "
        f"{vision_str.rjust(_MODEL_COL_VISION_WIDTH)}"
    )


def _build_model_picker_items(cfg: Config, mode: str = "chat") -> list[PickerItem]:
    """Build the picker-list for `/model` from configured providers + resolved metadata.

    Iterates each configured provider's declared `models` dict (per U1),
    hydrates capability metadata via `resolve_model_metadata` (per U2), and
    builds a `PickerItem` per `(alias, model_id)` pair with the `id` set to
    `f"{alias}/{model_id}"` -- the form `change_model` stores.

    Only models whose resolved `mode` matches the `mode` argument are included,
    so chat-model pickers (Tiers, default model, `/model`) show only chat
    models and the embedding-model picker shows only embedding models.

    Never raises: malformed provider entries and metadata-resolution failures
    are logged and skipped, keeping the rest of the list intact. The validator
    (U1) should have rejected malformed entries already, so the try/except is
    purely defensive.
    """
    items: list[PickerItem] = []
    for alias, provider_entry in cfg.providers.items():
        if not isinstance(provider_entry, dict):
            log.warning(
                "Skipping provider %r: entry must be a dict, got %s",
                alias,
                type(provider_entry).__name__,
            )
            continue
        models = provider_entry.get("models", {})
        if not isinstance(models, dict):
            log.warning(
                "Skipping provider %r: 'models' must be a dict, got %s",
                alias,
                type(models).__name__,
            )
            continue
        # Hybrid fallback (R10): if no models are declared for this provider,
        # discover them from the endpoint's GET /models. Well-known models
        # still get badges + token shorthand from litellm's registry. Respects
        # STUPIDEX_DISABLE_MODEL_DISCOVERY for strict configured-only behavior.
        if not models:
            try:
                discovered = discover_provider_models(alias)
            except Exception:  # noqa: BLE001 -- discovery is best-effort
                discovered = []
            if not discovered:
                log.debug(
                    "Skipping provider %r: no declared models and discovery yielded nothing",
                    alias,
                )
                continue
            models = {m: {} for m in discovered}
        for model_id in models:
            try:
                metadata = resolve_model_metadata(alias, model_id)
                if metadata.get("mode") != mode:
                    continue
                label = _format_model_label(alias, model_id, metadata)
                items.append(PickerItem(label=label, id=f"{alias}/{model_id}"))
            except Exception:  # noqa: BLE001 -- defensive; resolver never raises by design
                log.warning(
                    "Skipping model %r for provider %r: metadata resolution failed",
                    model_id,
                    alias,
                )
                continue
    return items


async def execute_command(app: App, cmd: str) -> None:
    match cmd:
        case "/new":
            app.sessions.create()
            await app.rerender_all()
        case "/model":
            cfg = get_config()
            items = _build_model_picker_items(cfg)
            if not items:
                app.notify(
                    "No models configured. Add providers to your config.",
                    severity="warning",
                )
                return

            async def on_picked(result: str | None):
                if result:
                    app.sessions.change_model(result)
                    await app.rerender_footer()

            app.push_screen(OptionPicker(items, header=_MODEL_PICKER_HEADER), on_picked)

        case "/sessions":
            saved = app.sessions.list_saved()
            if not saved:
                app.notify("No saved sessions found.", severity="information")
                return
            items = [PickerItem(label=s["name"], id=s["id"]) for s in saved]

            async def on_sessions_picked(result: str | None):
                if result:
                    session = app.sessions.load(result)
                    if session:
                        await app.rerender_all()
                    else:
                        app.notify("Failed to load session", severity="error")

            app.push_screen(OptionPicker(items), on_sessions_picked)
        case "/delete":
            saved = app.sessions.list_saved()
            if not saved:
                app.notify("No saved sessions found.", severity="information")
                return
            items = [PickerItem(label=s["name"], id=s["id"]) for s in saved]

            async def on_sessions_delete_picked(result: str | None):
                if result:
                    deleted = app.sessions.delete(result)
                    if not deleted:
                        from stupidex.storage import delete_session
                        deleted = delete_session(result)
                    if deleted:
                        app.notify("Session deleted.", severity="information")
                        if not app.sessions.active:
                            app.sessions.create()
                            await app.rerender_all()
                    else:
                        app.notify("Failed to delete session.", severity="error")

            app.push_screen(OptionPicker(items), on_sessions_delete_picked)
        case "/rename":
            if not app.sessions.active:
                app.notify("No active session.", severity="error")
                return
            from stupidex.screens.input_modal import InputModal

            async def on_rename_result(result: str | None):
                if result and result.strip():
                    app.sessions.active.name = result.strip()
                    app.query_one("#title").update(result.strip())
                    app.sessions.save_active()

            app.push_screen(
                InputModal(
                    title="Rename Session",
                    placeholder="New session name",
                    default=app.sessions.active.name,
                ),
                on_rename_result,
            )

        case "/theme":
            from stupidex.themes import get_theme_registry

            registry = get_theme_registry()
            current = get_current_theme()
            items = [
                PickerItem(label=f"● {name}" if name == current else f"  {name}", id=name)
                for name in registry.list_themes()
            ]

            async def on_theme_picked(result: str | None):
                if result:
                    app.switch_theme(result)
                    set_current_theme(result)

            app.push_screen(OptionPicker(items), on_theme_picked)
        case "/personality":
            personalities = load_personalities()
            current = get_current_personality()
            items = [PickerItem(label=f"● {p}" if p == current else f"  {p}", id=p) for p in personalities]

            async def on_personality_picked(result: str | None):
                if result:
                    set_current_personality(result)

            app.push_screen(OptionPicker(items), on_personality_picked)
        case "/settings":
            from stupidex.config import ConfigManager
            from stupidex.screens.settings import SettingsScreen

            cfg = get_config()

            async def on_settings_result(result: Config | None):
                # result is None when the modal closed without "save & close"
                # (Cancel/Esc). But Ctrl+S saves internally to ConfigManager
                # without dismissing, so a None result can still carry saved
                # mcp_servers changes that warrant a restart prompt. Only short
                # -circuit when result is None AND mcp_servers are unchanged.
                if result is None:
                    current = ConfigManager._instance
                    if current is None or current.mcp_servers == cfg.mcp_servers:
                        return
                    saved = current
                else:
                    ConfigManager._instance = result
                    ConfigManager.save()
                    saved = result
                needs_restart = saved.mcp_servers != cfg.mcp_servers
                if needs_restart:
                    from stupidex.screens.settings import ConfirmScreen

                    async def on_restart_confirm(confirmed: bool | None) -> None:
                        if confirmed:
                            app.request_restart()
                        else:
                            app.notify(
                                "Settings saved. Restart for MCP server changes to take effect.",
                                severity="information",
                            )

                    app.push_screen(
                        ConfirmScreen(
                            "Restart required",
                            "MCP server configuration changed and requires a restart to take effect.\nRestart now?",
                        ),
                        on_restart_confirm,
                    )
                else:
                    app.notify("Settings saved.", severity="information")

            app.push_screen(SettingsScreen(cfg), on_settings_result)

        case "/index-rag":
            from stupidex.rag.indexer import index_project
            from stupidex.rag.indexer import is_indexing as rag_is_indexing

            if rag_is_indexing():
                app.notify("RAG indexing already in progress.", severity="warning")
                return

            app.notify("Indexing project for RAG...", severity="information")

            async def _run_rag_index():
                try:
                    result = await index_project()
                    msg = (
                        f"Indexed {result.files_indexed} files "
                        f"({result.chunks_created} chunks) in {result.duration_seconds:.1f}s. "
                        f"Skipped: {result.files_skipped}, Deleted: {result.files_deleted}"
                    )
                    if result.errors:
                        msg += f" Errors: {len(result.errors)}"
                    app.notify(msg, severity="information" if not result.errors else "warning")
                except Exception as e:
                    app.notify(f"Indexing failed: {e}", severity="error")
                finally:
                    await app.refresh_index_status()

            app.run_worker(_run_rag_index)
            await app.refresh_index_status()
        case "/index-ast":
            from stupidex.ast.indexer import index_project as ast_index_project
            from stupidex.ast.indexer import is_indexing as ast_is_indexing

            if ast_is_indexing():
                app.notify("AST indexing already in progress.", severity="warning")
                return

            app.notify("Re-scanning project for AST symbols...", severity="information")

            async def _run_reindex_ast():
                try:
                    result = await ast_index_project(force=True)
                    msg = (
                        f"AST indexed {result.files_indexed} files "
                        f"({result.symbols_extracted} symbols) in "
                        f"{result.duration_seconds:.1f}s. "
                        f"Skipped: {result.files_skipped}, Deleted: {result.files_deleted}"
                    )
                    if result.errors:
                        msg += f" Errors: {len(result.errors)}"
                    app.notify(
                        msg,
                        severity="information" if not result.errors else "warning",
                    )
                except Exception as e:
                    app.notify(f"AST re-index failed: {e}", severity="error")
                finally:
                    await app.refresh_index_status()

            app.run_worker(_run_reindex_ast)
            await app.refresh_index_status()
        case "/rag status":
            from stupidex.rag.indexer import get_status

            status = get_status()
            if status.last_indexed is None and status.total_chunks == 0:
                app.notify("No RAG index exists. Run /index-rag to create one.", severity="information")
            else:
                app.notify(
                    f"RAG: {status.total_files} files, {status.total_chunks} chunks, "
                    f"indexed: {status.last_indexed or 'never'}",
                    severity="information",
                )
        case "/rag clear":
            from stupidex.rag.indexer import clear_index

            clear_index()
            app.notify("RAG index cleared.", severity="information")
            await app.refresh_index_status()


class SessionCommands(Provider):
    COMMANDS = COMMANDS

    async def discover(self) -> Hits:
        for cmd, desc in COMMANDS.items():
            yield DiscoveryHit(cmd, partial(self.run_command, cmd), help=desc)

    async def search(self, query: str) -> Hits:
        matcher = Matcher(query)
        for cmd, desc in COMMANDS.items():
            score = matcher.match(cmd)
            if score > 0:
                yield Hit(score, matcher.highlight(cmd), partial(self.run_command, cmd), help=desc)

    async def run_command(self, cmd: str) -> None:
        await execute_command(self.app, cmd)
