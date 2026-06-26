from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from textual.containers import ScrollableContainer
from textual.timer import Timer
from textual.widgets import TabbedContent, TabPane

from stupidex.agents.manager import TERMINAL, SubagentRecord, SubagentState
from stupidex.domain.message import Message
from stupidex.widgets.message_widget import (
    ChainFooterWidget,
    StreamWidgetState,
    mount_streamed_message,
)
from stupidex.widgets.sidebar import Sidebar

if TYPE_CHECKING:
    from textual.app import App


log = logging.getLogger(__name__)


class SubagentUIManager:
    """Manages subagent tabs, widgets, and sidebar updates."""

    def __init__(self, app: App) -> None:
        self.app = app
        self._widgets: dict[str, dict[str, Any]] = {}
        self._timer: Timer | None = None
        self._sidebar_lock: asyncio.Lock = asyncio.Lock()
        self._sidebar_refresh_pending: bool = False
        self._mount_locks: dict[str, asyncio.Lock] = {}

    def setup(self, manager) -> None:
        """Wire callbacks on the subagent manager."""
        manager.on_spawn = self.on_spawn
        self._set_manager(manager)

    def _set_manager(self, manager) -> None:
        from stupidex.agents.manager import set_subagent_manager
        set_subagent_manager(manager)

    def has_running(self, manager) -> bool:
        terminal = {SubagentState.COMPLETED, SubagentState.FAILED, SubagentState.INTERRUPTED}
        return any(r.state not in terminal for r in manager.all_records())

    async def on_spawn(self, record: SubagentRecord) -> None:
        record.on_message = lambda msg, rid=record.id: self.on_message(rid, msg)
        record.on_state_change = lambda state, rid=record.id: self.on_state_change(rid, state)
        tabs = self.app.query_one("#tabs", TabbedContent)
        pane = TabPane(self._tab_label(record), id=f"sub-{record.id}")
        await tabs.add_pane(pane)
        # Ensure the scrollable container exists before mounting the footer so
        # the footer lands below the message area (mirrors ChainContainer.compose
        # ordering: messages first, footer last).
        try:
            pane.query_one(ScrollableContainer)
        except Exception:
            await pane.mount(ScrollableContainer())
        footer = ChainFooterWidget(record.chain)
        await pane.mount(footer)
        self._widgets.setdefault(record.id, {})["footer"] = footer
        for msg in record.messages[record.messages_mounted :]:
            await self.on_message(record.id, msg)
        await self.update_sidebar()

    async def on_message(self, subagent_id: str, msg: Message) -> None:
        if msg.usage:
            try:
                sidebar = self.app.query_one("#sidebar", Sidebar)
                sidebar.update_tokens(
                    msg.usage.prompt_tokens, msg.usage.completion_tokens, msg.usage.total_tokens, view_id=subagent_id
                )
            except Exception:
                pass

        try:
            pane = self.app.query_one(f"#sub-{subagent_id}", TabPane)
        except Exception:
            log.debug("on_message: pane not found for subagent_id=%r", subagent_id)
            return

        async with self._mount_locks.setdefault(subagent_id, asyncio.Lock()):
            try:
                container = pane.query_one(ScrollableContainer)
            except Exception:
                container = ScrollableContainer()
                await pane.mount(container)

            raw = self._widgets.setdefault(subagent_id, {"temp": []})
            existing_temp = raw.get("temp")
            temp_list = list(existing_temp) if isinstance(existing_temp, list) else []
            state = StreamWidgetState(
                thinking=raw.get("thinking"),
                content=raw.get("content"),
                temp=temp_list,
            )

            await mount_streamed_message(container, msg, state)

            raw["thinking"] = state.thinking
            raw["content"] = state.content
            raw["temp"] = state.temp

    async def on_state_change(self, subagent_id: str, state: SubagentState) -> None:
        try:
            tabs = self.app.query_one("#tabs", TabbedContent)
            tab = tabs.get_tab(f"sub-{subagent_id}")
        except Exception:
            return
        manager = self.app.sessions.active.subagent_manager if self.app.sessions.active else None
        if not manager:
            return
        record = manager.get_record(subagent_id)
        if not record:
            return
        tab.update(self._tab_label(record))
        if state in TERMINAL:
            self.prune_lock(subagent_id)
            footer = self._widgets.get(subagent_id, {}).get("footer")
            if footer is not None:
                footer.freeze()
        await self.update_sidebar()

    def prune_lock(self, subagent_id: str) -> None:
        """Remove the mount lock for a subagent that has reached a terminal state.

        Locks are recreated lazily via ``setdefault`` on the next ``on_message``,
        so evicting them here bounds ``_mount_locks`` to the set of subagents
        with pending or in-flight mounts.
        """
        self._mount_locks.pop(subagent_id, None)

    async def sync_tabs(self, manager) -> None:
        tabs = self.app.query_one("#tabs", TabbedContent)
        pane_ids = [p.id for p in tabs.query("TabPane") if p.id and p.id.startswith("sub-")]
        for pane_id in pane_ids:
            await tabs.remove_pane(pane_id)
        self._widgets.clear()
        self._mount_locks.clear()
        manager.on_spawn = self.on_spawn
        self._set_manager(manager)
        for record in manager.all_records():
            pane = TabPane(self._tab_label(record), id=f"sub-{record.id}")
            await tabs.add_pane(pane)
            record.on_message = lambda msg, rid=record.id: self.on_message(rid, msg)
            record.on_state_change = lambda state, rid=record.id: self.on_state_change(rid, state)
            for msg in record.messages:
                await self.on_message(record.id, msg)
            footer = ChainFooterWidget(record.chain)
            await pane.mount(footer)
            self._widgets.setdefault(record.id, {})["footer"] = footer
            # Restored subagents are terminal (PENDING/RUNNING were migrated
            # to INTERRUPTED during deserialization) and their chain status is
            # reconciled by finalize_chain_on_restore() in from_storage_dict,
            # so render the footer in its final state immediately — the UI
            # timer only runs while live subagents are active.
            if record.state in TERMINAL:
                footer.freeze()

    def _tick_subagent_footers(self) -> None:
        """Tick (or freeze) mounted subagent footers.

        Driven off the subagent UI timer, NOT the app footer timer: the app
        footer timer stops at ``streaming_finished`` while subagents often
        keep running past that point; only this timer stays alive then.

        For each mounted footer, ``tick()`` re-renders while the chain is
        ``RUNNING``; once the subagent is terminal, the chain is finalized
        and ``freeze()`` renders the final ``model · elapsed · tokens``.
        """
        if not self.app.sessions.active:
            return
        manager = self.app.sessions.active.subagent_manager
        for sid, entry in self._widgets.items():
            footer = entry.get("footer")
            if footer is None:
                continue
            record = manager.get_record(sid)
            if record is None:
                continue
            if record.state in TERMINAL:
                footer.freeze()
            else:
                footer.tick()

    async def update_sidebar(self) -> None:
        if self._sidebar_lock.locked():
            self._sidebar_refresh_pending = True
            return

        async with self._sidebar_lock:
            for _ in range(2):
                self._sidebar_refresh_pending = False
                try:
                    sidebar = self.app.query_one("#sidebar", Sidebar)
                except Exception:
                    return
                if self.app.sessions.active:
                    records = self.app.sessions.active.subagent_manager.all_records()
                    await sidebar.update_subagents(records)
                else:
                    await sidebar.update_subagents([])
                if not self._sidebar_refresh_pending:
                    break
        self._manage_timer()

    def _manage_timer(self) -> None:
        manager = self.app.sessions.active.subagent_manager if self.app.sessions.active else None
        has_running = manager is not None and self.has_running(manager)
        if has_running and self._timer is None:
            self._timer = self.app.set_interval(1.0, self._tick_timer)
        elif not has_running and self._timer is not None:
            self._timer.stop()
            self._timer = None

    def stop(self) -> None:
        """Stop the sidebar refresh timer during app teardown.

        Without this, a timer armed while subagents were running keeps firing
        into the partially-dismantled DOM during ``App.on_exit``, where a
        sidebar rebuild raised ``NoMatches`` on the freshly-mounted
        Collapsible's ``Contents`` node. ``stop`` is idempotent.
        """
        if self._timer is not None:
            self._timer.stop()
            self._timer = None

    async def _tick_timer(self) -> None:
        self._tick_subagent_footers()

    @staticmethod
    def _tab_label(record: SubagentRecord) -> str:
        from stupidex.agents.manager import SUBAGENT_INDICATORS
        indicator = SUBAGENT_INDICATORS.get(record.state, "?")
        return f"{indicator} {record.label}"
