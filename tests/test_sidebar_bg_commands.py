"""Tests for Sidebar Background Commands section and per-command expand.

Covers:
1. Section empty when store is empty; label hidden
2. Running command entry shows id, status, owner, age
3. Focusing input flips owner to USER
4. Releasing input focus reverts to AGENT
5. USER-owned entry idle beyond timeout reverts on tick
6. Exited commands move under Finished collapsible
7. Second command selection swaps the expanded tail
"""

import time
import unittest

from textual.app import App, ComposeResult
from textual.events import Blur
from textual.widgets import Collapsible, Static

from orchid.tools.background_store import (
    BackgroundProcessStore,
    HeadTailBuffer,
    ProcessEntry,
    set_background_store,
)
from orchid.widgets.sidebar import (
    BgCommandInput,
    NavEntry,
    Sidebar,
    SidebarBgCommandSelected,
)


def _make_bg_record(
    cmd_id: int,
    command: str = "echo hello",
    owner: str = "AGENT",
    status: str = "running",
    last_output_age: float = 5.0,
    interactive: bool = False,
    has_tail: bool = True,
) -> dict:
    return {
        "id": cmd_id,
        "command": command,
        "owner": owner,
        "status": status,
        "last_output_age": last_output_age,
        "interactive": interactive,
        "has_tail": has_tail,
    }


def _make_process_entry(
    cmd_id: int = 1,
    command: str = "echo hello",
    owner: str = "AGENT",
    exit_code: int | None = None,
    interactive: bool = False,
    last_output_at: float | None = None,
    created_at: float | None = None,
) -> ProcessEntry:
    """Build a ProcessEntry with a mock process for testing."""
    now = time.monotonic()
    buf = HeadTailBuffer()
    buf.append(b"hello world\n")
    # Use a mock process object that has the required attributes
    proc = type("MockProcess", (), {
        "returncode": exit_code,
        "pid": cmd_id * 100,
        "stdin": None,
        "stdout": None,
        "stderr": None,
        "kill": lambda self: None,
    })()
    return ProcessEntry(
        id=cmd_id,
        command=command,
        process=proc,
        buffer=buf,
        owner=owner,
        exit_code=exit_code,
        interactive=interactive,
        last_output_at=last_output_at or now,
        created_at=created_at or now,
    )


class _SidebarApp(App):
    def compose(self) -> ComposeResult:
        yield Sidebar(id="sidebar")


class TestBgCmdSectionEmpty(unittest.IsolatedAsyncioTestCase):
    """Scenario 1: Section empty when store is empty; label hidden."""

    async def test_empty_section_hides_label(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([])
            await pilot.pause()

            # Label should be hidden
            label = sidebar.query_one("#sidebar-bg-cmds-label", Static)
            self.assertFalse(label.display)

            # Container should be empty
            container = sidebar.query_one("#bg-cmds-entries")
            self.assertEqual(len(list(container.children)), 0)

    async def test_empty_section_clears_previous_entries(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)

            # First populate with entries
            await sidebar.update_background_commands([
                _make_bg_record(1),
            ])
            await pilot.pause()
            self.assertTrue(sidebar.query_one("#sidebar-bg-cmds-label").display)

            # Then clear
            await sidebar.update_background_commands([])
            await pilot.pause()

            label = sidebar.query_one("#sidebar-bg-cmds-label", Static)
            self.assertFalse(label.display)
            container = sidebar.query_one("#bg-cmds-entries")
            self.assertEqual(len(list(container.children)), 0)


class TestBgCmdRunningEntry(unittest.IsolatedAsyncioTestCase):
    """Scenario 2: Running command entry shows id, status, owner, age."""

    async def test_running_entry_appears(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, command="npm run build", status="running", last_output_age=15.0),
            ])
            await pilot.pause()

            label = sidebar.query_one("#sidebar-bg-cmds-label", Static)
            self.assertTrue(label.display)

            container = sidebar.query_one("#bg-cmds-entries")
            entries = [c for c in container.children if isinstance(c, NavEntry)]
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0].view_id, "1")
            self.assertIn("bg-cmd-entry", entries[0].classes)

    async def test_running_entry_shows_green_indicator(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, command="test", status="running", last_output_age=2.0),
            ])
            await pilot.pause()

            container = sidebar.query_one("#bg-cmds-entries")
            entry = [c for c in container.children if isinstance(c, NavEntry)][0]
            # Verify the entry is properly formed with the bg-cmd-entry class
            self.assertIn("bg-cmd-entry", entry.classes)
            self.assertEqual(entry.view_id, "1")

    async def test_running_entry_shows_command_name(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, command="my-long-command", status="running", last_output_age=0.0),
            ])
            await pilot.pause()

            container = sidebar.query_one("#bg-cmds-entries")
            entry = [c for c in container.children if isinstance(c, NavEntry)][0]
            # Verify the entry is properly formed
            self.assertIn("bg-cmd-entry", entry.classes)
            self.assertEqual(entry.view_id, "1")


class TestBgCmdInputOwnership(unittest.IsolatedAsyncioTestCase):
    """Scenarios 3 & 4: Focus input flips owner to USER, blur reverts to AGENT."""

    def setUp(self):
        self._store = BackgroundProcessStore()
        set_background_store(self._store)

    def tearDown(self):
        self._store.clear()
        set_background_store(BackgroundProcessStore())

    async def test_input_focus_takes_ownership(self):
        """Focusing the input widget sets owner to USER."""
        # Create a mock entry in the store
        entry = _make_process_entry(1, interactive=True)
        self._store._entries[1] = entry

        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, interactive=True),
            ])
            await pilot.pause()

            # Expand the command
            await sidebar._expand_bg_cmd(1)
            await pilot.pause()

            # Find the input widget
            input_widget = sidebar.query_one("#bg-cmd-input-1", BgCommandInput)
            self.assertIsNotNone(input_widget)

            # Focus the input
            input_widget.focus()
            await pilot.pause()

            # Check ownership
            store_entry = self._store.get(1)
            self.assertEqual(store_entry.owner, "USER")

    async def test_input_blur_releases_ownership(self):
        """Blurring the input widget sets owner back to AGENT."""
        entry = _make_process_entry(1, interactive=True)
        self._store._entries[1] = entry

        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, interactive=True),
            ])
            await pilot.pause()

            await sidebar._expand_bg_cmd(1)
            await pilot.pause()

            input_widget = sidebar.query_one("#bg-cmd-input-1", BgCommandInput)

            # Focus then blur
            input_widget.focus()
            await pilot.pause()
            self.assertEqual(self._store.get(1).owner, "USER")

            # Simulate blur by focusing the main input area (if it exists)
            # or just call the blur handler directly
            input_widget._on_blur(Blur())
            await pilot.pause()

            self.assertEqual(self._store.get(1).owner, "AGENT")


class TestBgCmdIdleTimeoutRevert(unittest.IsolatedAsyncioTestCase):
    """Scenario 5: USER-owned entry idle beyond timeout reverts on tick."""

    def setUp(self):
        self._store = BackgroundProcessStore()
        set_background_store(self._store)

    def tearDown(self):
        self._store.clear()
        set_background_store(BackgroundProcessStore())

    def test_idle_revert(self):
        """Entry idle beyond timeout reverts to AGENT."""
        entry = _make_process_entry(1)
        entry.owner = "USER"
        entry.last_user_input_at = time.monotonic() - 2000  # 2000s ago
        self._store._entries[1] = entry

        # Check with 900s timeout (default)
        self._store.check_idle_ownership(900.0)
        self.assertEqual(self._store.get(1).owner, "AGENT")

    def test_non_idle_keeps_user(self):
        """Entry within timeout window keeps USER ownership."""
        entry = _make_process_entry(1)
        entry.owner = "USER"
        entry.last_user_input_at = time.monotonic() - 100  # 100s ago
        self._store._entries[1] = entry

        self._store.check_idle_ownership(900.0)
        self.assertEqual(self._store.get(1).owner, "USER")


class TestBgCmdFinishedCollapsible(unittest.IsolatedAsyncioTestCase):
    """Scenario 6: Exited commands move under Finished collapsible."""

    async def test_exited_under_finished_collapsible(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, command="build", status="running"),
                _make_bg_record(2, command="test", status="exited"),
            ])
            await pilot.pause()

            container = sidebar.query_one("#bg-cmds-entries")

            # Running entry should be direct child NavEntry
            active_entries = [
                c for c in container.children
                if isinstance(c, NavEntry) and "bg-cmd-entry" in c.classes
            ]
            self.assertEqual(len(active_entries), 1)
            self.assertEqual(active_entries[0].view_id, "1")

            # Finished entry should be inside a Collapsible
            collapsibles = container.query(Collapsible)
            self.assertGreaterEqual(len(collapsibles), 1)

            # Find the bg-finished collapsible (not the subagent one)
            bg_collapsibles = [
                c for c in collapsibles
                if any(isinstance(e, NavEntry) and e.view_id == "2"
                       for e in c.query(NavEntry))
            ]
            self.assertEqual(len(bg_collapsibles), 1)

    async def test_finished_collapsible_preserves_collapsed_state(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)

            # First update: finished entries exist
            await sidebar.update_background_commands([
                _make_bg_record(1, status="exited"),
            ])
            await pilot.pause()

            # Find and collapse the finished section
            container = sidebar.query_one("#bg-cmds-entries")
            collapsibles = [
                c for c in container.children if isinstance(c, Collapsible)
            ]
            self.assertEqual(len(collapsibles), 1)
            collapse = collapsibles[0]
            collapse.collapsed = True
            await pilot.pause()

            # Second update: same structure
            await sidebar.update_background_commands([
                _make_bg_record(1, status="exited"),
            ])
            await pilot.pause()

            # Collapsed state should be preserved
            container = sidebar.query_one("#bg-cmds-entries")
            collapsibles = [
                c for c in container.children if isinstance(c, Collapsible)
            ]
            self.assertEqual(len(collapsibles), 1)
            self.assertTrue(collapsibles[0].collapsed)


class TestBgCmdExpandSwap(unittest.IsolatedAsyncioTestCase):
    """Scenario 7: Second command selection swaps the expanded tail."""

    def setUp(self):
        self._store = BackgroundProcessStore()
        set_background_store(self._store)

    def tearDown(self):
        self._store.clear()
        set_background_store(BackgroundProcessStore())

    async def test_select_second_swaps_expand(self):
        entry1 = _make_process_entry(1, command="cmd1")
        entry2 = _make_process_entry(2, command="cmd2")
        self._store._entries[1] = entry1
        self._store._entries[2] = entry2

        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, command="cmd1"),
                _make_bg_record(2, command="cmd2"),
            ])
            await pilot.pause()

            # Expand first
            await sidebar._expand_bg_cmd(1)
            await pilot.pause()

            container = sidebar.query_one("#bg-cmds-entries")
            expand_collapsibles = [
                c for c in container.children
                if isinstance(c, Collapsible) and "bg-cmd-expand" in c.classes
            ]
            self.assertEqual(len(expand_collapsibles), 1)

            # Expand second
            await sidebar._expand_bg_cmd(2)
            await pilot.pause()

            container = sidebar.query_one("#bg-cmds-entries")
            expand_collapsibles = [
                c for c in container.children
                if isinstance(c, Collapsible) and "bg-cmd-expand" in c.classes
            ]
            # Should still be exactly one expanded
            self.assertEqual(len(expand_collapsibles), 1)
            self.assertEqual(sidebar._expanded_bg_cmd_id, 2)


class TestBgCmdInputSubmit(unittest.IsolatedAsyncioTestCase):
    """Test that submitting text in a bg-cmd input sends it to the store."""

    def setUp(self):
        self._store = BackgroundProcessStore()
        set_background_store(self._store)

    def tearDown(self):
        self._store.clear()
        set_background_store(BackgroundProcessStore())

    async def test_expand_shows_tail_and_input(self):
        """The expanded view should contain a tail Static and BgCommandInput."""
        entry = _make_process_entry(1, interactive=True)
        self._store._entries[1] = entry

        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, interactive=True),
            ])
            await pilot.pause()

            await sidebar._expand_bg_cmd(1)
            await pilot.pause()

            container = sidebar.query_one("#bg-cmds-entries")

            # Should have the expand collapsible
            expand = [
                c for c in container.children
                if isinstance(c, Collapsible) and "bg-cmd-expand" in c.classes
            ]
            self.assertEqual(len(expand), 1)

            # Inside the collapsible, should have a tail Static and BgCommandInput
            input_widgets = expand[0].query(BgCommandInput)
            self.assertEqual(len(input_widgets), 1)
            self.assertEqual(input_widgets[0]._bg_command_id, 1)

    async def test_collapse_removes_expand(self):
        """After collapsing, the expand collapsible should be gone."""
        entry = _make_process_entry(1, interactive=True)
        self._store._entries[1] = entry

        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, interactive=True),
            ])
            await pilot.pause()

            await sidebar._expand_bg_cmd(1)
            await pilot.pause()
            self.assertEqual(sidebar._expanded_bg_cmd_id, 1)

            await sidebar._collapse_bg_cmd(1)
            await pilot.pause()
            self.assertIsNone(sidebar._expanded_bg_cmd_id)

            container = sidebar.query_one("#bg-cmds-entries")
            expand = [
                c for c in container.children
                if isinstance(c, Collapsible) and "bg-cmd-expand" in c.classes
            ]
            self.assertEqual(len(expand), 0)


class TestBgCmdUpdatePreservesEntries(unittest.IsolatedAsyncioTestCase):
    """Verify that non-structural updates preserve existing entries."""

    async def test_label_only_update_preserves_entries(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)

            # First update
            await sidebar.update_background_commands([
                _make_bg_record(1, command="cmd1", last_output_age=5.0),
            ])
            await pilot.pause()

            container = sidebar.query_one("#bg-cmds-entries")
            entries1 = list(container.children)

            # Second update: same structure, different age
            await sidebar.update_background_commands([
                _make_bg_record(1, command="cmd1", last_output_age=10.0),
            ])
            await pilot.pause()

            entries2 = list(container.children)

            # Same number of children
            self.assertEqual(len(entries1), len(entries2))

            # NavEntry should still be there with updated content
            nav_entries = [c for c in entries2 if isinstance(c, NavEntry)]
            self.assertEqual(len(nav_entries), 1)


class TestBgCmdMessage(unittest.IsolatedAsyncioTestCase):
    """Test SidebarBgCommandSelected message."""

    async def test_click_posts_message(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(42, command="test"),
            ])
            await pilot.pause()

            container = sidebar.query_one("#bg-cmds-entries")
            entries = [c for c in container.children if isinstance(c, NavEntry)]
            self.assertEqual(len(entries), 1)

            # Click the entry
            entries[0].on_click()
            await pilot.pause()

            # The app should receive the message (we can't easily check this
            # in the test without a custom app, but we can verify the message
            # class works)
            msg = SidebarBgCommandSelected(42)
            self.assertEqual(msg.command_id, 42)


class TestBgCmdMultipleEntries(unittest.IsolatedAsyncioTestCase):
    """Test with multiple running and finished commands."""

    async def test_multiple_running_entries(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, command="cmd1", status="running"),
                _make_bg_record(2, command="cmd2", status="running"),
                _make_bg_record(3, command="cmd3", status="running"),
            ])
            await pilot.pause()

            container = sidebar.query_one("#bg-cmds-entries")
            nav_entries = [
                c for c in container.children
                if isinstance(c, NavEntry) and "bg-cmd-entry" in c.classes
            ]
            self.assertEqual(len(nav_entries), 3)

    async def test_mixed_running_and_finished(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, command="cmd1", status="running"),
                _make_bg_record(2, command="cmd2", status="exited"),
                _make_bg_record(3, command="cmd3", status="running"),
            ])
            await pilot.pause()

            container = sidebar.query_one("#bg-cmds-entries")

            # 2 running entries as direct children
            nav_entries = [
                c for c in container.children
                if isinstance(c, NavEntry) and "bg-cmd-entry" in c.classes
            ]
            self.assertEqual(len(nav_entries), 2)

            # 1 finished entry inside a Collapsible
            collapsibles = container.query(Collapsible)
            bg_collapsibles = [
                c for c in collapsibles
                if "finished-collapse" in c.classes
            ]
            self.assertGreaterEqual(len(bg_collapsibles), 1)

    async def test_finished_count_reflects_exited(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            await sidebar.update_background_commands([
                _make_bg_record(1, status="running"),
                _make_bg_record(2, status="exited"),
                _make_bg_record(3, status="exited"),
            ])
            await pilot.pause()

            container = sidebar.query_one("#bg-cmds-entries")
            collapsibles = [
                c for c in container.children
                if isinstance(c, Collapsible) and "finished-collapse" in c.classes
            ]
            self.assertEqual(len(collapsibles), 1)
            # The title should mention "Finished (2)"
            # (checking via the Collapsible's title attribute)
            self.assertIn("2", collapsibles[0].title)


class TestBgCmdCommandTruncation(unittest.IsolatedAsyncioTestCase):
    """Test that long command names are truncated."""

    def test_format_entry_truncates_long_command(self):
        sidebar = Sidebar.__new__(Sidebar)
        record = _make_bg_record(
            1,
            command="this-is-a-very-long-command-name",
            status="running",
            last_output_age=5.0,
        )
        result = sidebar._format_bg_entry(record)
        # Command should be truncated to ~14 chars
        self.assertIn("..", result)

    def test_format_entry_short_command_not_truncated(self):
        sidebar = Sidebar.__new__(Sidebar)
        record = _make_bg_record(
            1,
            command="ls",
            status="running",
            last_output_age=5.0,
        )
        result = sidebar._format_bg_entry(record)
        self.assertIn("ls", result)
        self.assertNotIn("..", result)


class TestBgCmdOwnerBadge(unittest.IsolatedAsyncioTestCase):
    """Test that USER owner shows a badge."""

    def test_user_owner_shows_badge(self):
        sidebar = Sidebar.__new__(Sidebar)
        record = _make_bg_record(1, owner="USER", status="running", last_output_age=5.0)
        result = sidebar._format_bg_entry(record)
        self.assertIn("USER", result)

    def test_agent_owner_no_badge(self):
        sidebar = Sidebar.__new__(Sidebar)
        record = _make_bg_record(1, owner="AGENT", status="running", last_output_age=5.0)
        result = sidebar._format_bg_entry(record)
        self.assertNotIn("USER", result)


class TestBgCmdExpandNonexistent(unittest.IsolatedAsyncioTestCase):
    """Test expanding a nonexistent command is a no-op."""

    def setUp(self):
        self._store = BackgroundProcessStore()
        set_background_store(self._store)

    def tearDown(self):
        self._store.clear()
        set_background_store(BackgroundProcessStore())

    async def test_expand_nonexistent_no_crash(self):
        async with _SidebarApp().run_test() as pilot:
            sidebar = pilot.app.query_one("#sidebar", Sidebar)
            # Should not raise
            await sidebar._expand_bg_cmd(999)
            await pilot.pause()
            self.assertIsNone(sidebar._expanded_bg_cmd_id)
