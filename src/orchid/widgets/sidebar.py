import json
import os
import time
from datetime import UTC, datetime
from typing import Any

from textual.containers import Horizontal, Vertical
from textual.message import Message
from textual.widgets import Collapsible, Static

from orchid.agents.manager import SUBAGENT_INDICATORS, SubagentRecord, SubagentState
from orchid.domain.chain import Chain
from orchid.domain.message import Message as DomainMessage
from orchid.domain.message import MessageRole, MessageType
from orchid.domain.todo import TERMINAL_STATUSES, TodoStatus, TodoTask

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

    def __init__(self, label: str, view_id: str, **kwargs: Any) -> None:
        self.view_id = view_id
        super().__init__(label, **kwargs)

    def on_click(self) -> None:
        self.post_message(self.Pressed(self))

    def action_activate(self) -> None:
        self.post_message(self.Pressed(self))


def _load_sidebar_css() -> str:
    """Read sidebar styles from the external TCSS file."""
    try:
        base = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(base, "sidebar.tcss"), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


class Sidebar(Vertical):
    """Right sidebar showing token counts, subagents, and working directory."""

    DEFAULT_CSS = _load_sidebar_css()
    BINDINGS = [("up", "navigate_up"), ("down", "navigate_down")]

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
        self._context_messages: list[DomainMessage] = []
        self._system_prompt: str = ""
        self._cached_tools_keys: tuple[str, ...] = ()
        self._cached_tools_char_count: int = 0
        self._rag_last: str | None = None
        self._rag_duration: float | None = None
        self._rag_indexing: bool = False
        self._ast_last: str | None = None
        self._ast_duration: float | None = None
        self._ast_indexing: bool = False

    def compose(self):
        yield Static("", id="sidebar-title")
        with Vertical(id="sidebar-nav"):
            yield NavEntry("▸ Main", "main", id="nav-main")
        yield Static("Subagents", id="sidebar-subagents-label")
        yield Vertical(id="subagent-entries")
        yield Static("MCP Servers", id="sidebar-mcp-label")
        yield Vertical(id="mcp-entries")
        yield Static("Todos", id="sidebar-todos-label")
        yield Vertical(id="todo-entries")
        yield Static("", id="sidebar-spacer")
        with Horizontal(id="context-breakdown"):
            yield Static("", id="context-grid")
            yield Static("", id="context-legend")
        yield Static("AST", id="sidebar-ast-label")
        yield Static("", id="ast-status")
        yield Static("RAG", id="sidebar-rag-label")
        yield Static("", id="rag-status")
        yield Static(self._get_working_dir(), id="working-directory")

    def on_mount(self) -> None:
        self.set_interval(30, self._refresh_index_display)

    def _refresh_index_display(self) -> None:
        """Re-render AST/RAG status widgets using stored timestamps."""
        try:
            rag_widget = self.query_one("#rag-status", Static)
            ast_widget = self.query_one("#ast-status", Static)
        except Exception:
            return
        rag_widget.update(self._format_index_line(self._rag_last, self._rag_duration, self._rag_indexing))
        ast_widget.update(self._format_index_line(self._ast_last, self._ast_duration, self._ast_indexing))

    def _get_working_dir(self) -> str:
        cwd = os.getcwd()
        if len(cwd) > 26:
            parts = cwd.split("/")
            if len(parts) > 3:
                return f"  ~/{'/'.join(parts[-2:])}"
        return f"  {cwd}"

    def set_title(self, text: str) -> None:
        """Update the session title shown at the top of the sidebar."""
        try:
            self.query_one("#sidebar-title", Static).update(text)
        except Exception:
            pass

    def on_nav_entry_pressed(self, event: NavEntry.Pressed) -> None:
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

    def set_context_sources(
        self,
        messages: list[DomainMessage],
        system_prompt: str,
    ) -> None:
        """Store the raw message list and system prompt for breakdown estimation."""
        self._context_messages = list(messages)
        self._system_prompt = system_prompt

    def _get_tools_char_count(self) -> int:
        """Return the character count of the current tool registry JSON.

        Cached so that MCP server additions (which call ``reset_tool_registry``)
        are picked up automatically on the next flush.
        """
        from orchid.tools import get_tool_registry

        registry = get_tool_registry()
        current_keys = tuple(sorted(registry.keys()))
        if self._cached_tools_keys == current_keys:
            return self._cached_tools_char_count
        tools_list = []
        for name in current_keys:
            tool: Any = registry[name]["tool"]
            tools_list.append(tool.to_dict())
        self._cached_tools_char_count = len(json.dumps(tools_list))
        self._cached_tools_keys = current_keys
        return self._cached_tools_char_count

    # Colored blocks for context breakdown (Claude Code–style visual bars)
    _CTX_BLOCK_FREE   = "[on #3f7f57]  [/]"
    _CTX_BLOCK_SYSTEM = "[on #4c6f91]  [/]"
    _CTX_BLOCK_TOOLS  = "[on #9a5f87]  [/]"
    _CTX_BLOCK_TOOL   = "[on #a98232]  [/]"
    _CTX_BLOCK_MSGS   = "[on #6f5f9a]  [/]"

    _CTX_GRID_ROWS = 8
    _CTX_GRID_COLS = 8
    _CTX_GRID_TOTAL = _CTX_GRID_ROWS * _CTX_GRID_COLS  # 64 blocks

    def _compute_context_tokens(self) -> tuple[int, int, int, int, int] | None:
        """Compute token counts for each context category.

        Returns (free, system, tools, tool_use, messages) or None when
        there is insufficient data.
        """
        if not self._context_messages:
            return None

        system_chars = len(self._system_prompt)
        tools_chars = self._get_tools_char_count()
        tool_msgs_chars = sum(
            len(m.content)
            for m in self._context_messages
            if m.type in (MessageType.TOOL_RESULT, MessageType.TOOL_CALL)
        )
        msg_chars = sum(
            len(m.content)
            for m in self._context_messages
            if m.role in (MessageRole.USER, MessageRole.ASSISTANT)
            and not m.hidden
            and m.type == MessageType.TEXT
        )

        total_chars = system_chars + tools_chars + tool_msgs_chars + msg_chars
        if total_chars == 0:
            return None

        prompt_tokens = self._prompt_tokens
        system_tokens = int(system_chars / total_chars * prompt_tokens)
        tools_tokens = int(tools_chars / total_chars * prompt_tokens)
        tool_use_tokens = int(tool_msgs_chars / total_chars * prompt_tokens)
        msg_tokens = int(msg_chars / total_chars * prompt_tokens)

        # Normalize: adjust the largest category so the sum exactly matches
        allocated = system_tokens + tools_tokens + tool_use_tokens + msg_tokens
        diff = prompt_tokens - allocated
        if diff != 0:
            largest = max(
                [
                    ("system", system_tokens),
                    ("tools", tools_tokens),
                    ("tool_use", tool_use_tokens),
                    ("messages", msg_tokens),
                ],
                key=lambda x: x[1],
            )[0]
            if largest == "system":
                system_tokens += diff
            elif largest == "tools":
                tools_tokens += diff
            elif largest == "tool_use":
                tool_use_tokens += diff
            else:
                msg_tokens += diff

        free_tokens = max(0, self._max_context - prompt_tokens) if self._max_context and self._max_context > 0 else 0

        return (free_tokens, system_tokens, tools_tokens, tool_use_tokens, msg_tokens)

    def _build_context_grid(self, tokens: tuple[int, int, int, int, int]) -> str:
        """Build the 8×8 colored block grid string."""
        free_tokens, system_tokens, tools_tokens, tool_use_tokens, msg_tokens = tokens
        total_display_tokens = (
            free_tokens + system_tokens + tools_tokens + tool_use_tokens + msg_tokens
        )
        if total_display_tokens == 0:
            return ""

        tokens_per_block = total_display_tokens / self._CTX_GRID_TOTAL

        system_blocks = round(system_tokens / tokens_per_block)
        tools_blocks = round(tools_tokens / tokens_per_block)
        tool_use_blocks = round(tool_use_tokens / tokens_per_block)
        msg_blocks = round(msg_tokens / tokens_per_block)
        used_blocks = system_blocks + tools_blocks + tool_use_blocks + msg_blocks
        free_blocks = max(0, self._CTX_GRID_TOTAL - used_blocks)

        # Normalize block counts to ensure they sum to exactly 64
        total_blocks = system_blocks + tools_blocks + tool_use_blocks + msg_blocks + free_blocks
        if total_blocks != self._CTX_GRID_TOTAL:
            diff_blocks = self._CTX_GRID_TOTAL - total_blocks
            categories = [
                ("system", system_blocks),
                ("tools", tools_blocks),
                ("tool_use", tool_use_blocks),
                ("messages", msg_blocks),
                ("free", free_blocks),
            ]
            largest_cat = max(categories, key=lambda x: x[1])[0]
            if largest_cat == "system":
                system_blocks += diff_blocks
            elif largest_cat == "tools":
                tools_blocks += diff_blocks
            elif largest_cat == "tool_use":
                tool_use_blocks += diff_blocks
            elif largest_cat == "messages":
                msg_blocks += diff_blocks
            else:
                free_blocks += diff_blocks

        block_map = {
            "system": self._CTX_BLOCK_SYSTEM,
            "tools": self._CTX_BLOCK_TOOLS,
            "tool_use": self._CTX_BLOCK_TOOL,
            "messages": self._CTX_BLOCK_MSGS,
            "free": self._CTX_BLOCK_FREE,
        }

        blocks: list[str] = []
        for _ in range(system_blocks):
            blocks.append(block_map["system"])
        for _ in range(tools_blocks):
            blocks.append(block_map["tools"])
        for _ in range(tool_use_blocks):
            blocks.append(block_map["tool_use"])
        for _ in range(msg_blocks):
            blocks.append(block_map["messages"])
        for _ in range(free_blocks):
            blocks.append(block_map["free"])

        grid_lines: list[str] = []
        for row in range(self._CTX_GRID_ROWS):
            start = row * self._CTX_GRID_COLS
            end = start + self._CTX_GRID_COLS
            grid_lines.append("".join(blocks[start:end]))
        return "\n".join(grid_lines)

    def _build_context_legend(self, tokens: tuple[int, int, int, int, int]) -> str:
        """Build the legend text showing token counts per category."""
        free_tokens, system_tokens, tools_tokens, tool_use_tokens, msg_tokens = tokens
        lines: list[str] = []
        if self._max_context and self._max_context > 0:
            free_pct = free_tokens / self._max_context * 100
            lines.append(
                f"{self._CTX_BLOCK_FREE} Free: "
                f"{Chain.format_tokens(free_tokens)} ({free_pct:.1f}%)"
            )
        else:
            lines.append(
                f"{self._CTX_BLOCK_FREE} Free: {Chain.format_tokens(free_tokens)}"
            )

        lines.append(
            f"{self._CTX_BLOCK_SYSTEM} System: {Chain.format_tokens(system_tokens)}"
        )
        lines.append(
            f"{self._CTX_BLOCK_TOOLS} Tools: {Chain.format_tokens(tools_tokens)}"
        )
        lines.append(
            f"{self._CTX_BLOCK_TOOL} Tool use: {Chain.format_tokens(tool_use_tokens)}"
        )
        lines.append(
            f"{self._CTX_BLOCK_MSGS} Messages: {Chain.format_tokens(msg_tokens)}"
        )
        return "\n".join(lines)

    def _flush_token_update(self) -> None:
        self._token_flush_scheduled = False
        self._last_token_update = time.monotonic()
        try:
            tokens = self._compute_context_tokens()
            if tokens is not None:
                self.query_one("#context-grid", Static).update(
                    self._build_context_grid(tokens)
                )
                self.query_one("#context-legend", Static).update(
                    self._build_context_legend(tokens)
                )
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

        entries: list[Static] = []
        for name, info in statuses.items():
            entries.append(Static(self._format_mcp_server(name, info)))

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
        self._rag_last = rag_last
        self._rag_duration = rag_duration
        self._rag_indexing = rag_indexing
        self._ast_last = ast_last
        self._ast_duration = ast_duration
        self._ast_indexing = ast_indexing
        self._refresh_index_display()

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
