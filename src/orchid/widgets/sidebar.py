import os
import time
from datetime import UTC, datetime
from typing import Any, Literal, TypedDict, cast

from textual.containers import Vertical
from textual.events import Blur, Focus
from textual.message import Message
from textual.widgets import Collapsible, Input, Static

from orchid.agents.manager import SUBAGENT_INDICATORS, SubagentRecord, SubagentState
from orchid.domain.todo import TERMINAL_STATUSES, TodoStatus, TodoTask

_TOKEN_THROTTLE_INTERVAL = 0.5


class BgCommandRecord(TypedDict):
    id: int
    command: str
    description: str
    owner: str
    status: Literal["running", "exited"]
    last_output_age: float
    interactive: bool
    has_tail: bool


def _relative_time(iso_timestamp: str) -> str:
    """Convert an ISO timestamp to a relative 'X ago' string."""
    try:
        dt = datetime.fromisoformat(iso_timestamp)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        now = datetime.now(UTC)
        delta = (now - dt).total_seconds()
        if delta < 0:
            return "just now"
        if delta < 60:
            return f"{int(delta)}s ago"
        if delta < 3600:
            return f"{int(delta / 60)}m ago"
        if delta < 86400:
            return f"{int(delta / 3600)}h ago"
        return f"{int(delta / 86400)}d ago"
    except (ValueError, TypeError):
        return "unknown"


class SidebarSubagentSelected(Message):
    """Emitted when a subagent entry is clicked."""

    def __init__(self, subagent_id: str) -> None:
        self.subagent_id = subagent_id
        super().__init__()


class SidebarMainSelected(Message):
    """Emitted when the Main entry is clicked."""
    pass


class SidebarBgCommandSelected(Message):
    """Emitted when a background command entry is clicked."""

    def __init__(self, command_id: int) -> None:
        self.command_id = command_id
        super().__init__()


class BgCommandInput(Input):
    """Input widget for background command stdin, with ownership management."""

    can_focus = True

    def __init__(self, command_id: int, **kwargs: Any) -> None:
        self._bg_command_id = command_id
        super().__init__(**kwargs)

    @property
    def command_id(self) -> int:
        return self._bg_command_id

    def _on_focus(self, event: Focus) -> None:
        super()._on_focus(event)
        from orchid.tools.background_store import get_background_store
        get_background_store().take_ownership(self.command_id)

    def _on_blur(self, event: Blur) -> None:
        super()._on_blur(event)
        from orchid.tools.background_store import get_background_store
        get_background_store().release_ownership(self.command_id)


class NavEntry(Static):
    """Clickable and keyboard-navigable navigation entry."""

    can_focus = True
    BINDINGS = [("enter", "activate"), ("space", "activate")]

    class Pressed(Message):
        def __init__(self, nav_entry: "NavEntry") -> None:
            self.nav_entry = nav_entry
            super().__init__()

        @property
        def control(self) -> "NavEntry":
            return self.nav_entry

    def __init__(self, label: str, view_id: str, **kwargs: Any) -> None:
        self.view_id = view_id
        super().__init__(label, **kwargs)

    def on_click(self) -> None:
        self.post_message(self.Pressed(self))

    def action_activate(self) -> None:
        self.post_message(self.Pressed(self))


class Sidebar(Vertical):
    """Right sidebar showing token counts, subagents, and working directory."""

    BINDINGS = [("up", "navigate_up"), ("down", "navigate_down")]

    DEFAULT_CSS = """
    Sidebar {
        width: 30;
        min-width: 30;
        dock: right;
        background: $surface;
        padding: 1 0 0 0;
    }

    Sidebar #sidebar-tokens-label,
    Sidebar #sidebar-subagents-label,
    Sidebar #sidebar-todos-label,
    Sidebar #sidebar-mcp-label,
    Sidebar #sidebar-rag-label,
    Sidebar #sidebar-ast-label,
    Sidebar #sidebar-bg-cmds-label {
        color: $text-muted;
        text-style: bold;
        padding: 0 1;
    }

    Sidebar #rag-status,
    Sidebar #ast-status {
        width: 100%;
        height: auto;
        padding: 0 1;
        color: $text-muted;
    }

    Sidebar #token-info {
        color: $text;
        padding: 0 1 1 1;
    }

    Sidebar #sidebar-nav {
        height: auto;
        padding: 0 0;
    }

    Sidebar NavEntry {
        width: 100%;
        min-height: 1;
        height: auto;
        padding: 0 1;
        color: $text-muted;
    }

    Sidebar NavEntry:hover {
        background: $surface-darken-1;
    }

    Sidebar NavEntry:focus {
        background: $accent-darken-1;
        color: $text;
    }

    Sidebar NavEntry.-active {
        color: $primary-lighten-1;
        text-style: bold;
    }

    Sidebar #subagent-entries,
    Sidebar #mcp-entries,
    Sidebar #todo-entries,
    Sidebar #bg-cmds-entries {
        height: auto;
        padding: 0 0;
    }

    Sidebar .todo-entry {
        width: 100%;
        min-height: 1;
        height: auto;
        padding: 0 1;
        color: $text-muted;
    }

    Sidebar .subagent-entry {
        width: 100%;
        min-height: 1;
        height: auto;
        padding: 0 1;
        color: $text-muted;
    }

    Sidebar .subagent-entry:hover {
        background: $surface-darken-1;
    }

    Sidebar .subagent-entry.-active {
        color: $primary-lighten-1;
        text-style: bold;
    }

    Sidebar .finished-collapse {
        margin: 0;
        padding: 0 0;
        border: none;
    }

    Sidebar .finished-collapse > CollapsibleTitle {
        color: $text-muted;
        padding: 0 1;
        text-style: dim;
    }

    Sidebar .finished-collapse > CollapsibleTitle:hover {
        background: $surface-darken-1;
    }

    Sidebar .finished-collapse > Contents {
        padding: 0;
    }

    Sidebar .bg-cmd-entry {
        width: 100%;
        min-height: 1;
        height: auto;
        padding: 0 1;
        color: $text-muted;
    }

    Sidebar .bg-cmd-entry:hover {
        background: $surface-darken-1;
    }

    Sidebar .bg-cmd-entry:focus {
        background: $accent-darken-1;
        color: $text;
    }

    Sidebar .bg-cmd-expand {
        margin: 0;
        padding: 0 0;
        border: none;
    }

    Sidebar .bg-cmd-expand > CollapsibleTitle {
        color: $text-muted;
        padding: 0 1;
        text-style: dim;
    }

    Sidebar .bg-cmd-expand > Contents {
        padding: 0 1;
        height: auto;
    }

    Sidebar .bg-cmd-expand > Contents Static {
        color: $text-muted;
        width: 100%;
        height: auto;
    }

    Sidebar .bg-cmd-expand > Contents Input {
        width: 100%;
        height: 3;
        border: solid $primary;
        padding: 0 1;
        margin-top: 0;
    }

    Sidebar #working-directory {
        width: 100%;
        padding: 1 1 0 1;
        color: $text-muted;
        text-style: dim;
    }

    Sidebar #sidebar-spacer {
        height: 1fr;
    }
    """

    _prompt_tokens: int = 0
    _completion_tokens: int = 0
    _total_tokens: int = 0
    _max_context: int | None = None
    _active_view: str = "main"
    _last_token_update: float = 0
    _token_flush_scheduled: bool = False

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._usage_by_view: dict[str, Any] = {}
        self._subagent_records: list[SubagentRecord] = []
        self._bg_cmd_records: list[BgCommandRecord] = []
        self._expanded_bg_cmd_id: int | None = None
        self._bg_cmd_label_cache: dict[int, str] = {}

    def compose(self):
        yield Static("Tokens", id="sidebar-tokens-label")
        yield Static("Context: 0", id="token-info")
        with Vertical(id="sidebar-nav"):
            yield NavEntry("▸ Main", "main", id="nav-main")
        yield Static("Subagents", id="sidebar-subagents-label")
        yield Vertical(id="subagent-entries")
        yield Static("Background Commands", id="sidebar-bg-cmds-label")
        yield Vertical(id="bg-cmds-entries")
        yield Static("MCP Servers", id="sidebar-mcp-label")
        yield Vertical(id="mcp-entries")
        yield Static("Todos", id="sidebar-todos-label")
        yield Vertical(id="todo-entries")
        yield Static(id="sidebar-spacer")
        yield Static("AST", id="sidebar-ast-label")
        yield Static("", id="ast-status")
        yield Static("RAG", id="sidebar-rag-label")
        yield Static("", id="rag-status")
        yield Static(self._get_working_dir(), id="working-directory")

    def _get_working_dir(self) -> str:
        cwd = os.getcwd()
        if len(cwd) > 26:
            parts = cwd.split("/")
            if len(parts) > 3:
                return f"  ~/{'/'.join(parts[-2:])}"
        return f"  {cwd}"

    def on_nav_entry_pressed(self, event: NavEntry.Pressed) -> None:
        if "bg-cmd-entry" in event.control.classes:
            try:
                cmd_id = int(event.control.view_id)
                self.post_message(SidebarBgCommandSelected(cmd_id))
            except (ValueError, TypeError):
                pass
            return
        if event.control.view_id == "main":
            self.post_message(SidebarMainSelected())
        else:
            self.post_message(
                SidebarSubagentSelected(event.control.view_id))

    def _get_focusable_entries(self) -> list[NavEntry | Collapsible]:
        entries: list[NavEntry | Collapsible] = []
        try:
            nav = self.query_one("#sidebar-nav")
            entries.extend(nav.query(NavEntry))
        except Exception:
            pass
        try:
            container = self.query_one("#subagent-entries", Vertical)
            for child in container.children:
                if isinstance(child, NavEntry):
                    entries.append(child)
                elif isinstance(child, Collapsible):
                    entries.append(child)
                    if not child.collapsed:
                        entries.extend(child.query(NavEntry))
        except Exception:
            pass
        return entries

    def action_navigate_up(self) -> None:
        entries = self._get_focusable_entries()
        if not entries:
            return
        focused = self.app.focused  # type: ignore[union-attr]
        if focused in entries:
            assert isinstance(focused, (NavEntry, Collapsible))
            idx = entries.index(focused)
            entries[(idx - 1) % len(entries)].focus()
        else:
            entries[-1].focus()

    def action_navigate_down(self) -> None:
        entries = self._get_focusable_entries()
        if not entries:
            return
        focused = self.app.focused  # type: ignore[union-attr]
        if focused in entries:
            assert isinstance(focused, (NavEntry, Collapsible))
            idx = entries.index(focused)
            entries[(idx + 1) % len(entries)].focus()
        else:
            entries[0].focus()

    def set_active(self, view_id: str) -> None:
        self._active_view = view_id
        self._update_active_styles()
        self._show_usage_for_view(view_id)

    def _show_usage_for_view(self, view_id: str) -> None:
        usage = self._usage_by_view.get(view_id)
        if usage:
            # Stored as 4-tuple: (prompt, completion, total, max_context).
            # Older entries without max_context fall back to None.
            if len(usage) == 4:
                self._prompt_tokens, self._completion_tokens, self._total_tokens, self._max_context = usage
            else:
                self._prompt_tokens, self._completion_tokens, self._total_tokens = usage
                self._max_context = None
        else:
            self._prompt_tokens = 0
            self._completion_tokens = 0
            self._total_tokens = 0
            self._max_context = None
        self._flush_token_update()

    def _update_active_styles(self) -> None:
        try:
            nav = self.query_one("#sidebar-nav")
            for entry in nav.query(NavEntry):
                if entry.view_id == self._active_view:
                    entry.add_class("-active")
                else:
                    entry.remove_class("-active")
        except Exception:
            pass

        try:
            entries = self.query_one("#subagent-entries", Vertical)
            for entry in entries.query(".subagent-entry"):
                assert isinstance(entry, NavEntry)
                if entry.view_id == self._active_view:
                    entry.add_class("-active")
                else:
                    entry.remove_class("-active")
        except Exception:
            pass

    def update_tokens(
        self,
        prompt_tokens: int,
        completion_tokens: int,
        total_tokens: int,
        view_id: str = "main",
        max_context: int | None = None,
    ) -> None:
        """Record token usage for a view (main session, or a subagent tab).

        `max_context` (the active model's `max_input_tokens`) is optional; when
        provided, the sidebar renders `Context: <prompt> (<pct>%)` where the
        percentage is `prompt_tokens / max_context * 100`. When omitted, the
        sidebar renders `Context: <prompt>` without the percentage.
        """
        self._usage_by_view[view_id] = (prompt_tokens, completion_tokens, total_tokens, max_context)
        if view_id != self._active_view:
            return
        self._prompt_tokens = prompt_tokens
        self._completion_tokens = completion_tokens
        self._total_tokens = total_tokens
        self._max_context = max_context
        now = time.monotonic()
        if now - self._last_token_update >= _TOKEN_THROTTLE_INTERVAL:
            self._last_token_update = now
            self._flush_token_update()
        elif not self._token_flush_scheduled:
            self._token_flush_scheduled = True
            remaining = _TOKEN_THROTTLE_INTERVAL - (now - self._last_token_update)
            self.set_timer(remaining, self._flush_token_update)

    def _flush_token_update(self) -> None:
        self._token_flush_scheduled = False
        self._last_token_update = time.monotonic()
        try:
            line = f"Context: {self._prompt_tokens}"
            if self._max_context and self._max_context > 0:
                pct = self._prompt_tokens / self._max_context * 100
                # Clamp so 0% and 100% render cleanly; never show negative.
                pct = max(0.0, min(100.0, pct))
                line += f" ({pct:.1f}%)"
            self.query_one("#token-info", Static).update(line)
        except Exception:
            pass

    async def update_subagents(self, records: list[SubagentRecord]) -> None:
        self._subagent_records = list(records)
        await self._refresh_subagent_display()

    async def _refresh_subagent_display(self) -> None:
        try:
            container = self.query_one("#subagent-entries", Vertical)
        except Exception:
            return

        records = self._subagent_records
        if not records:
            if container.children:
                await container.remove_children()
            return

        running = [r for r in records if r.state == SubagentState.RUNNING]
        pending = [r for r in records if r.state == SubagentState.PENDING]
        done = [r for r in records if r.state in (
            SubagentState.COMPLETED, SubagentState.FAILED, SubagentState.INTERRUPTED)]

        active_records = list(reversed(running + pending))
        active_ids = [r.id for r in active_records]
        done_ids = [r.id for r in done]

        # Detect current structure
        current_active_ids: list[str] = []
        current_done_ids: list[str] = []
        existing_collapse: Collapsible | None = None
        records_by_id = {r.id: r for r in records}

        for child in container.children:
            if isinstance(child, NavEntry) and child.view_id:
                current_active_ids.append(child.view_id)
            elif isinstance(child, Collapsible):
                existing_collapse = child
                for entry in child.query(NavEntry):
                    if entry.view_id:
                        current_done_ids.append(entry.view_id)

        structure_changed = (active_ids != current_active_ids or
                             done_ids != current_done_ids)

        if not structure_changed:
            # Only labels changed (e.g. elapsed time) — update in-place
            for child in container.children:
                if isinstance(child, NavEntry) and child.view_id:
                    record = records_by_id.get(child.view_id)
                    if record:
                        child.update(self._format_entry(record))
            if existing_collapse:
                for entry in existing_collapse.query(NavEntry):
                    record = records_by_id.get(entry.view_id)
                    if record:
                        entry.update(self._format_entry(record))
            return

        # Structure changed — batch rebuild to avoid flicker
        was_finished_collapsed = True
        if existing_collapse:
            was_finished_collapsed = existing_collapse.collapsed

        # Build active entries synchronously before mounting
        active_entries: list[NavEntry] = []
        for record in active_records:
            label_text = self._format_entry(record)
            entry = NavEntry(label_text, record.id, classes="subagent-entry")
            if record.id == self._active_view:
                entry.add_class("-active")
            active_entries.append(entry)

        # Build done entries synchronously
        done_entries: list[NavEntry] = []
        for record in reversed(done):
            label_text = self._format_entry(record)
            entry = NavEntry(label_text, record.id,
                             classes="subagent-entry")
            if record.id == self._active_view:
                entry.add_class("-active")
            done_entries.append(entry)

        # Single remove, then mount all at once
        await container.remove_children()

        if active_entries:
            await container.mount(*active_entries)

        if done_entries:
            finished_label = f"Finished ({len(done)})"
            # Done entries are passed as Collapsible children so they are part
            # of its compose() — avoids a post-mount query_one("Contents")
            # that races the DOM during teardown (NoMatches on a partially
            # composed Collapsible).
            collapse = Collapsible(
                *done_entries,
                classes="finished-collapse",
                title=finished_label,
                collapsed=was_finished_collapsed,
            )
            # Collapsible uses reactive(init=False) for `collapsed`, so the
            # `-collapsed` CSS class (which hides Contents) is only applied in
            # _on_mount — one render frame AFTER compose/mount. Pre-setting the
            # class avoids a flash of the expanded dropdown on every rebuild.
            collapse.set_class(was_finished_collapsed, "-collapsed", update=False)
            collapse.can_focus = True
            await container.mount(collapse)

    def _format_entry(self, record: SubagentRecord) -> str:
        indicator = self._get_indicator(record.state)
        label = record.label or record.name
        if len(label) > 18:
            label = label[:16] + ".."
        elapsed = self._get_elapsed(record)

        prefix = "▸" if record.id == self._active_view else " "

        color = {
            SubagentState.RUNNING: "green",
            SubagentState.PENDING: "yellow",
            SubagentState.COMPLETED: "dim",
            SubagentState.FAILED: "red",
            SubagentState.INTERRUPTED: "dim red",
        }.get(record.state, "dim")

        line = f"[{color}]{prefix}{indicator}[/{color}] {label}"
        if elapsed:
            line += f" {elapsed}"
        return line

    def _get_indicator(self, state: SubagentState) -> str:
        return SUBAGENT_INDICATORS.get(state, "?")

    def _get_elapsed(self, record: SubagentRecord) -> str | None:
        elapsed = record.elapsed_seconds
        if elapsed is None:
            return None
        if elapsed < 60:
            return f"{elapsed:.0f}s"
        elif elapsed < 3600:
            return f"{elapsed / 60:.0f}m"
        else:
            return f"{elapsed / 3600:.1f}h"

    async def update_mcp_servers(self, statuses: dict[str, dict[str, Any]]) -> None:
        try:
            container = self.query_one("#mcp-entries", Vertical)
        except Exception:
            return

        if not statuses:
            if container.children:
                await container.remove_children()
            return

        # Diff-based update: update existing entries in-place, only rebuild
        # if the number of servers changed.
        new_texts = [self._format_mcp_server(name, info) for name, info in statuses.items()]
        existing = list(container.children)

        if len(existing) == len(new_texts):
            # Same count — update labels in-place (no flicker)
            for widget, text in zip(existing, new_texts, strict=True):
                if isinstance(widget, Static):
                    widget.update(text)
            return

        # Server count changed — must rebuild
        entries: list[Static] = [Static(text) for text in new_texts]
        await container.remove_children()
        if entries:
            await container.mount(*entries)

    @staticmethod
    def _format_mcp_server(name: str, info: dict[str, Any]) -> str:
        status: str = info.get("status", "unknown")
        tool_count: int = info.get("tool_count", 0)
        error: str | None = info.get("error")

        indicator = {
            "connected": "●",
            "starting": "◐",
            "failed": "✗",
        }.get(status, "?")

        color = {
            "connected": "green",
            "starting": "yellow",
            "failed": "red",
        }.get(status, "dim")

        label = name
        if len(label) > 14:
            label = label[:12] + ".."

        text = f"[{color}] {indicator}[/{color}] {label}"
        if status == "connected" and tool_count:
            text += f" ({tool_count})"
        elif status == "failed" and error:
            err = error if len(error) <= 12 else error[:10] + ".."
            text += f" [{err}]"
        return text

    async def update_todos(self, tasks: list[TodoTask]) -> None:
        try:
            container = self.query_one("#todo-entries", Vertical)
        except Exception:
            return

        if not tasks:
            if container.children:
                await container.remove_children()
            return

        active = [t for t in tasks if t.status not in TERMINAL_STATUSES]
        done = [t for t in tasks if t.status in TERMINAL_STATUSES]

        # Detect current structure for diff comparison
        existing_collapse: Collapsible | None = None
        current_active_count = 0
        current_done_count = 0
        for child in container.children:
            if isinstance(child, Collapsible):
                existing_collapse = child
                current_done_count = len(list(child.query(".todo-entry")))
            elif isinstance(child, Static) and "todo-entry" in child.classes:
                current_active_count += 1

        was_finished_collapsed = existing_collapse.collapsed if existing_collapse else True

        # If structure matches (same active/done counts), update in-place
        if current_active_count == len(active) and current_done_count == len(done):
            # Update active entries in-place
            active_widgets = [
                child for child in container.children
                if isinstance(child, Static) and "todo-entry" in child.classes
            ]
            for widget, task in zip(active_widgets, active, strict=True):
                widget.update(self._format_todo(task))
            # Update done entries in-place
            if existing_collapse:
                done_widgets = list(existing_collapse.query(".todo-entry"))
                for widget, task in zip(done_widgets, reversed(done), strict=True):
                    if isinstance(widget, Static):
                        widget.update(self._format_todo(task))
            return

        # Structure changed — rebuild
        active_entries: list[Static] = []
        for task in active:
            entry = Static(self._format_todo(task), classes="todo-entry")
            active_entries.append(entry)

        done_entries: list[Static] = []
        for task in reversed(done):
            entry = Static(self._format_todo(task), classes="todo-entry")
            done_entries.append(entry)

        await container.remove_children()

        if active_entries:
            await container.mount(*active_entries)

        if done_entries:
            collapse = Collapsible(
                *done_entries,
                classes="finished-collapse",
                title=f"Done ({len(done)})",
                collapsed=was_finished_collapsed,
            )
            collapse.set_class(was_finished_collapsed, "-collapsed", update=False)
            await container.mount(collapse)

    @staticmethod
    def _format_todo(task: TodoTask) -> str:
        indicator = {
            TodoStatus.OPEN: "○",
            TodoStatus.IN_PROGRESS: "◐",
            TodoStatus.BLOCKED: "⊘",
            TodoStatus.NEEDS_REVIEW: "◑",
            TodoStatus.UNDER_REVIEW: "◑",
            TodoStatus.DONE: "●",
            TodoStatus.ABANDONED: "✗",
        }.get(task.status, "?")

        color = {
            TodoStatus.OPEN: "blue",
            TodoStatus.IN_PROGRESS: "yellow",
            TodoStatus.BLOCKED: "red",
            TodoStatus.NEEDS_REVIEW: "cyan",
            TodoStatus.UNDER_REVIEW: "cyan",
            TodoStatus.DONE: "dim",
            TodoStatus.ABANDONED: "dim red",
        }.get(task.status, "dim")

        title = task.title
        if len(title) > 22:
            title = title[:20] + ".."

        text = f"[{color}] {indicator}[/{color}] {title}"
        return text

    async def update_index_status(
        self,
        rag_last: str | None,
        rag_duration: float | None,
        ast_last: str | None,
        ast_duration: float | None,
        rag_indexing: bool = False,
        ast_indexing: bool = False,
    ) -> None:
        try:
            rag_widget = self.query_one("#rag-status", Static)
            ast_widget = self.query_one("#ast-status", Static)
        except Exception:
            return

        rag_widget.update(self._format_index_line(rag_last, rag_duration, rag_indexing))
        ast_widget.update(self._format_index_line(ast_last, ast_duration, ast_indexing))

    @staticmethod
    def _format_index_line(last_indexed: str | None, duration: float | None, indexing: bool = False) -> str:
        if indexing:
            return "[yellow]indexing...[/yellow]"
        if not last_indexed:
            return "[dim]never indexed[/dim]"

        ago = _relative_time(last_indexed)
        parts = [f"[dim]{ago}[/dim]"]
        if duration is not None:
            parts.append(f"[dim]({duration:.1f}s)[/dim]")
        return " ".join(parts)

    # -- background commands ---------------------------------------------------

    @staticmethod
    def _format_age(seconds: float) -> str:
        """Format a monotonic-time age into a human-readable string.

        Rounds to reduce update frequency: 5s buckets under 1m, 1m buckets
        under 1h, so the formatted string changes less often and avoids
        triggering unnecessary widget repaints.
        """
        if seconds < 5:
            return "now"
        if seconds < 60:
            # Round to nearest 5s to reduce churn
            rounded = int(seconds // 5) * 5
            return f"{rounded}s ago"
        if seconds < 3600:
            return f"{int(seconds / 60)}m ago"
        return f"{int(seconds / 3600)}h ago"

    async def update_background_commands(self, records: list[BgCommandRecord]) -> None:
        """Update the background-commands section from a list of record dicts.

        Each record should contain:
            id, command, owner, status, last_output_age, interactive, has_tail
        """
        self._bg_cmd_records = list(records)
        await self._refresh_bg_cmd_display()

    async def _refresh_bg_cmd_display(self) -> None:
        try:
            container = self.query_one("#bg-cmds-entries", Vertical)
            label = self.query_one("#sidebar-bg-cmds-label", Static)
        except Exception:
            return

        records = self._bg_cmd_records

        # Hide section when no records
        if not records:
            label.display = False
            if self._expanded_bg_cmd_id is not None:
                self._expanded_bg_cmd_id = None
            if container.children:
                await container.remove_children()
            return
        label.display = True

        # Determine if the focused widget is a bg-cmd input before rebuild
        focused_cmd_id: int | None = None
        focused_input_value: str | None = None
        try:
            focused = cast(Any, self).app.focused
            if isinstance(focused, BgCommandInput):
                focused_cmd_id = focused.command_id
                focused_input_value = focused.value
        except Exception:
            pass

        running = [r for r in records if r["status"] == "running"]
        finished = [r for r in records if r["status"] == "exited"]

        active_ids = [r["id"] for r in running]
        finished_ids = [r["id"] for r in finished]

        # Detect current structure
        current_active_ids: list[int] = []
        current_finished_ids: list[int] = []
        existing_collapse: Collapsible | None = None
        records_by_id = {r["id"]: r for r in records}

        for child in container.children:
            if isinstance(child, NavEntry) and "bg-cmd-entry" in child.classes:
                try:
                    current_active_ids.append(int(child.view_id))
                except (ValueError, TypeError):
                    pass
            elif isinstance(child, Collapsible):
                existing_collapse = child
                for entry in child.query(NavEntry):
                    try:
                        current_finished_ids.append(int(entry.view_id))
                    except (ValueError, TypeError):
                        pass

        structure_changed = (
            active_ids != current_active_ids
            or finished_ids != current_finished_ids
        )

        if not structure_changed:
            # Label-only updates (age, owner, status) — only update if text changed
            for child in container.children:
                if isinstance(child, NavEntry) and "bg-cmd-entry" in child.classes:
                    try:
                        cmd_id = int(child.view_id)
                    except (ValueError, TypeError):
                        continue
                    r = records_by_id.get(cmd_id)
                    if r:
                        new_text = self._format_bg_entry(r)
                        if self._bg_cmd_label_cache.get(cmd_id) != new_text:
                            self._bg_cmd_label_cache[cmd_id] = new_text
                            child.update(new_text)
                elif isinstance(child, Collapsible) and "finished-collapse" in child.classes:
                    for entry in child.query(NavEntry):
                        try:
                            cmd_id = int(entry.view_id)
                        except (ValueError, TypeError):
                            continue
                        r = records_by_id.get(cmd_id)
                        if r:
                            new_text = self._format_bg_entry(r)
                            if self._bg_cmd_label_cache.get(cmd_id) != new_text:
                                self._bg_cmd_label_cache[cmd_id] = new_text
                                entry.update(new_text)
            return

        # Structure changed — batch rebuild
        was_finished_collapsed = True
        if existing_collapse:
            was_finished_collapsed = existing_collapse.collapsed

        # Build active entries
        active_entries: list[NavEntry] = []
        for record in running:
            label_text = self._format_bg_entry(record)
            entry = NavEntry(
                label_text, str(record["id"]),
                classes="bg-cmd-entry",
            )
            active_entries.append(entry)

        # Build finished entries
        done_entries: list[NavEntry] = []
        for record in reversed(finished):
            label_text = self._format_bg_entry(record)
            entry = NavEntry(
                label_text, str(record["id"]),
                classes="bg-cmd-entry",
            )
            done_entries.append(entry)

        # Clear expanded state (will be restored below if needed)
        saved_expanded_id = self._expanded_bg_cmd_id
        self._expanded_bg_cmd_id = None

        # Single remove, then mount all at once
        await container.remove_children()

        if active_entries:
            await container.mount(*active_entries)

        if done_entries:
            finished_label = f"Finished ({len(finished)})"
            collapse = Collapsible(
                *done_entries,
                classes="finished-collapse",
                title=finished_label,
                collapsed=was_finished_collapsed,
            )
            collapse.set_class(was_finished_collapsed, "-collapsed", update=False)
            collapse.can_focus = True
            await container.mount(collapse)

        # Restore expanded state from before the rebuild
        restore_id = focused_cmd_id or saved_expanded_id
        if restore_id is not None and any(r["id"] == restore_id for r in records):
            # Skip expansion if command is finished (inside Collapsible, not a direct child)
            if restore_id in finished_ids:
                self._expanded_bg_cmd_id = None
            else:
                self._expanded_bg_cmd_id = None  # clear so _expand_bg_cmd doesn't skip
                await self._expand_bg_cmd(restore_id)
            # Re-focus the input if it was focused before
            if focused_cmd_id is not None:
                try:
                    input_widget = self.query_one(
                        f"#bg-cmd-input-{focused_cmd_id}", BgCommandInput
                    )
                    if focused_input_value is not None:
                        input_widget.value = focused_input_value
                    input_widget.focus()
                except Exception:
                    pass

    async def on_input_submitted(self, event: Any) -> None:
        """Handle Enter in a bg-cmd input: send text to the command's stdin."""
        if not isinstance(event.input, BgCommandInput):
            return
        cmd_id = event.input.command_id
        from orchid.tools.background_store import get_background_store
        store = get_background_store()
        entry = store.get(cmd_id)
        if entry is None or not entry.interactive or entry.exit_code is not None:
            return
        text = event.input.value + "\n"
        ok = await store.send(cmd_id, text)
        if ok:
            import time
            entry.last_user_input_at = time.monotonic()
            event.input.clear()

    def _format_bg_entry(self, record: BgCommandRecord) -> str:
        """Format a single background-command sidebar entry."""
        status = record["status"]
        owner = record["owner"]
        last_output_age = record["last_output_age"]

        if status == "running":
            indicator = "●"
            indicator_color = "green"
        else:
            indicator = "○"
            indicator_color = "dim"

        owner_badge = "[dim]USER[/dim]" if owner == "USER" else ""
        age_str = self._format_age(last_output_age)

        label = record["description"] or record["command"]
        if len(label) > 24:
            label = label[:22] + ".."

        line = f"[{indicator_color}]{indicator}[/{indicator_color}] {label}"
        if owner_badge:
            line += f" {owner_badge}"
        if age_str:
            line += f" [dim]{age_str}[/dim]"
        return line

    async def expand_bg_cmd(self, cmd_id: int) -> None:
        await self._expand_bg_cmd(cmd_id)

    async def _expand_bg_cmd(self, cmd_id: int) -> None:
        """Mount a Collapsible with tail output and input for a bg command."""
        try:
            container = self.query_one("#bg-cmds-entries", Vertical)
        except Exception:
            return

        from orchid.tools.background_store import get_background_store
        store = get_background_store()
        entry = store.get(cmd_id)
        if entry is None:
            return

        # Collapse the previously expanded entry
        if self._expanded_bg_cmd_id is not None:
            await self._collapse_bg_cmd(self._expanded_bg_cmd_id)

        self._expanded_bg_cmd_id = cmd_id

        # Build the expand content
        snap = store.snapshot(cmd_id)
        tail_text = snap[0] if snap else "(no output yet)"
        if not tail_text.strip():
            tail_text = "(no output yet)"
        # Cap to last 16 lines to keep the sidebar compact
        tail_lines = tail_text.split("\n")
        if len(tail_lines) > 16:
            tail_lines = tail_lines[-16:]
            tail_text = "...\n" + "\n".join(tail_lines)

        tail_widget = Static(tail_text, classes="bg-cmd-expand-tail")
        input_widget = BgCommandInput(
            cmd_id,
            placeholder="Type to send input...",
            id=f"bg-cmd-input-{cmd_id}",
        )

        collapsible = Collapsible(
            tail_widget,
            input_widget,
            classes="bg-cmd-expand",
            title=f"▸ Command #{cmd_id}",
            collapsed=False,
        )
        collapsible.set_class(False, "-collapsed", update=False)

        # Find the NavEntry to insert after, and mount directly (no teardown)
        target_entry = None
        for child in container.children:
            if isinstance(child, NavEntry) and "bg-cmd-entry" in child.classes:
                try:
                    if int(child.view_id) == cmd_id:
                        target_entry = child
                        break
                except (ValueError, TypeError):
                    pass

        if target_entry is not None:
            # Mount after the target entry using sibling index
            children_list = list(container.children)
            idx = children_list.index(target_entry)
            if idx + 1 < len(children_list):
                await container.mount(collapsible, before=children_list[idx + 1])
            else:
                await container.mount(collapsible)
        else:
            await container.mount(collapsible)

    async def _collapse_bg_cmd(self, cmd_id: int) -> None:
        """Remove the collapsible for a previously expanded bg command."""
        try:
            container = self.query_one("#bg-cmds-entries", Vertical)
        except Exception:
            return

        for child in list(container.children):
            if isinstance(child, Collapsible) and "bg-cmd-expand" in child.classes:
                await child.remove()
                break

        if self._expanded_bg_cmd_id == cmd_id:
            self._expanded_bg_cmd_id = None
