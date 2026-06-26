"""Tests for SubagentUIManager mount-lock serialization and eviction."""

import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from stupidex.agents.manager import SubagentRecord, SubagentState
from stupidex.domain.agent import Agent, AgentTypes, ModelTier
from stupidex.domain.chain import Chain, ChainStatus
from stupidex.domain.message import Message, MessageRole, MessageType, Usage
from stupidex.widgets.message_widget import ChainFooterWidget
from stupidex.widgets.subagent_ui import SubagentUIManager


class _ConcurrencyTracker:
    """Stub for ``mount_streamed_message`` that records concurrency.

    Each call blocks on ``gate`` until the test sets it, letting us observe
    how many calls are inside the stub (i.e. past the mount lock) at once.
    """

    def __init__(self) -> None:
        self.active: int = 0
        self.max_concurrent: int = 0
        self.gate: asyncio.Event = asyncio.Event()
        self.entered: asyncio.Event = asyncio.Event()

    async def __call__(self, container, msg, state) -> None:
        self.active += 1
        self.max_concurrent = max(self.max_concurrent, self.active)
        self.entered.set()
        try:
            await self.gate.wait()
        finally:
            self.active -= 1


def _make_manager_for_messages() -> tuple[SubagentUIManager, MagicMock]:
    """Build a manager whose ``app.query_one`` returns a pane with a container.

    Suitable for driving ``on_message``: the pane's ``query_one`` yields a
    container mock, so the scroll-container lookup in ``on_message`` succeeds
    without touching the real Textual widget tree.
    """
    app = MagicMock()
    container = MagicMock()
    pane = MagicMock()
    pane.query_one.return_value = container
    app.query_one.return_value = pane
    mgr = SubagentUIManager(app)
    return mgr, pane


def _text_message() -> Message:
    return Message(role=MessageRole.ASSISTANT, content="hi", type=MessageType.TEXT)


class TestMountLockConcurrency(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_mounts_same_subagent_serialized(self) -> None:
        """Two concurrent on_message calls for the same subagent_id are
        serialized by the per-subagent mount lock: at most one is ever
        inside mount_streamed_message at a time."""
        mgr, _ = _make_manager_for_messages()
        tracker = _ConcurrencyTracker()
        msg = _text_message()

        with patch("stupidex.widgets.subagent_ui.mount_streamed_message", tracker):
            t1 = asyncio.create_task(mgr.on_message("sa1", msg))
            await tracker.entered.wait()

            t2 = asyncio.create_task(mgr.on_message("sa1", msg))
            # Give t2 a chance to either enter the stub (bug) or block on lock.
            for _ in range(50):
                await asyncio.sleep(0.01)
                if tracker.active == 2:
                    break

            self.assertEqual(tracker.max_concurrent, 1)
            self.assertEqual(tracker.active, 1)

            tracker.gate.set()
            await asyncio.gather(t1, t2)

        self.assertEqual(tracker.max_concurrent, 1)

    async def test_concurrent_mounts_different_subagents_parallel(self) -> None:
        """Two on_message calls for distinct subagent_ids run in parallel:
        both enter mount_streamed_message concurrently (max_concurrent == 2)."""
        mgr, _ = _make_manager_for_messages()
        tracker = _ConcurrencyTracker()
        msg = _text_message()

        with patch("stupidex.widgets.subagent_ui.mount_streamed_message", tracker):
            t1 = asyncio.create_task(mgr.on_message("sa1", msg))
            await tracker.entered.wait()

            t2 = asyncio.create_task(mgr.on_message("sa2", msg))
            for _ in range(50):
                await asyncio.sleep(0.01)
                if tracker.active == 2:
                    break

            self.assertEqual(tracker.max_concurrent, 2)
            self.assertEqual(tracker.active, 2)

            tracker.gate.set()
            await asyncio.gather(t1, t2)

        self.assertEqual(tracker.max_concurrent, 2)


class TestLockEviction(unittest.IsolatedAsyncioTestCase):
    def _make_manager_for_state_change(self) -> tuple[SubagentUIManager, MagicMock, MagicMock]:
        """Build a manager whose app.query_one('#tabs', ...) returns a tabs
        mock whose get_tab(...) succeeds, and whose sessions.active exposes a
        subagent_manager with a get_record that returns a record."""
        app = MagicMock()
        tabs = MagicMock()
        tab = MagicMock()
        tabs.get_tab.return_value = tab
        manager = MagicMock()
        record = MagicMock()
        manager.get_record.return_value = record
        sessions = MagicMock()
        sessions.active.subagent_manager = manager
        app.sessions = sessions

        def query_one(selector, cls=None):
            return tabs

        app.query_one.side_effect = query_one
        mgr = SubagentUIManager(app)
        return mgr, manager, record

    async def test_lock_evicted_on_terminal_state(self) -> None:
        """Reaching INTERRUPTED (a terminal state) prunes the mount lock for
        that subagent_id."""
        mgr, _manager, _record = self._make_manager_for_state_change()
        mgr._mount_locks["sa1"] = asyncio.Lock()
        self.assertIn("sa1", mgr._mount_locks)

        with patch.object(mgr, "update_sidebar", new_callable=AsyncMock):
            await mgr.on_state_change("sa1", SubagentState.INTERRUPTED)

        self.assertNotIn("sa1", mgr._mount_locks)

    async def test_lock_not_evicted_on_nonterminal_state(self) -> None:
        """Non-terminal states (RUNNING) must not evict the lock."""
        mgr, _manager, _record = self._make_manager_for_state_change()
        lock = asyncio.Lock()
        mgr._mount_locks["sa1"] = lock

        with patch.object(mgr, "update_sidebar", new_callable=AsyncMock):
            await mgr.on_state_change("sa1", SubagentState.RUNNING)

        self.assertIs(mgr._mount_locks["sa1"], lock)

    async def test_lock_recreated_after_eviction(self) -> None:
        """After eviction, a new on_message creates a fresh lock via
        setdefault (a new asyncio.Lock instance, not the evicted one)."""
        mgr, _pane = _make_manager_for_messages()
        old_lock = asyncio.Lock()
        mgr._mount_locks["sa1"] = old_lock

        mgr.prune_lock("sa1")
        self.assertNotIn("sa1", mgr._mount_locks)

        tracker = _ConcurrencyTracker()
        tracker.gate.set()
        msg = _text_message()

        with patch("stupidex.widgets.subagent_ui.mount_streamed_message", tracker):
            await mgr.on_message("sa1", msg)

        self.assertIn("sa1", mgr._mount_locks)
        self.assertIsNot(mgr._mount_locks["sa1"], old_lock)

    async def test_prune_lock_idempotent(self) -> None:
        """prune_lock on a missing subagent_id is a no-op."""
        mgr, _ = _make_manager_for_messages()
        mgr.prune_lock("never-existed")  # should not raise
        self.assertNotIn("never-existed", mgr._mount_locks)

    async def test_terminal_states_each_evict(self) -> None:
        """COMPLETED and FAILED also evict the lock, not just INTERRUPTED."""
        for state in (SubagentState.COMPLETED, SubagentState.FAILED, SubagentState.INTERRUPTED):
            with self.subTest(state=state):
                mgr, _manager, _record = self._make_manager_for_state_change()
                mgr._mount_locks["sa1"] = asyncio.Lock()
                with patch.object(mgr, "update_sidebar", new_callable=AsyncMock):
                    await mgr.on_state_change("sa1", state)
                self.assertNotIn("sa1", mgr._mount_locks)


class TestSubagentFooter(unittest.IsolatedAsyncioTestCase):
    """U6: each subagent TabPane mounts a ChainFooterWidget showing
    model + tokens; restored-completed subagents get freeze() at mount."""

    def _make_agent(self) -> Agent:
        return Agent(
            name="Subagent",
            type=AgentTypes.SUBAGENT,
            tier=ModelTier.PAPUDO,
            description="d",
            system_prompt="p",
        )

    def _record_with_usage(self, rec_id: str = "sa1") -> SubagentRecord:
        return SubagentRecord(
            id=rec_id,
            agent=self._make_agent(),
            state=SubagentState.RUNNING,
            label="worker",
            task="t",
            start_time=1.0,
            model="sub-model",
            chain=Chain(
                model="sub-model",
                messages=[
                    Message(MessageRole.USER, "q"),
                    Message(
                        MessageRole.ASSISTANT,
                        "answer",
                        MessageType.TEXT,
                        usage=Usage(
                            prompt_tokens=1000,
                            cached_tokens=400,
                            completion_tokens=200,
                            total_tokens=1200,
                        ),
                    ),
                ],
            ),
        )

    async def test_on_spawn_mounts_footer_showing_model_and_tokens(self) -> None:
        from stupidex.app import Stupidex

        app = Stupidex()
        async with app.run_test():
            record = self._record_with_usage()
            await app._subagent_ui.on_spawn(record)

            # The footer is stored in _widgets and mounted in the pane.
            self.assertIn("sa1", app._subagent_ui._widgets)
            footer = app._subagent_ui._widgets["sa1"].get("footer")
            self.assertIsNotNone(footer)
            self.assertIsInstance(footer, ChainFooterWidget)
            text = footer._build_text()
            self.assertIn("sub-model", text)
            self.assertIn("↑1.0k", text)
            self.assertIn("(⟲400)", text)
            self.assertIn("↓200", text)

    async def test_sync_tabs_freezes_footer_for_restored_completed(self) -> None:
        from stupidex.agents.manager import SubagentManager
        from stupidex.app import Stupidex

        app = Stupidex()
        async with app.run_test():
            record = self._record_with_usage()
            record.state = SubagentState.COMPLETED
            # Simulate what SubagentRecord.from_storage_dict does at restore:
            # the chain (persisted while still RUNNING) is reconciled to the
            # terminal state before the UI ever sees it.
            record.finalize_chain_on_restore()
            manager = SubagentManager()
            manager._subagents[record.id] = record
            await app._subagent_ui.sync_tabs(manager)

            footer = app._subagent_ui._widgets[record.id].get("footer")
            self.assertIsNotNone(footer)
            self.assertIsInstance(footer, ChainFooterWidget)
            # Restored-completed: chain status finalized and footer frozen.
            self.assertEqual(record.chain.status, ChainStatus.COMPLETED)
            text = footer._build_text()
            self.assertIn("sub-model", text)
            self.assertIn("↑1.0k", text)
            self.assertIn("(⟲400)", text)
            self.assertIn("↓200", text)

    async def test_tick_timer_ticks_running_footer(self) -> None:
        from stupidex.app import Stupidex

        app = Stupidex()
        async with app.run_test():
            record = self._record_with_usage()
            # Inject into the active session's subagent_manager, which is
            # what _tick_subagent_footers reads from.
            session = app.sessions.create()
            session.subagent_manager._subagents[record.id] = record
            await app._subagent_ui.on_spawn(record)

            footer = app._subagent_ui._widgets[record.id]["footer"]
            # Running subagent → footer remains RUNNING and tick refreshes.
            self.assertEqual(record.chain.status, ChainStatus.RUNNING)
            with patch.object(footer, "tick") as tick_spy:
                app._subagent_ui._tick_subagent_footers()
                tick_spy.assert_called_once()

            # Now mark terminal. The manager's _run finally (or
            # finalize_chain_on_restore on restore) finalizes the chain; the
            # UI timer then just freezes the already-terminal footer.
            record.state = SubagentState.COMPLETED
            record.finalize_chain_on_restore()
            self.assertEqual(record.chain.status, ChainStatus.COMPLETED)
            with patch.object(footer, "freeze") as freeze_spy:
                app._subagent_ui._tick_subagent_footers()
                freeze_spy.assert_called_once()

    async def test_mount_all_messages_renders_chain_footer_with_subagent_subtotal(self) -> None:
        # Integration: mount_all_messages → ChainContainer(subagent_subtotal=
        # _make_subagent_subtotal_provider(...)) → ChainFooterWidget.freeze()
        # must render both the chain's own usage AND the (sub: ...) segment
        # attributed via parent_chain_index (U7 end-to-end, not just the unit
        # _build_text path).
        from stupidex.app import Stupidex

        app = Stupidex()
        async with app.run_test():
            session = app.sessions.create()
            # A chain whose own final assistant message carries usage.
            user_msg = Message(MessageRole.USER, "hello")
            assistant_msg = Message(
                MessageRole.ASSISTANT, "answer",
                usage=Usage(
                    prompt_tokens=1000, cached_tokens=400,
                    completion_tokens=200, total_tokens=1200,
                ),
            )
            chain = Chain(model="m", messages=[user_msg, assistant_msg])
            session.chains.append(chain)

            # A subagent attributed to chain index 0, carrying its own usage.
            sub = SubagentRecord(
                id="sa-attr",
                agent=self._make_agent(),
                state=SubagentState.COMPLETED,
                label="worker",
                task="t",
                start_time=1.0,
                parent_chain_index=0,
                model="sub-model",
                chain=Chain(
                    model="sub-model",
                    messages=[
                        Message(MessageRole.USER, "q"),
                        Message(
                            MessageRole.ASSISTANT, "a sub",
                            usage=Usage(
                                prompt_tokens=500, cached_tokens=100,
                                completion_tokens=50, total_tokens=550,
                            ),
                        ),
                    ],
                ),
            )
            sub.finalize_chain_on_restore()
            session.subagent_manager._subagents[sub.id] = sub

            await app.mount_all_messages()

            container = app.query_one("#output")
            footer = container.query_one(ChainFooterWidget)
            text = footer._build_text()
            # Chain's own usage.
            self.assertIn("↑1.0k", text)
            self.assertIn("(⟲400)", text)
            self.assertIn("↓200", text)
            # Attributed subagent subtotal.
            self.assertIn("(sub:", text)
            self.assertIn("↑500", text)
            self.assertIn("(⟲100)", text)
            self.assertIn("↓50", text)


if __name__ == "__main__":
    unittest.main()
