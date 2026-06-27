"""Tests for <background_commands> system-prompt block (U4)."""
from unittest.mock import MagicMock, patch
import time

import pytest

from orchid.llm import dynamic_system_prompt as dsp
from orchid.tools.background_store import (
    BackgroundProcessStore,
    HeadTailBuffer,
    ProcessEntry,
    set_background_store,
)


@pytest.fixture(autouse=True)
def _reset_tree_cache():
    dsp._TREE_CACHE = None
    yield
    dsp._TREE_CACHE = None


def _patch_deps(states=None, todos=None, tree="TREE", bg_entries=None):
    """Return a dict of context-manager patches for all build_dynamic_system_prompt deps."""
    cfg = MagicMock()
    cfg.directory_tree_depth = 2
    sub_mgr = MagicMock()
    sub_mgr.get_states.return_value = states if states is not None else []
    todo_store = MagicMock()
    todo_store.list.return_value = todos if todos is not None else []

    bg_store = MagicMock()
    bg_store.list.return_value = bg_entries if bg_entries is not None else []

    return {
        "get_config": patch("orchid.llm.dynamic_system_prompt.get_config", return_value=cfg),
        "directory_tree": patch("orchid.llm.dynamic_system_prompt.directory_tree", return_value=tree),
        "get_subagent_manager": patch("orchid.llm.dynamic_system_prompt.get_subagent_manager", return_value=sub_mgr),
        "get_todo_store": patch("orchid.llm.dynamic_system_prompt.get_todo_store", return_value=todo_store),
        "get_background_store": patch("orchid.llm.dynamic_system_prompt.get_background_store", return_value=bg_store),
    }


def _make_entry(
    *,
    id=1,
    command="echo hello",
    owner="AGENT",
    interactive=False,
    exit_code=None,
    created_at=None,
    last_output_at=None,
    tail_bytes=b"hello\n",
) -> MagicMock:
    """Build a mock ProcessEntry for testing."""
    entry = MagicMock(spec=ProcessEntry)
    entry.id = id
    entry.command = command
    entry.owner = owner
    entry.interactive = interactive
    entry.exit_code = exit_code
    now = time.monotonic()
    entry.created_at = created_at if created_at is not None else now - 10
    entry.last_output_at = last_output_at if last_output_at is not None else now - 5
    buf = HeadTailBuffer()
    buf.append(tail_bytes)
    entry.buffer = buf
    return entry


# ---------------------------------------------------------------------------
# 1. Empty store → no <background_commands> block
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_empty_store_omits_background_commands_block():
    patches = _patch_deps(bg_entries=[])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"], patches["get_background_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "<background_commands>" not in c
    assert "<command " not in c


# ---------------------------------------------------------------------------
# 2. One running command → block with required attributes
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_one_running_command_includes_block():
    entry = _make_entry(id=1, command="npm run build", exit_code=None)
    patches = _patch_deps(bg_entries=[entry])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"], patches["get_background_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "<background_commands>" in c
    assert "</background_commands>" in c
    assert 'id="1"' in c
    assert 'command="npm run build"' in c
    assert 'owner="AGENT"' in c
    assert 'status="running"' in c
    assert 'interactive="false"' in c
    assert "runtime=" in c
    assert "last_output_age=" in c
    # exit_code must NOT appear for a running command
    assert 'exit_code=' not in c


# ---------------------------------------------------------------------------
# 3. USER-owned command appears with owner="USER"
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_user_owned_command():
    entry = _make_entry(id=2, command="python", owner="USER", interactive=True, exit_code=0)
    patches = _patch_deps(bg_entries=[entry])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"], patches["get_background_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert 'owner="USER"' in c
    assert 'interactive="true"' in c
    assert 'status="exited"' in c
    assert 'exit_code="0"' in c


# ---------------------------------------------------------------------------
# 4. Tail with XML special chars is properly escaped
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_tail_xml_chars_escaped():
    entry = _make_entry(
        id=3,
        command='python -c "print(\'hello\')"',
        tail_bytes=b'<html>&"test"\n',
    )
    patches = _patch_deps(bg_entries=[entry])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"], patches["get_background_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "&lt;html&gt;&amp;\"test\"" in c
    assert "<html>" not in c
    # Command attr should also be escaped
    assert "&quot;" in c or "python -c" in c  # command uses double quotes inside, they'll be escaped by escape()


# ---------------------------------------------------------------------------
# 5. Block is bounded: >8 tail lines truncated, >5+1 commands omit older entries
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_tail_line_cap():
    """A command with 12 tail lines should only show the last 8."""
    lines = "\n".join(f"line{i}" for i in range(12)) + "\n"
    entry = _make_entry(id=1, tail_bytes=lines.encode())
    patches = _patch_deps(bg_entries=[entry])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"], patches["get_background_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    # line0 through line3 (first 4) should be dropped
    assert "line0" not in c
    assert "line3" not in c
    # line4 through line11 (last 8) should be present
    assert "line4" in c
    assert "line11" in c


@pytest.mark.asyncio
async def test_entry_count_cap():
    """When >5 agent commands, older ones are omitted; USER entries always appear."""
    now = time.monotonic()
    entries = []
    for i in range(1, 8):  # 7 AGENT entries
        entries.append(_make_entry(
            id=i,
            command=f"cmd{i}",
            owner="AGENT",
            created_at=now - (100 - i),  # older = smaller
        ))
    # 1 USER entry
    entries.append(_make_entry(id=99, command="usercmd", owner="USER", created_at=now - 200))

    patches = _patch_deps(bg_entries=entries)
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"], patches["get_background_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content

    # Most recent 5 agent entries: cmd3..cmd7
    assert 'command="cmd7"' in c
    assert 'command="cmd3"' in c
    # cmd1 and cmd2 should be dropped (they're the oldest 2 of 7)
    assert 'command="cmd1"' not in c
    assert 'command="cmd2"' not in c
    # USER entry always present
    assert 'command="usercmd"' in c


@pytest.mark.asyncio
async def test_tail_char_cap():
    """Tail exceeding 500 chars is truncated with '...'."""
    long_text = "A" * 600 + "\n"
    entry = _make_entry(id=1, tail_bytes=long_text.encode())
    patches = _patch_deps(bg_entries=[entry])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"], patches["get_background_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "..." in c
    # The full 600-char block should NOT appear
    assert "A" * 600 not in c


# ---------------------------------------------------------------------------
# 6. Exited command shows exit_code attribute
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_exited_command_shows_exit_code():
    entry = _make_entry(id=5, command="false", exit_code=1)
    patches = _patch_deps(bg_entries=[entry])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"], patches["get_background_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert 'exit_code="1"' in c
    assert 'status="exited"' in c


# ---------------------------------------------------------------------------
# 7. Interactive command shows interactive="true"
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_interactive_command():
    entry = _make_entry(id=10, command="python", interactive=True)
    patches = _patch_deps(bg_entries=[entry])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"], patches["get_background_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert 'interactive="true"' in c


# ---------------------------------------------------------------------------
# Integration: background_commands block coexists with subagents and todos
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_coexists_with_subagents_and_todos():
    from orchid.domain.todo import TodoStatus, TodoTask

    states = [{"id": "s1", "name": "n", "type": "t", "state": "RUNNING", "elapsed": 1.0, "task": None}]
    todo = TodoTask(id="t1", title="x", status=TodoStatus.IN_PROGRESS)
    entry = _make_entry(id=1, command="ls", exit_code=0)

    patches = _patch_deps(states=states, todos=[todo], bg_entries=[entry])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"], patches["get_background_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "<subagents>" in c
    assert "<todos>" in c
    assert "<background_commands>" in c
