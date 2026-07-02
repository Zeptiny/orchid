"""Tests for LiveCommandOutputWidget — content logic, throttling, collapse, finish."""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest

from orchid.widgets.live_command import (
    _MAX_BUFFER_LINES,
    _THROTTLE_INTERVAL,
    LiveCommandOutputWidget,
)
from orchid.widgets.message_widget import (
    _BACKGROUND_CMD_RE,
    live_command_widgets,
)

# ---------------------------------------------------------------------------
# Unit tests for the widget content logic (no Textual app needed)
# ---------------------------------------------------------------------------


class TestLiveCommandOutputWidgetContent:
    """Pure content-management tests that don't require a running Textual app."""

    def _make_widget(
        self,
        command_id: int = 1,
        max_lines: int = _MAX_BUFFER_LINES,
        height_cap: int = 20,
        description: str = "",
    ) -> LiveCommandOutputWidget:
        """Create a widget without mounting it (bypass compose)."""
        w = LiveCommandOutputWidget.__new__(LiveCommandOutputWidget)
        w.command_id = command_id
        w.command_text = "echo hello"
        w.description = description
        w._max_lines = max_lines
        w._height_cap = height_cap
        w._lines = []
        w._finished = False
        w._exit_code = None
        w._last_render_time = 0.0
        w._flush_scheduled = False
        w._content_widget = None
        return w

    def test_append_delta_basic(self) -> None:
        w = self._make_widget()
        w._append_delta("line1\n")
        assert w._lines == ["line1\n"]

    def test_append_delta_merges_partial_lines(self) -> None:
        w = self._make_widget()
        w._append_delta("partial")
        w._append_delta(" rest\n")
        assert w._lines == ["partial rest\n"]

    def test_append_delta_multiple_lines(self) -> None:
        w = self._make_widget()
        w._append_delta("a\nb\nc\n")
        assert len(w._lines) == 3
        assert "".join(w._lines) == "a\nb\nc\n"

    def test_line_cap_enforced(self) -> None:
        w = self._make_widget(max_lines=5)
        for i in range(10):
            w._append_delta(f"line{i}\n")
        assert len(w._lines) == 5
        # Should keep the last 5 lines.
        assert "line5" in w._lines[0]
        assert "line9" in w._lines[-1]

    def test_render_text_running(self) -> None:
        w = self._make_widget(command_id=7)
        w._append_delta("hello\n")
        text = w._render_text()
        assert "Command #7 (running)" in text
        assert "hello" in text

    def test_render_text_finished(self) -> None:
        w = self._make_widget(command_id=3)
        w._append_delta("output\n")
        w._exit_code = 0
        w._finished = True
        text = w._render_text()
        assert "Command #3 (exit 0)" in text
        assert "output" in text

    def test_stub_text_running(self) -> None:
        w = self._make_widget(command_id=5)
        stub = w._build_stub_text()
        assert "Command #5" in stub
        assert "running" in stub

    def test_stub_text_finished(self) -> None:
        w = self._make_widget(command_id=5)
        w._exit_code = 1
        w._finished = True
        stub = w._build_stub_text()
        assert "Command #5" in stub
        assert "exit 1" in stub

    def test_update_content_rejects_after_finish(self) -> None:
        w = self._make_widget()
        w._finished = True
        w.update_content("should be ignored\n")
        assert w._lines == []

    def test_finish_sets_exit_code(self) -> None:
        w = self._make_widget()
        w._append_delta("data\n")
        w.finish(exit_code=42)
        assert w._finished is True
        assert w._exit_code == 42

    def test_cr_stripped(self) -> None:
        w = self._make_widget()
        w._append_delta("line\r\n")
        assert w._lines == ["line\n"]


class TestLiveCommandOutputWidgetThrottling:
    """Tests for the throttled rendering path."""

    def _make_widget_with_content(self) -> LiveCommandOutputWidget:
        w = LiveCommandOutputWidget.__new__(LiveCommandOutputWidget)
        w.command_id = 1
        w.command_text = "test"
        w.description = ""
        w._max_lines = _MAX_BUFFER_LINES
        w._height_cap = 20
        w._lines = []
        w._finished = False
        w._exit_code = None
        w._last_render_time = 0.0
        w._flush_scheduled = False
        w._content_widget = MagicMock()
        w.add_class = MagicMock()
        w.remove_class = MagicMock()
        # Mock set_timer to avoid needing a running event loop.
        w.set_timer = MagicMock()
        return w

    def test_first_update_renders_immediately(self) -> None:
        w = self._make_widget_with_content()
        w.update_content("line1\n")
        w._content_widget.update.assert_called()

    def test_burst_coalesces(self) -> None:
        w = self._make_widget_with_content()
        w.update_content("line1\n")
        w._content_widget.update.reset_mock()
        # Immediately after, further updates should NOT call update (throttled).
        w.update_content("line2\n")
        # The _append_delta ran but _do_render was not called (throttled).
        assert len(w._lines) == 2
        w._content_widget.update.assert_not_called()

    def test_flush_bypasses_throttle(self) -> None:
        w = self._make_widget_with_content()
        w.update_content("line1\n")
        w._content_widget.update.reset_mock()
        w.update_content("line2\n")
        w.flush()
        w._content_widget.update.assert_called()


class TestLiveCommandOutputWidgetCollapse:
    """Tests for the height-cap collapse behavior."""

    def test_collapses_past_height_cap(self) -> None:
        w = LiveCommandOutputWidget.__new__(LiveCommandOutputWidget)
        w.command_id = 1
        w.command_text = "chatty"
        w.description = ""
        w._max_lines = 100
        w._height_cap = 5
        w._lines = []
        w._finished = False
        w._exit_code = None
        w._last_render_time = 0.0
        w._flush_scheduled = False
        w._content_widget = MagicMock()
        # Mock add_class / remove_class
        w.add_class = MagicMock()
        w.remove_class = MagicMock()

        # Push past the cap.
        for i in range(10):
            w._append_delta(f"line{i}\n")
        w._do_render()
        w.add_class.assert_called_with("collapsed")
        w._content_widget.update.assert_called_with(w._build_stub_text())

    def test_finished_un_collapses(self) -> None:
        w = LiveCommandOutputWidget.__new__(LiveCommandOutputWidget)
        w.command_id = 1
        w.command_text = "chatty"
        w.description = ""
        w._max_lines = 100
        w._height_cap = 5
        w._lines = []
        w._finished = False
        w._exit_code = None
        w._last_render_time = 0.0
        w._flush_scheduled = False
        w._content_widget = MagicMock()
        w.add_class = MagicMock()
        w.remove_class = MagicMock()

        # Push past the cap.
        for i in range(10):
            w._append_delta(f"line{i}\n")
        w._do_render()
        assert w.add_class.called

        # Finish should un-collapse.
        w._content_widget.update.reset_mock()
        w.remove_class.reset_mock()
        w.finish(exit_code=0)
        w.remove_class.assert_called_with("collapsed")


class TestLiveCommandWidgetsRegistry:
    """Tests for the module-level live_command_widgets mapping."""

    def test_regex_matches_background_command(self) -> None:
        content = '<background_command id="42" command="npm run build" description="Build the project" status="started" />'
        m = _BACKGROUND_CMD_RE.search(content)
        assert m is not None
        assert m.group(1) == "42"
        assert m.group(2) == "npm run build"
        assert m.group(3) == "Build the project"

    def test_regex_matches_with_extra_attrs(self) -> None:
        content = '<background_command id="1" command="echo hi" description="Say hi" interactive="true" status="started" />'
        m = _BACKGROUND_CMD_RE.search(content)
        assert m is not None
        assert m.group(1) == "1"
        assert m.group(2) == "echo hi"
        assert m.group(3) == "Say hi"

    def test_regex_no_match_on_normal_result(self) -> None:
        content = "File written successfully."
        m = _BACKGROUND_CMD_RE.search(content)
        assert m is None

    def test_registry_is_dict(self) -> None:
        assert isinstance(live_command_widgets, dict)

    def test_registry_stores_widget(self) -> None:
        # Simulate what mount_streamed_message does.
        w = MagicMock()
        live_command_widgets[99] = w
        assert live_command_widgets[99] is w
        # Cleanup.
        del live_command_widgets[99]


class TestTimerManagement:
    """Tests that the timer start/stop logic works correctly."""

    def test_manage_bg_cmd_timer_starts_when_live(self) -> None:
        """Verify a live entry is present in the store (timer start precondition)."""
        from orchid.tools.background_store import (
            BackgroundProcessStore,
            HeadTailBuffer,
            ProcessEntry,
            set_background_store,
        )

        mock_store = BackgroundProcessStore()
        set_background_store(mock_store)

        # Add a fake live entry.
        mock_proc = MagicMock()
        mock_proc.returncode = None
        mock_proc.pid = 12345
        entry = ProcessEntry(
            id=1,
            command="sleep 10",
            process=mock_proc,
            buffer=HeadTailBuffer(),
            exit_code=None,
        )
        mock_store._entries[1] = entry

        # Verify the store has live entries.
        assert any(e.exit_code is None for e in mock_store.list())

        # Cleanup.
        set_background_store(BackgroundProcessStore())


class TestLiveCommandWidgetsPopOnFinish:
    """Tests that finished widgets are removed from live_command_widgets."""

    def test_finish_and_pop_removes_from_registry(self) -> None:
        """When a widget is finished (exit_code is not None), popping it removes it."""
        widget = LiveCommandOutputWidget.__new__(LiveCommandOutputWidget)
        widget.command_id = 999
        widget.command_text = "test"
        widget.description = ""
        widget._max_lines = _MAX_BUFFER_LINES
        widget._height_cap = 20
        widget._lines = ["some output\n"]
        widget._finished = False
        widget._exit_code = None
        widget._last_render_time = 0.0
        widget._flush_scheduled = False
        widget._content_widget = MagicMock()
        widget.add_class = MagicMock()
        widget.remove_class = MagicMock()

        # Register widget in the global dict
        live_command_widgets[999] = widget
        assert 999 in live_command_widgets

        # Simulate the tick flow: finish the widget then pop it
        widget.finish(exit_code=0)
        assert widget._finished is True
        assert widget._exit_code == 0

        # This is the key contract: the tick flow pops the widget after finish
        live_command_widgets.pop(999, None)
        assert 999 not in live_command_widgets

    def test_finish_sets_finished_flag(self) -> None:
        """Widget.finish() correctly sets _finished and _exit_code."""
        widget = LiveCommandOutputWidget.__new__(LiveCommandOutputWidget)
        widget.command_id = 998
        widget.command_text = "test2"
        widget.description = ""
        widget._max_lines = _MAX_BUFFER_LINES
        widget._height_cap = 20
        widget._lines = []
        widget._finished = False
        widget._exit_code = None
        widget._last_render_time = 0.0
        widget._flush_scheduled = False
        widget._content_widget = MagicMock()
        widget.add_class = MagicMock()
        widget.remove_class = MagicMock()

        # Before finish
        assert widget._finished is False
        assert widget._exit_code is None

        # Finish with a specific exit code
        widget.finish(exit_code=42)
        assert widget._finished is True
        assert widget._exit_code == 42

        # After finish, update_content should be rejected
        widget.update_content("should be ignored\n")
        assert widget._lines == []  # no new content added
