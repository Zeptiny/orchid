import os
import time
from datetime import UTC, datetime

from textual.containers import Vertical
from textual.message import Message
from textual.widgets import Collapsible, Static

from stupidex.agents.manager import SUBAGENT_INDICATORS, SubagentRecord, SubagentState
from stupidex.domain.todo import TERMINAL_STATUSES, TodoStatus, TodoTask

_TOKEN_THROTTLE_INTERVAL = 0.5


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

    def __init__(self, label: str, view_id: str, **kwargs) -> None:
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
    Sidebar #sidebar-ast-label {
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
    Sidebar #todo-entries {
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

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._usage_by_view: dict = {}
        self._subagent_records: list = []

    def compose(self):
        yield Static("Tokens", id="sidebar-tokens-label")
        yield Static("Context: 0", id="token-info")
        with Vertical(id="sidebar-nav"):
            yield NavEntry("▸ Main", "main", id="nav-main")
        yield Static("Subagents", id="sidebar-subagents-label")
        yield Vertical(id="subagent-entries")
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
        if isinstance(event.control, NavEntry):
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
        focused = self.app.focused
        if focused in entries:
            idx = entries.index(focused)
            entries[(idx - 1) % len(entries)].focus()
        else:
            entries[-1].focus()

    def action_navigate_down(self) -> None:
        entries = self._get_focusable_entries()
        if not entries:
            return
        focused = self.app.focused
        if focused in entries:
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

    async def update_mcp_servers(self, statuses: dict[str, dict]) -> None:
        try:
            container = self.query_one("#mcp-entries", Vertical)
        except Exception:
            return

        if not statuses:
            if container.children:
                await container.remove_children()
            return

        entries: list[Static] = []
        for name, info in statuses.items():
            entries.append(Static(self._format_mcp_server(name, info)))

        await container.remove_children()
        if entries:
            await container.mount(*entries)

    @staticmethod
    def _format_mcp_server(name: str, info: dict) -> str:
        status = info.get("status", "unknown")
        tool_count = info.get("tool_count", 0)
        error = info.get("error")

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

        existing_collapse: Collapsible | None = None
        for child in container.children:
            if isinstance(child, Collapsible):
                existing_collapse = child

        was_finished_collapsed = existing_collapse.collapsed if existing_collapse else True

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
            # See _refresh_subagent_display: children are passed to the
            # Collapsible constructor rather than mounted via a post-mount
            # query_one("Contents") to avoid the teardown NoMatches race.
            collapse = Collapsible(
                *done_entries,
                classes="finished-collapse",
                title=f"Done ({len(done)})",
                collapsed=was_finished_collapsed,
            )
            # Pre-set the -collapsed class before mount to avoid a one-frame
            # flash of the expanded dropdown (see _refresh_subagent_display).
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
