"""Tests for Sidebar Collapsible teardown safety and update concurrency.

Regression coverage for Bug A: the subagent sidebar rebuilds a
``Collapsible(classes='finished-collapse')`` for finished subagents and mounts
its entries by querying ``Contents`` *immediately after* mounting the
collapsible. During app teardown (exit while subagents are still running), the
1s subagent timer can fire into a partially-dismantled DOM and the
post-mount ``query_one("Contents")`` raises ``NoMatches``.

The fix mounts the finished entries as positional children of the
``Collapsible`` constructor so they are part of its ``compose()`` output,
removing the fragile post-mount query. This test asserts that contract: the
done entries are descendants of the Collapsible without a separate
``contents.mount`` step, and rebuilding during teardown does not raise.

Concurrency tests verify that ``SubagentUIManager.update_sidebar`` serialises
concurrent calls via an ``asyncio.Lock`` with coalescing, preventing
interleaved DOM mutations that caused duplicate entries and flicker.
"""
import asyncio
import unittest
from unittest.mock import patch

from textual.app import App, ComposeResult
from textual.widgets import Collapsible, TabbedContent

from stupidex.agents.manager import SubagentRecord, SubagentState
from stupidex.domain.chain import Chain
from stupidex.widgets.sidebar import NavEntry, Sidebar
from stupidex.widgets.subagent_ui import SubagentUIManager


def _record(rid: str, state: SubagentState = SubagentState.COMPLETED, label: str = "agent") -> SubagentRecord:
    """Build a SubagentRecord without the Agent dependency the constructor requires."""
    r = object.__new__(SubagentRecord)
    r.id = rid
    r.agent = None  # type: ignore[assignment] — label short-circuits the `name` property
    r.state = state
    r.label = label
    r.task = ""
    r.async_task = None
    r.result = None
    r.error = None
    r.start_time = 0.0
    r.end_time = None
    r.chain = Chain()
    r.model = None
    r.parent_chain_index = None
    r.messages_mounted = 0
    r.on_message = None
    r.on_state_change = None
    return r


class _SidebarApp(App):
    def compose(self) -> ComposeResult:
        yield Sidebar(id="sidebar")


class TestSidebarCollapsibleTeardown(unittest.IsolatedAsyncioTestCase):
    async def test_finished_entries_become_collapsible_children(self):
        """Done NavEntries must be descendants of the Collapsible after
        ``update_subagents``, populated via the Collapsible's own compose
        rather than a fragile post-mount ``query_one('Contents')``."""
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            records: list[SubagentRecord] = [
                _record("s1", SubagentState.COMPLETED, "first"),
                _record("s2", SubagentState.COMPLETED, "second"),
            ]
            await sidebar.update_subagents(records)
            await pilot.pause()

            collapsibles = sidebar.query(Collapsible)
            self.assertEqual(len(collapsibles), 1)
            collapse = collapsibles[0]
            self.assertIn("finished-collapse", collapse.classes)

            # The done entries should be present inside the collapsible's
            # Contents, without relying on a separate mount step.
            entries = collapse.query(NavEntry)
            entry_ids = {e.view_id for e in entries}
            self.assertEqual(entry_ids, {"s1", "s2"})

    async def test_update_subagents_tolerates_unqueryable_contents(self):
        """During app teardown, the freshly-mounted Collapsible's ``Contents``
        node may not be queryable (partial compose), which previously raised
        ``NoMatches``. The rebuild must not depend on a post-mount
        ``query_one('Contents')``: the done entries are passed as Collapsible
        children so they are part of its own ``compose()``.

        This simulates the teardown condition by making
        ``Collapsible.query_one('Contents')`` raise ``NoMatches``; the buggy
        code (which calls that query) raises, the fixed code does not.
        """
        from textual.css.query import NoMatches

        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_subagents([_record("s1")])
            await pilot.pause()

            real_query_one = Collapsible.query_one

            def query_one_raising_contents(self, selector=None, *args, **kwargs):  # type: ignore[no-untyped-def]
                # Simulate the teardown state where Contents is not yet
                # queryable right after mount.
                sel = selector if isinstance(selector, str) else ""
                if "Contents" in sel:
                    raise NoMatches("No nodes match 'Contents' (simulated teardown)")
                return real_query_one(self, selector, *args, **kwargs)

            with patch.object(Collapsible, "query_one", query_one_raising_contents):
                try:
                    await sidebar.update_subagents([
                        _record("s2", SubagentState.COMPLETED, "second"),
                    ])
                except NoMatches as exc:
                    self.fail(
                        "update_subagents raised NoMatches by depending on "
                        f"query_one('Contents'): {exc!r}"
                    )
                await pilot.pause()

            # Entries were still attached via the Collapsible's compose.
            collapse = sidebar.query_one(Collapsible)
            entry_ids = {e.view_id for e in collapse.query(NavEntry)}
            self.assertEqual(entry_ids, {"s2"})


class _SidebarWithTabsApp(App):
    """App variant that yields the TabbedContent needed by SubagentUIManager."""
    def compose(self) -> ComposeResult:
        yield Sidebar(id="sidebar")
        yield TabbedContent(id="tabs")


class _MockSession:
    """Minimal session stub providing a subagent_manager attribute."""
    def __init__(self, manager) -> None:
        self.subagent_manager = manager


class _MockSessions:
    """Minimal sessions stub with an active property."""
    def __init__(self, session) -> None:
        self.active = session


class _MockManager:
    """Minimal subagent manager stub that returns controlled records."""
    def __init__(self, records: list[SubagentRecord]) -> None:
        self._records = list(records)
        self.on_spawn = None

    def all_records(self) -> list[SubagentRecord]:
        return list(self._records)

    def set_records(self, records: list[SubagentRecord]) -> None:
        self._records = list(records)


def _make_ui_manager(app: App, manager: _MockManager) -> SubagentUIManager:
    """Build a SubagentUIManager wired to a mock sessions/manager."""
    session = _MockSession(manager)
    app.sessions = _MockSessions(session)  # type: ignore[assignment]
    ui = SubagentUIManager(app)
    return ui


class TestSidebarUpdateConcurrency(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_updates_produce_no_duplicates(self):
        """Two concurrent update_sidebar calls must not interleave the DOM
        rebuild. The final sidebar must contain exactly one set of entries."""
        async with _SidebarWithTabsApp().run_test() as pilot:
            r1 = _record("a1", SubagentState.RUNNING, "agent-1")
            r2 = _record("a2", SubagentState.COMPLETED, "agent-2")
            manager = _MockManager([r1, r2])
            ui = _make_ui_manager(pilot.app, manager)

            # Fire two concurrent sidebar updates
            await asyncio.gather(
                ui.update_sidebar(),
                ui.update_sidebar(),
            )
            await pilot.pause()

            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            container = sidebar.query_one("#subagent-entries")

            # Count NavEntry children — should be exactly 2 (a1 active + a2 done)
            entries = [c for c in container.children if isinstance(c, NavEntry)]
            # a1 is running (active NavEntry), a2 is completed (inside Collapsible)
            active_ids = [e.view_id for e in entries]
            self.assertEqual(active_ids, ["a1"], "Expected exactly one active NavEntry")

            collapsibles = container.query(Collapsible)
            self.assertEqual(len(collapsibles), 1, "Expected exactly one Collapsible")
            done_ids = {e.view_id for e in collapsibles[0].query(NavEntry)}
            self.assertEqual(done_ids, {"a2"})

    async def test_concurrent_updates_with_changing_structure(self):
        """When structure changes between rapid concurrent calls, the final
        state must reflect the latest records (no stale entries)."""
        async with _SidebarWithTabsApp().run_test() as pilot:
            r1 = _record("a1", SubagentState.RUNNING, "agent-1")
            manager = _MockManager([r1])
            ui = _make_ui_manager(pilot.app, manager)

            # First update — a1 is running
            await ui.update_sidebar()
            await pilot.pause()

            # a1 finishes
            r1_done = _record("a1", SubagentState.COMPLETED, "agent-1")
            manager.set_records([r1_done])

            # Two concurrent calls after state change
            await asyncio.gather(
                ui.update_sidebar(),
                ui.update_sidebar(),
            )
            await pilot.pause()

            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            container = sidebar.query_one("#subagent-entries")

            # a1 should be in the Collapsible (done), not as a standalone entry
            active_entries = [c for c in container.children
                              if isinstance(c, NavEntry)]
            self.assertEqual(active_entries, [],
                             "No active NavEntries expected after agent completed")

            collapsibles = container.query(Collapsible)
            self.assertEqual(len(collapsibles), 1)
            done_ids = {e.view_id for e in collapsibles[0].query(NavEntry)}
            self.assertEqual(done_ids, {"a1"})

    async def test_coalescing_skips_intermediate_requests(self):
        """When the lock is held, arriving callers should set dirty and return
        immediately. The in-flight caller re-runs once if dirty was set."""
        async with _SidebarWithTabsApp().run_test() as pilot:
            call_count = 0
            original_update_subagents = Sidebar.update_subagents

            async def counting_update_subagents(self_sidebar, records):
                nonlocal call_count
                call_count += 1
                await original_update_subagents(self_sidebar, records)

            r1 = _record("a1", SubagentState.RUNNING, "agent-1")
            manager = _MockManager([r1])
            ui = _make_ui_manager(pilot.app, manager)

            with patch.object(Sidebar, "update_subagents", counting_update_subagents):
                # Fire 5 concurrent updates — coalescing should reduce the
                # actual DOM rebuild count significantly.
                await asyncio.gather(
                    ui.update_sidebar(),
                    ui.update_sidebar(),
                    ui.update_sidebar(),
                    ui.update_sidebar(),
                    ui.update_sidebar(),
                )
                await pilot.pause()

            # With coalescing, the first caller holds the lock; subsequent
            # callers set dirty and return. The first caller re-runs at most
            # once more. So call_count should be <= 2 (not 5).
            self.assertLessEqual(call_count, 2,
                                 f"Expected at most 2 DOM rebuilds due to coalescing, got {call_count}")

    async def test_empty_records_after_concurrent_clears(self):
        """Concurrent calls that clear all entries must leave the container
        empty, not with stale or duplicated entries."""
        async with _SidebarWithTabsApp().run_test() as pilot:
            r1 = _record("a1", SubagentState.COMPLETED, "agent-1")
            manager = _MockManager([r1])
            ui = _make_ui_manager(pilot.app, manager)

            # Populate sidebar first
            await ui.update_sidebar()
            await pilot.pause()

            # Now clear all records
            manager.set_records([])

            # Concurrent clear calls
            await asyncio.gather(
                ui.update_sidebar(),
                ui.update_sidebar(),
            )
            await pilot.pause()

            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            container = sidebar.query_one("#subagent-entries")
            children = list(container.children)
            self.assertEqual(children, [],
                             f"Container should be empty after clearing, got {len(children)} children")
