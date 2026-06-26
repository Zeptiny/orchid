import asyncio
import logging
from collections.abc import Callable
from enum import Enum

from textual.app import App, ComposeResult
from textual.containers import Horizontal, ScrollableContainer
from textual.widgets import LoadingIndicator, Static, TabbedContent, TabPane, TextArea

from stupidex.agents import get_agent_registry
from stupidex.agents.manager import set_current_chain_index
from stupidex.commands.session_commands import SessionCommands, execute_command
from stupidex.config import get_current_theme
from stupidex.domain.chain import Chain, ChainStatus
from stupidex.domain.message import (
    Message,
    MessageRole,
    MessageType,
    StreamHistoryState,
    record_streamed_message,
)
from stupidex.domain.session import Session, SessionManager, set_current_session_id
from stupidex.domain.todo import get_todo_store, set_todo_refresh_callback
from stupidex.llm.client import classify_error, stream_response
from stupidex.personality import append_personality
from stupidex.themes import get_theme_registry
from stupidex.widgets.command_picker import CommandPicker
from stupidex.widgets.message_widget import (
    ChainContainer,
    StreamWidgetState,
    create_message_widget,
    mount_streamed_message,
)
from stupidex.widgets.sidebar import NavEntry, Sidebar, SidebarMainSelected, SidebarSubagentSelected
from stupidex.widgets.subagent_ui import SubagentUIManager

log = logging.getLogger(__name__)


def _sum_usage(messages: list) -> tuple[int, int, int, int] | None:
    """Sum token usage across all messages carrying ``usage``.

    Within a single agentic chain the model may make several LLM calls (think
    -> tool -> assistant); each emits its own cumulative ``Usage`` snapshot.
    Summing all of them yields the chain's true cumulative consumption, rather
    than the last snapshot alone (which fluctuates as calls alternate).

    Returns ``(prompt_tokens, cached_tokens, completion_tokens, total_tokens)``
    when at least one message has usage, otherwise ``None``.
    """
    prompt = cached = completion = total = 0
    found = False
    for msg in messages:
        if msg.usage is None:
            continue
        found = True
        prompt += msg.usage.prompt_tokens
        cached += msg.usage.cached_tokens
        completion += msg.usage.completion_tokens
        total += msg.usage.total_tokens
    if not found:
        return None
    return (prompt, cached, completion, total)


def _session_usage_totals(session: "Session") -> tuple[int, int, int, int] | None:
    """Sum token usage across chains and subagent records in ``session``.

    Each chain contributes the sum of every usage-bearing message it holds
    (cumulative across the chain's agentic-loop calls), not just the last
    snapshot. Subagent records (R5/R6) are reached via
    ``session.subagent_manager.all_records()``; each contributes the same sum
    over its composed ``record.chain``.

    Returns ``(prompt_tokens, cached_tokens, completion_tokens, total_tokens)``
    when at least one message-list has usage, otherwise ``None``.
    """
    prompt = cached = completion = total = 0
    found = False
    for chain in session.chains:
        usage = _sum_usage(chain.messages)
        if usage is None:
            continue
        found = True
        prompt += usage[0]
        cached += usage[1]
        completion += usage[2]
        total += usage[3]
    # Fold subagent usage into the session total (R6). Each subagent's
    # composed chain contributes its own usage sum.
    for record in session.subagent_manager.all_records():
        usage = _sum_usage(record.chain.messages)
        if usage is None:
            continue
        found = True
        prompt += usage[0]
        cached += usage[1]
        completion += usage[2]
        total += usage[3]
    if not found:
        return None
    return (prompt, cached, completion, total)


def _format_session_model_label(
    model: str, totals: tuple[int, int, int, int] | None
) -> str:
    """Render the ``#model`` footer label.

    ``{model}`` alone when there is no usage, otherwise
    ``{model} · ↑{input} (⟲{cached}) ↓{output}`` with cached shown as a
    subset parenthetical (never summed with input).
    """
    if totals is None:
        return model
    prompt, cached, completion, _total = totals
    return (
        f"{model} · ↑{Chain.format_tokens(prompt)} "
        f"(⟲{Chain.format_tokens(cached)}) ↓{Chain.format_tokens(completion)}"
    )


def _chain_subagent_subtotals(
    session: "Session", chain_index: int
) -> tuple[int, int, int, int] | None:
    """Sum usage of subagents attributed to ``chain_index`` via
    ``parent_chain_index`` (R11).

    Mirrors the summation style of :func:`_session_usage_totals`: each
    attributed subagent contributes the sum of every usage-bearing message
    on its composed ``record.chain``. Returns ``None`` when no attributed
    subagent record has usage.
    """
    prompt = cached = completion = total = 0
    found = False
    for record in session.subagent_manager.all_records():
        if record.parent_chain_index != chain_index:
            continue
        usage = _sum_usage(record.chain.messages)
        if usage is None:
            continue
        found = True
        prompt += usage[0]
        cached += usage[1]
        completion += usage[2]
        total += usage[3]
    if not found:
        return None
    return (prompt, cached, completion, total)


def _make_subagent_subtotal_provider(
    session: "Session", chain_index: int
) -> "Callable[[], tuple[int, int, int, int] | None] | None":
    """Return a closure computing the attributed subagent subtotal for the
    given chain at render time.

    Resolved lazily on each ``_build_text`` call so that subagents spawned
    during a live stream are picked up by subsequent ``tick``s without
    re-mounting.  Returns ``None`` when ``chain_index`` is ``None`` (subagents
    spawned outside any turn, e.g. in test harnesses).
    """
    if chain_index is None:
        return None

    def _provider() -> tuple[int, int, int, int] | None:
        return _chain_subagent_subtotals(session, chain_index)

    return _provider


class InterruptState(Enum):
    IDLE = "idle"
    CONFIRM_AGENT = "confirm_agent"
    CONFIRM_SUBAGENTS = "confirm_subagents"


class InputTextArea(TextArea):
    _app_ref: "Stupidex | None" = None

    def _on_resize(self) -> None:
        super()._on_resize()
        if self._app_ref is not None:
            self._app_ref._update_input_height(self)


class Stupidex(App):
    CSS_PATH = "main.tcss"
    BINDINGS = [
        ("ctrl+p", "command_palette", "Commands"),
        ("escape", "interrupt", "Interrupt"),
        ("ctrl+s", "submit_input", "Submit"),
        ("ctrl+c", "clear_input", "Clear Input"),
        ("ctrl+b", "toggle_sidebar_focus", "Toggle Sidebar"),
    ]
    COMMANDS = {SessionCommands}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.sessions: SessionManager = SessionManager()
        self._interrupt_state: InterruptState = InterruptState.IDLE
        self._active_worker: object | None = None
        self._subagent_ui = SubagentUIManager(self)
        self._current_chain: ChainContainer | None = None
        self._footer_timer: object | None = None
        self._interrupt_timer: object | None = None
        self.restart_requested: bool = False
        self._setup_themes()

    def request_restart(self) -> None:
        """Flag the app for a full process restart on next idle.

        ``main()`` checks ``restart_requested`` after ``app.run()`` returns and
        re-execs the process via ``os.execv`` so config that only binds at
        startup (e.g. ``mcp_servers``) is reloaded cleanly.
        """
        self.restart_requested = True
        self.exit()

    def _setup_themes(self) -> None:
        registry = get_theme_registry()
        for name in registry.list_themes():
            self.register_theme(registry.get(name))
        current = get_current_theme()
        if current in registry.list_themes():
            self.theme = registry.get(current).name

    def switch_theme(self, name: str) -> None:
        registry = get_theme_registry()
        theme = registry.get(name)
        self.theme = theme.name

    @property
    def messages(self) -> list[Message]:
        return self.sessions.active.messages if self.sessions.active else []

    @property
    def model(self) -> str | None:
        return self.sessions.active.model if self.sessions.active else None

    def compose(self) -> ComposeResult:
        with Horizontal(id="header"):
            yield Static(self.sessions.active.name if self.sessions.active else "No Session", id="title")
        with TabbedContent(id="tabs", initial="main"), TabPane("Main", id="main"):
            yield ScrollableContainer(id="output")
        yield CommandPicker(SessionCommands.COMMANDS)
        yield InputTextArea(id="input", highlight_cursor_line=False)
        with Horizontal(id="footer"):
            yield LoadingIndicator(id="spinner")
            yield Static("N/A Model", id="model")
            yield Static("", id="interrupt-hint")
        yield Sidebar(id="sidebar")

    async def on_mount(self) -> None:
        self.sessions.create()
        set_todo_refresh_callback(self.refresh_todos)
        self.query_one("#title", Static).update(self.sessions.active.name)
        await self.mount_all_messages()
        text_area = self.query_one("#input", InputTextArea)
        text_area._app_ref = self
        text_area.display = True
        self._update_input_height(text_area)
        text_area.focus()
        try:
            sidebar = self.query_one("#sidebar", Sidebar)
            sidebar.set_active("main")
        except Exception:
            pass
        await self.rerender_footer()
        await self.refresh_todos()
        from stupidex.config import get_config
        from stupidex.mcp import MCPManager, set_mcp_manager
        cfg = get_config()
        if cfg.mcp_servers:
            mcp_manager = MCPManager()
            await mcp_manager.start_all(cfg.mcp_servers)
            set_mcp_manager(mcp_manager)
            self._mcp_manager = mcp_manager
        else:
            set_mcp_manager(None)
        await self.refresh_mcp_servers()
        await self.refresh_index_status()

    async def on_unmount(self) -> None:
        self._subagent_ui.stop()
        if hasattr(self, '_mcp_manager') and self._mcp_manager is not None:
            try:
                await self._mcp_manager.shutdown()
            except Exception:
                pass
        from stupidex.mcp import set_mcp_manager
        set_mcp_manager(None)
        set_current_session_id(None)

    def _is_streaming(self) -> bool:
        return self._active_worker is not None and not self._active_worker.is_finished

    def _has_running_subagents(self) -> bool:
        if not self.sessions.active:
            return False
        return self._subagent_ui.has_running(self.sessions.active.subagent_manager)

    async def action_interrupt(self) -> None:
        try:
            picker = self.query_one("#command-picker", CommandPicker)
            if picker.display:
                picker.hide()
                return
        except Exception:
            pass

        hint = self.query_one("#interrupt-hint", Static)

        if self._interrupt_state == InterruptState.IDLE:
            if self._is_streaming():
                self._interrupt_state = InterruptState.CONFIRM_AGENT
                hint.update("[bold yellow]Press Esc again to interrupt agent[/]")
                self._start_interrupt_timeout()
            elif self._has_running_subagents():
                self._interrupt_state = InterruptState.CONFIRM_SUBAGENTS
                hint.update("[bold red]Press Esc again to interrupt subagents[/]")
                self._start_interrupt_timeout()
        elif self._interrupt_state == InterruptState.CONFIRM_AGENT:
            self._interrupt_state = InterruptState.CONFIRM_SUBAGENTS
            if self._active_worker and not self._active_worker.is_finished:
                self._active_worker.cancel()
            if self._has_running_subagents():
                hint.update("[bold red]Press Esc again to interrupt subagents[/]")
                self._start_interrupt_timeout()
            else:
                self._reset_interrupt_state()
        elif self._interrupt_state == InterruptState.CONFIRM_SUBAGENTS:
            if self.sessions.active:
                cancelled = self.sessions.active.subagent_manager.cancel_running()
                await self.sessions.active.subagent_manager.flush_state_callbacks()
                if cancelled:
                    names = []
                    for sid in cancelled:
                        record = self.sessions.active.subagent_manager.get_record(sid)
                        if record:
                            names.append(record.label or record.name)
                    detail = ", ".join(names) if names else f"{len(cancelled)} subagent(s)"
                    interrupt_msg = Message(
                        role=MessageRole.ASSISTANT,
                        content=f"[Subagents interrupted by user: {detail}]",
                    )
                    if self._current_chain:
                        self._current_chain.chain.messages.append(interrupt_msg)
                    try:
                        await self.mount_message(interrupt_msg)
                    except Exception:
                        pass
            self._reset_interrupt_state()

    def _reset_interrupt_state(self) -> None:
        self._interrupt_state = InterruptState.IDLE
        if self._interrupt_timer is not None:
            self._interrupt_timer.stop()
            self._interrupt_timer = None
        try:
            self.query_one("#interrupt-hint", Static).update("")
        except Exception:
            pass

    def _start_interrupt_timeout(self) -> None:
        """Auto-reset interrupt state after 5 seconds of inactivity."""
        if self._interrupt_timer is not None:
            self._interrupt_timer.stop()
        self._interrupt_timer = self.set_timer(5.0, self._reset_interrupt_state)

    async def action_submit_input(self) -> None:
        if self._is_streaming():
            return
        text_area = self.query_one("#input", TextArea)
        user_msg = text_area.text.strip()
        if not user_msg:
            return

        picker = self.query_one("#command-picker", CommandPicker)
        if picker.display and user_msg.startswith("/"):
            command = picker.get_selected_command()
            text_area.clear()
            picker.hide()
            if command:
                await execute_command(self, command)
            return

        text_area.clear()
        self._start_chain()
        msg = Message(role=MessageRole.USER, content=user_msg)
        self._current_chain.chain.messages.append(msg)
        await self.mount_message(msg)
        self._reset_interrupt_state()
        self.streaming_started()
        self._active_worker = self.run_worker(self._stream_response(), exit_on_error=False)

    _INPUT_MAX_CONTENT_ROWS = 3

    def _update_input_height(self, text_area: TextArea) -> None:
        line_count = text_area.wrapped_document.height if text_area.soft_wrap else text_area.document.line_count
        content_rows = max(1, min(line_count, self._INPUT_MAX_CONTENT_ROWS))
        text_area.set_styles(height=content_rows + 2)

    def on_text_area_changed(self, event: TextArea.Changed) -> None:
        if event.text_area.id != "input":
            return
        self._update_input_height(event.text_area)
        text = event.text_area.text.strip()
        try:
            picker = self.query_one("#command-picker", CommandPicker)
        except Exception:
            return
        if text.startswith("/"):
            picker.update_filter(text)
        elif picker.display:
            picker.hide()

    async def on_command_picker_command_selected(self, event: CommandPicker.CommandSelected) -> None:
        text_area = self.query_one("#input", TextArea)
        text_area.clear()
        self.query_one("#command-picker", CommandPicker).hide()
        await execute_command(self, event.command)

    def watch_focused(self, focused) -> None:
        if focused and focused.id == "input":
            try:
                picker = self.query_one("#command-picker", CommandPicker)
                if picker.display:
                    picker.hide()
            except Exception:
                pass

    def action_clear_input(self) -> None:
        self.query_one("#input", TextArea).clear()

    def action_toggle_sidebar_focus(self) -> None:
        focused = self.focused
        if isinstance(focused, NavEntry):
            self._switch_to_main_view()
            self.query_one("#input", TextArea).focus()
        else:
            try:
                sidebar = self.query_one("#sidebar", Sidebar)
                entries = sidebar._get_focusable_entries()
                if entries:
                    entries[0].focus()
            except Exception:
                pass

    def _switch_to_main_view(self) -> None:
        tabs = self.query_one("#tabs", TabbedContent)
        tabs.active = "main"
        self.query_one("#input", TextArea).display = True
        sidebar = self.query_one("#sidebar", Sidebar)
        sidebar.set_active("main")

    async def _stream_response(self) -> None:
        output = self.query_one("#output", ScrollableContainer)
        container = self._current_chain.messages_area if self._current_chain else output

        ws = StreamWidgetState()
        history_state = StreamHistoryState()

        self._subagent_ui.setup(self.sessions.active.subagent_manager)

        try:
            general = get_agent_registry()["general"]
            system_prompt = append_personality(general.system_prompt)
            async for msg in stream_response(
                messages=self.messages,
                model=self.model,
                allowed_tools=general.allowed_tools,
                system_prompt=system_prompt,
                allowed_skills=general.allowed_skills,
            ):
                record_streamed_message(self._current_chain.chain.messages, msg, history_state)

                await mount_streamed_message(container, msg, ws)

                if ws.content and msg.usage:
                    ws.content.msg.usage = msg.usage
        except asyncio.CancelledError:
            interrupted_msg = Message(
                role=MessageRole.ASSISTANT,
                content="[Interrupted by user]",
            )
            if self._current_chain:
                self._current_chain.chain.messages.append(interrupted_msg)
            self._freeze_chain(ChainStatus.INTERRUPTED)
            for tw in ws.temp:
                try:
                    await tw.remove()
                except Exception:
                    pass
            ws.temp.clear()
            try:
                await self.mount_message(interrupted_msg)
            except Exception:
                pass
            raise
        except Exception as exc:
            self._freeze_chain(ChainStatus.FAILED)
            log.exception("Stream response failed")
            for tw in ws.temp:
                try:
                    await tw.remove()
                except Exception:
                    pass
            ws.temp.clear()
            try:
                title, detail = classify_error(exc)
                error_msg = Message(
                    role=MessageRole.ASSISTANT,
                    content=detail,
                    type=MessageType.ERROR,
                    metadata={"error_title": title},
                )
            except Exception:
                error_msg = Message(
                    role=MessageRole.ASSISTANT,
                    content=str(exc)[:200] or type(exc).__name__,
                    type=MessageType.ERROR,
                    metadata={"error_title": "Unexpected Error"},
                )
            try:
                await mount_streamed_message(container, error_msg, ws)
            except Exception:
                log.exception("Failed to mount error widget")
        finally:
            await self.streaming_finished()

    def _start_chain(self) -> None:
        chain = Chain(model=self.model)
        chain_index = None
        if self.sessions.active:
            self.sessions.active.chains.append(chain)
            chain_index = len(self.sessions.active.chains) - 1
            set_current_chain_index(chain_index)
        subtotal_provider = (
            _make_subagent_subtotal_provider(self.sessions.active, chain_index)
            if chain_index is not None
            else None
        )
        container = self.query_one("#output", ScrollableContainer)
        self._current_chain = ChainContainer(chain, subagent_subtotal=subtotal_provider)
        container.mount(self._current_chain)

    async def _mount_in_chain(self, msg: Message) -> None:
        widget = create_message_widget(msg)
        if widget is None:
            return
        if self._current_chain and self._current_chain.messages_area:
            await self._current_chain.messages_area.mount(widget)
            widget.scroll_visible(animate=False)
        else:
            container = self.query_one("#output", ScrollableContainer)
            await container.mount(widget)
            widget.scroll_visible(animate=False)

    def streaming_started(self) -> None:
        self.query_one("#spinner").display = True
        self._footer_timer = self.set_interval(1.0, self._tick_footer)

    async def streaming_finished(self) -> None:
        self.query_one("#spinner").display = False
        self._freeze_chain()
        if self._interrupt_state != InterruptState.CONFIRM_SUBAGENTS:
            self._reset_interrupt_state()
        await self.rerender_footer()
        named_session = await self._auto_name_session()
        await self._auto_save_session(named_session)

    def _freeze_chain(self, status: ChainStatus = ChainStatus.COMPLETED) -> None:
        if self._footer_timer:
            self._footer_timer.stop()
            self._footer_timer = None
        if self._current_chain:
            self._current_chain.chain.finish(status)
            self._current_chain.freeze()
            self._current_chain = None
        # Clear the chain index so a subagent spawned outside a streaming turn
        # (test harness, future dispatch paths) is attributed to no chain
        # rather than the stale last-turn index.
        set_current_chain_index(None)

    async def _auto_save_session(self, session: Session | None = None) -> None:
        """Fire-and-forget save of the given session (or active) to disk."""
        target = session or self.sessions.active
        if not target:
            return
        try:
            await asyncio.to_thread(self.sessions.save, target)
        except Exception:
            log.exception("Auto-save failed")

    async def _auto_name_session(self) -> Session | None:
        """Generate a session name after the first exchange using tolo tier.

        Returns the captured session so the caller can save it explicitly,
        even if the active session has changed in the meantime.
        """
        session = self.sessions.active
        if not session:
            return None
        if session.name.startswith("Session "):
            try:
                import litellm

                from stupidex.config import get_config, get_model_for_tier
                from stupidex.llm.providers import qualify_model, resolve_model_ref

                model = get_model_for_tier("tolo")
                user_content = ""
                assistant_content = ""
                for chain in session.chains:
                    for msg in chain.messages:
                        if msg.type == MessageType.THINKING:
                            continue
                        if msg.role == MessageRole.USER and not user_content:
                            user_content = msg.content[:200]
                        elif msg.role == MessageRole.ASSISTANT and msg.type == MessageType.TEXT and not assistant_content:
                            assistant_content = msg.content[:200]
                    if user_content and assistant_content:
                        break
                if not user_content:
                    return session
                prompt = (
                    "Generate a short, descriptive session title (3-6 words) for this conversation.\n"
                    "Reply with ONLY the title, no quotes, no extra text.\n\n"
                    f"User: {user_content}\n"
                )
                if assistant_content:
                    prompt += f"Assistant: {assistant_content}\n"
                litellm_provider, model_id, base_url, api_key = resolve_model_ref(
                    model or get_config().default_model
                )
                litellm_model = qualify_model(litellm_provider, model_id)
                response = await litellm.acompletion(
                    model=litellm_model,
                    messages=[{"role": "user", "content": prompt}],
                    base_url=base_url,
                    api_key=api_key,
                    timeout=60,
                )
                title = response.choices[0].message.content.strip().strip('"').strip("'")
                if title and len(title) < 80:
                    session.name = title
                    if self.sessions.active is session:
                        try:
                            self.query_one("#title", Static).update(title)
                        except Exception:
                            pass
            except Exception:
                log.debug("Auto-naming failed, keeping default name", exc_info=True)
        return session

    async def _tick_footer(self) -> None:
        if self._current_chain:
            self._current_chain.tick()
        await self.rerender_footer()

    def on_sidebar_main_selected(self, event: SidebarMainSelected) -> None:
        tabs = self.query_one("#tabs", TabbedContent)
        tabs.active = "main"
        self.query_one("#input", TextArea).display = True
        sidebar = self.query_one("#sidebar", Sidebar)
        sidebar.set_active("main")

    def on_sidebar_subagent_selected(self, event: SidebarSubagentSelected) -> None:
        tabs = self.query_one("#tabs", TabbedContent)
        tabs.active = f"sub-{event.subagent_id}"
        self.query_one("#input", TextArea).display = False
        sidebar = self.query_one("#sidebar", Sidebar)
        sidebar.set_active(event.subagent_id)

    async def mount_message(self, msg: Message) -> None:
        await self._mount_in_chain(msg)

    async def mount_all_messages(self) -> None:
        container = self.query_one("#output", ScrollableContainer)
        await container.remove_children()
        if not self.sessions.active:
            return
        for chain_index, chain in enumerate(self.sessions.active.chains):
            subtotal_provider = _make_subagent_subtotal_provider(
                self.sessions.active, chain_index
            )
            chain_container = ChainContainer(chain, subagent_subtotal=subtotal_provider)
            await container.mount(chain_container)
            chain_container.freeze()
            prev_was_thinking = False
            for msg in chain.messages:
                classes = (
                    "after-thinking"
                    if msg.type == MessageType.TOOL_RESULT and prev_was_thinking
                    else None
                )
                widget = create_message_widget(msg, loaded=True, classes=classes)
                if widget is not None:
                    await chain_container.messages_area.mount(widget)
                if msg.type == MessageType.THINKING:
                    prev_was_thinking = True
                elif msg.type != MessageType.TOOL_CALL:
                    prev_was_thinking = False

    async def rerender_all(self) -> None:
        if not self.sessions.active:
            return

        self.query_one("#title", Static).update(self.sessions.active.name)
        await self.mount_all_messages()
        await self._subagent_ui.sync_tabs(self.sessions.active.subagent_manager)
        await self.rerender_footer()
        await self.refresh_todos()

    async def rerender_footer(self) -> None:
        if not self.sessions.active:
            return

        last_usage = None
        for msg in reversed(self.sessions.active.messages):
            if msg.usage:
                last_usage = msg.usage
                break
        try:
            sidebar = self.query_one("#sidebar", Sidebar)
            if last_usage:
                sidebar.update_tokens(
                    last_usage.prompt_tokens,
                    last_usage.completion_tokens,
                    last_usage.total_tokens,
                    view_id="main",
                    max_context=self._resolve_active_max_context(),
                )
            else:
                sidebar.update_tokens(
                    0, 0, 0, view_id="main", max_context=self._resolve_active_max_context()
                )
        except Exception:
            pass

        model_label = self.model or "No Model"
        totals = _session_usage_totals(self.sessions.active)
        self.query_one("#model", Static).update(_format_session_model_label(model_label, totals))

        await self._subagent_ui.update_sidebar()

    def _resolve_active_max_context(self) -> int | None:
        """Look up the active session's model `max_input_tokens`.

        Uses `self.model` (an `alias/model_id` string) -- or, when the session
        has not picked a model, the config default model -- and resolves it via
        `resolve_model_metadata`. The config alias (the segment before the `/`)
        is what `resolve_model_metadata` keys on, because the user's per-model
        override (`max_input_tokens`, etc.) lives under
        `providers.<alias>.models.<model_id>` in the config.

        Returns None when no model is configured, the ref is malformed, or the
        resolver returns a non-int `max_input_tokens` (None means "unknown").
        """
        from stupidex.config import get_config
        from stupidex.llm.providers import resolve_model_metadata

        model_ref = self.model or get_config().default_model
        if not model_ref:
            return None
        # Extract the config alias + model_id from the ref directly.
        # `resolve_model_ref` returns the *litellm provider name* (e.g. "openai")
        # as its first element, NOT the config alias -- and `resolve_model_metadata`
        # keys on the alias to find the user override.
        alias, sep, model_id = model_ref.partition("/")
        if not sep or not alias or not model_id:
            return None
        try:
            metadata = resolve_model_metadata(alias, model_id)
        except Exception:
            return None
        max_ctx = metadata.get("max_input_tokens")
        return max_ctx if isinstance(max_ctx, int) else None

    async def refresh_todos(self) -> None:
        try:
            store = get_todo_store()
            sidebar = self.query_one("#sidebar", Sidebar)
            await sidebar.update_todos(store.list())
        except Exception:
            pass

    async def refresh_mcp_servers(self) -> None:
        try:
            from stupidex.mcp import get_mcp_manager
            sidebar = self.query_one("#sidebar", Sidebar)
            manager = get_mcp_manager()
            if manager is not None:
                await sidebar.update_mcp_servers(manager.get_server_statuses())
            else:
                from stupidex.config import get_config
                cfg = get_config()
                statuses = {name: {"status": "off", "tool_count": 0} for name in cfg.mcp_servers}
                await sidebar.update_mcp_servers(statuses)
        except Exception:
            pass

    async def refresh_index_status(self) -> None:
        try:
            from pathlib import Path

            from stupidex.ast.indexer import is_indexing as ast_is_indexing
            from stupidex.ast.store import ASTStore
            from stupidex.rag.indexer import get_status as get_rag_status
            from stupidex.rag.indexer import is_indexing as rag_is_indexing
            sidebar = self.query_one("#sidebar", Sidebar)
            project_path = str(Path.cwd())
            rag = get_rag_status(project_path)
            ast_store = ASTStore(project_path)
            ast = ast_store.status()
            await sidebar.update_index_status(
                rag.last_indexed, rag.last_index_duration,
                ast.last_indexed, ast.last_index_duration,
                rag_indexing=rag_is_indexing(),
                ast_indexing=ast_is_indexing(),
            )
        except Exception:
            pass
