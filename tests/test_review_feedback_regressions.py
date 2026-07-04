from __future__ import annotations

import json
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from textual.app import App, ComposeResult

from orchid.app import Orchid
from orchid.domain.message import Message, MessageRole, MessageType
from orchid.storage import _extract_json_string, list_saved_sessions
from orchid.tools.background_store import (
    BackgroundProcessStore,
    HeadTailBuffer,
    ProcessEntry,
    set_background_store,
)
from orchid.tools.exec import execute_command
from orchid.widgets.live_command import _MAX_PARTIAL_LINE_CHARS, LiveCommandOutputWidget
from orchid.widgets.message_widget import (
    create_message_widget,
    live_command_widgets,
    remove_live_command_widgets_for_messages,
)
from orchid.widgets.sidebar import BgCommandInput, Sidebar


class _SidebarApp(App):
    def compose(self) -> ComposeResult:
        yield Sidebar(id="sidebar")


def _make_live_widget(max_lines: int = 50) -> LiveCommandOutputWidget:
    widget = LiveCommandOutputWidget.__new__(LiveCommandOutputWidget)
    widget.command_id = 1
    widget.command_text = "cmd"
    widget.description = "cmd"
    widget._max_lines = max_lines
    widget._lines = []
    widget._finished = False
    widget._exit_code = None
    widget._last_render_time = 0.0
    widget._flush_scheduled = False
    widget._content_widget = None
    widget._collapsible = None
    return widget


def _make_process_entry(cmd_id: int, *, interactive: bool = True) -> ProcessEntry:
    proc = MagicMock()
    proc.returncode = None
    proc.pid = cmd_id
    return ProcessEntry(
        id=cmd_id,
        command="cat",
        process=proc,
        buffer=HeadTailBuffer(),
        interactive=interactive,
    )


def _make_bg_record(cmd_id: int, *, interactive: bool = True) -> dict:
    return {
        "id": cmd_id,
        "command": "cat",
        "description": "cat",
        "owner": "AGENT",
        "status": "running",
        "last_output_age": 0.1,
        "interactive": interactive,
        "has_tail": True,
    }


def test_extract_json_string_decodes_escaped_quotes() -> None:
    text = r'{"id": "abc", "name": "say \"hello\"", "model": "x"}'
    assert _extract_json_string(text, '"name"') == 'say "hello"'


def test_list_saved_sessions_reports_exact_chain_count(tmp_path, monkeypatch) -> None:
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    monkeypatch.setattr("orchid.storage.SESSIONS_DIR", sessions_dir)
    data = {
        "id": "session-1",
        "name": "example",
        "model": "model",
        "chains": [{"messages": []}, {"messages": []}, {"messages": []}],
    }
    (sessions_dir / "session-1.json").write_text(json.dumps(data))

    [session] = list_saved_sessions()
    assert session["chain_count"] == 3


def test_list_saved_sessions_sorts_by_file_recency(tmp_path, monkeypatch) -> None:
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    monkeypatch.setattr("orchid.storage.SESSIONS_DIR", sessions_dir)

    old_path = sessions_dir / "old.json"
    new_path = sessions_dir / "new.json"
    old_path.write_text(json.dumps({"id": "old", "name": "old", "chains": []}))
    new_path.write_text(json.dumps({"id": "new", "name": "new", "chains": []}))
    os.utime(old_path, (1_000, 1_000))
    os.utime(new_path, (2_000, 2_000))

    assert [session["id"] for session in list_saved_sessions()] == ["new", "old"]


def test_live_command_public_buffer_api_and_partial_line_cap() -> None:
    widget = _make_live_widget()
    widget._append_delta("prefix")
    widget._append_delta("x" * (_MAX_PARTIAL_LINE_CHARS + 20))

    buffered = widget.get_buffered_text()
    assert len(buffered) == _MAX_PARTIAL_LINE_CHARS
    assert buffered.endswith("x" * 20)

    widget.reset_buffer()
    assert widget.get_buffered_text() == ""


def test_loaded_background_command_restores_live_widget() -> None:
    live_command_widgets.clear()
    store = BackgroundProcessStore()
    store._entries[7] = _make_process_entry(7)
    set_background_store(store)
    msg = Message(
        role=MessageRole.TOOL,
        content='<background_command id="7" command="cat" description="cat" status="started" />',
        type=MessageType.TOOL_RESULT,
    )

    widget = create_message_widget(msg, loaded=True)

    assert isinstance(widget, LiveCommandOutputWidget)
    assert live_command_widgets[7] is widget
    live_command_widgets.clear()
    set_background_store(BackgroundProcessStore())


def test_manage_bg_cmd_timer_stops_empty_store_with_pending_sidebar() -> None:
    store = BackgroundProcessStore()
    set_background_store(store)
    app = Orchid.__new__(Orchid)
    app._bg_cmd_sidebar_pending = True
    timer = MagicMock()
    app._bg_cmd_timer = timer

    app._manage_bg_cmd_timer()

    timer.stop.assert_called_once()
    assert app._bg_cmd_timer is None
    assert app._bg_cmd_sidebar_pending is False
    set_background_store(BackgroundProcessStore())


@pytest.mark.asyncio
async def test_execute_command_foreground_display_uses_description() -> None:
    result = await execute_command("echo hello", description="Say hello", timeout=5)

    assert result.display.startswith("$ Say hello ")
    assert 'command="echo hello"' in result.content
    assert 'description="Say hello"' in result.content


@pytest.mark.asyncio
async def test_execute_command_rejects_foreground_interactive() -> None:
    result = await execute_command(
        "cat",
        description="interactive cat",
        interactive=True,
        background=False,
    )

    assert result.display == "interactive=True requires background=True"
    assert "only supported with background=True" in result.content


def test_remove_live_command_widgets_keeps_unfinished_widgets() -> None:
    live_command_widgets.clear()
    live_command_widgets[42] = _make_live_widget()
    messages = [
        Message(
            role=MessageRole.TOOL,
            content='<background_command id="42" command="cat" description="cat" status="started" />',
        )
    ]

    remove_live_command_widgets_for_messages(messages)

    assert 42 in live_command_widgets
    live_command_widgets.clear()


def test_remove_live_command_widgets_removes_terminal_widgets() -> None:
    live_command_widgets.clear()
    widget = _make_live_widget()
    widget.finish(0)
    live_command_widgets[42] = widget
    messages = [
        Message(
            role=MessageRole.TOOL,
            content='<background_command id="42" command="cat" description="cat" status="started" />',
        )
    ]

    remove_live_command_widgets_for_messages(messages)

    assert 42 not in live_command_widgets


@pytest.mark.asyncio
async def test_bg_command_submit_preserves_input_when_send_fails() -> None:
    store = BackgroundProcessStore()
    store._entries[1] = _make_process_entry(1)
    store.send = AsyncMock(return_value=False)  # type: ignore[method-assign]
    set_background_store(store)

    async with _SidebarApp().run_test() as pilot:
        sidebar = pilot.app.query_one("#sidebar", Sidebar)
        await sidebar.update_background_commands([_make_bg_record(1)])
        await pilot.pause()
        await sidebar._expand_bg_cmd(1)
        await pilot.pause()

        input_widget = sidebar.query_one("#bg-cmd-input-1", BgCommandInput)
        input_widget.value = "retry me"
        await sidebar.on_input_submitted(SimpleNamespace(input=input_widget))
        assert input_widget.value == "retry me"

    set_background_store(BackgroundProcessStore())


@pytest.mark.asyncio
async def test_bg_command_refresh_restores_focused_input_value() -> None:
    store = BackgroundProcessStore()
    store._entries[1] = _make_process_entry(1)
    set_background_store(store)

    async with _SidebarApp().run_test() as pilot:
        sidebar = pilot.app.query_one("#sidebar", Sidebar)
        await sidebar.update_background_commands([_make_bg_record(1)])
        await pilot.pause()
        await sidebar._expand_bg_cmd(1)
        await pilot.pause()

        input_widget = sidebar.query_one("#bg-cmd-input-1", BgCommandInput)
        input_widget.value = "draft stdin"
        input_widget.focus()
        await pilot.pause()

        await sidebar.update_background_commands([
            _make_bg_record(1),
            _make_bg_record(2),
        ])
        await pilot.pause()

        restored = sidebar.query_one("#bg-cmd-input-1", BgCommandInput)
        assert restored.value == "draft stdin"
        assert pilot.app.focused is restored

    set_background_store(BackgroundProcessStore())
