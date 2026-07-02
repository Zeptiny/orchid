"""Tests for background I/O tools: execute_command background, read_output, send_input (U3)."""

from __future__ import annotations

import asyncio

import pytest

from orchid.llm.client import _TOOLS_WITHOUT_TIMEOUT
from orchid.tools import get_tool_registry
from orchid.tools.background_io import (
    execute_read_output,
    execute_send_input,
    read_output_tool,
    send_input_tool,
)
from orchid.tools.background_store import (
    BackgroundProcessStore,
    get_background_store,
    set_background_store,
)
from orchid.tools.exec import execute_command

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fresh_store():
    """Return a fresh BackgroundProcessStore and install it on the ContextVar."""
    prior = get_background_store()
    store = BackgroundProcessStore()
    set_background_store(store)
    yield store
    store.clear()
    set_background_store(prior)


# ---------------------------------------------------------------------------
# Scenario 1: execute_command(background=True) returns immediately with int id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_execute_command_background_returns_immediately(fresh_store):
    """background=True returns immediately with an int id in content."""
    result = await execute_command(
        "sleep 60", description="sleep bg", background=True, working_directory="."
    )
    assert "Started background command" in result.display
    assert '<background_command' in result.content
    assert 'status="started"' in result.content

    # Extract the id from content
    import re
    m = re.search(r'id="(\d+)"', result.content)
    assert m is not None
    proc_id = int(m.group(1))

    # Process should be alive in store
    entry = fresh_store.get(proc_id)
    assert entry is not None
    assert entry.exit_code is None

    # Clean up
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# Scenario 2: execute_command(background=False) is unchanged (regression)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_execute_command_foreground_unchanged(fresh_store):
    """background=False (default) still works as before."""
    result = await execute_command("echo hello-foreground", description="echo fg")
    assert "hello-foreground" in result.content
    assert "<command_result" in result.content
    assert 'exit_code="0"' in result.content
    assert "exit code: 0" in result.display


# ---------------------------------------------------------------------------
# Scenario 3: read_output(id) snapshot returns current tail
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_output_snapshot(fresh_store):
    """read_output(id) returns current tail text."""
    proc_id, _ = await fresh_store.spawn("echo hello-read-output")
    await asyncio.sleep(0.5)

    result = await execute_read_output(id=proc_id)
    assert "<command_output" in result.content
    assert "hello-read-output" in result.content
    assert 'exit_code="0"' in result.content
    assert "exited" in result.display


# ---------------------------------------------------------------------------
# Scenario 4: read_output(id, last_n=5) returns ~5 lines
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_output_last_n_lines(fresh_store):
    """read_output(id, last_n=5) returns approximately 5 lines."""
    lines_cmd = "for i in $(seq 1 20); do echo line-$i; done"
    proc_id, _ = await fresh_store.spawn(lines_cmd)
    await asyncio.sleep(0.5)

    result = await execute_read_output(id=proc_id, last_n=5)
    assert "<command_output" in result.content
    # Should contain the last lines
    assert "line-20" in result.content


# ---------------------------------------------------------------------------
# Scenario 5: read_output(wait_ms=2000) on fast command returns exit_code early
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_output_wait_ms_returns_early_on_exit(fresh_store):
    """wait_ms=2000 on a command that finishes in ~0.5s returns early."""
    proc_id, _ = await fresh_store.spawn(
        "sh -c 'sleep 0.5 && echo done-fast'"
    )
    # Do NOT sleep — immediately long-poll
    import time
    t0 = time.monotonic()
    result = await execute_read_output(id=proc_id, wait_ms=2000)
    elapsed = time.monotonic() - t0

    assert "<command_output" in result.content
    assert "done-fast" in result.content
    assert 'exit_code="0"' in result.content
    # Should return well before 2s since command finishes in ~0.5s
    assert elapsed < 3.0


# ---------------------------------------------------------------------------
# Scenario 6: read_output(wait_ms=2000) on blocked command returns at deadline
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_output_wait_ms_timeout_on_blocked(fresh_store):
    """wait_ms=1000 on a blocking command returns at ~1s deadline."""
    proc_id, _ = await fresh_store.spawn("sleep 60")

    import time
    t0 = time.monotonic()
    result = await execute_read_output(id=proc_id, wait_ms=1000)
    elapsed = time.monotonic() - t0

    assert "<command_output" in result.content
    # Should return at roughly the wait_ms deadline
    assert 0.8 < elapsed < 3.0

    # Clean up
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# Scenario 7: send_input on non-interactive command returns R5 error
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_input_non_interactive_returns_error(fresh_store):
    """send_input on a non-interactive command returns an R5 error."""
    proc_id, _ = await fresh_store.spawn("sleep 60")
    await asyncio.sleep(0.2)

    result = await execute_send_input(id=proc_id, text="hello\n")
    assert "not interactive" in result.display.lower()
    assert "interactive=true" in result.content

    # Clean up
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# Scenario 8: send_input on USER-owned command returns rejection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_input_user_owned_rejection(fresh_store):
    """send_input on a USER-owned command returns rejection."""
    proc_id, _ = await fresh_store.spawn("cat", interactive=True)
    await asyncio.sleep(0.2)

    # Manually set owner to USER
    entry = fresh_store.get(proc_id)
    entry.owner = "USER"

    result = await execute_send_input(id=proc_id, text="hello\n")
    assert "user" in result.display.lower()
    assert "USER" in result.content
    assert "control: USER" in result.content

    # Clean up
    entry.owner = "AGENT"  # reset for cleanup
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# Scenario 9: send_input on interactive command writes and buffer reflects it
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_input_interactive_writes_and_buffer_shows(fresh_store):
    """send_input on interactive command writes to stdin, buffer shows result."""
    proc_id, _ = await fresh_store.spawn("cat", interactive=True)
    await asyncio.sleep(0.3)

    result = await execute_send_input(id=proc_id, text="hello-interactive\n")
    assert "Sent input" in result.display
    assert "<input_sent" in result.content

    await asyncio.sleep(0.3)
    text, exit_code = fresh_store.snapshot(proc_id)
    assert "hello-interactive" in text

    # Clean up
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# Scenario 10: read_output in _TOOLS_WITHOUT_TIMEOUT (timeout exemption)
# ---------------------------------------------------------------------------


def test_read_output_in_tools_without_timeout():
    """read_output is in _TOOLS_WITHOUT_TIMEOUT set (timeout exemption)."""
    assert "read_output" in _TOOLS_WITHOUT_TIMEOUT


# ---------------------------------------------------------------------------
# Registration checks
# ---------------------------------------------------------------------------


def test_read_output_and_send_input_registered():
    """Both read_output and send_input appear in the tool registry."""
    registry = get_tool_registry()
    assert "read_output" in registry
    assert "send_input" in registry
    assert registry["read_output"]["tool"] is read_output_tool
    assert registry["send_input"]["tool"] is send_input_tool


def test_three_tools_present():
    """execute_command, read_output, and send_input are all registered."""
    registry = get_tool_registry()
    assert "execute_command" in registry
    assert "read_output" in registry
    assert "send_input" in registry


# ---------------------------------------------------------------------------
# read_output on missing id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_output_missing_id(fresh_store):
    """read_output on unknown id returns error."""
    result = await execute_read_output(id=99999)
    assert "not found" in result.display.lower()
    assert "<error" in result.content


# ---------------------------------------------------------------------------
# send_input on missing id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_input_missing_id(fresh_store):
    """send_input on unknown id returns error."""
    result = await execute_send_input(id=99999, text="hello\n")
    assert "not found" in result.display.lower()
    assert "<error" in result.content


# ---------------------------------------------------------------------------
# send_input on already-exited command
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_input_already_exited(fresh_store):
    """send_input on an exited interactive command returns error."""
    proc_id, _ = await fresh_store.spawn("echo done", interactive=True)
    await asyncio.sleep(0.5)

    result = await execute_send_input(id=proc_id, text="hello\n")
    # Command should have exited quickly
    entry = fresh_store.get(proc_id)
    assert entry is not None
    assert entry.exit_code is not None
    assert "exited" in result.display.lower()


# ---------------------------------------------------------------------------
# Tool definition shapes
# ---------------------------------------------------------------------------


def test_read_output_tool_shape():
    """read_output tool has expected parameter schema."""
    d = read_output_tool.to_dict()
    assert d["function"]["name"] == "read_output"
    params = d["function"]["parameters"]["properties"]
    assert "id" in params
    assert params["id"]["type"] == "integer"
    assert "last_n" in params
    assert "wait_ms" in params
    assert set(d["function"]["parameters"]["required"]) == {"id"}


def test_send_input_tool_shape():
    """send_input tool has expected parameter schema."""
    d = send_input_tool.to_dict()
    assert d["function"]["name"] == "send_input"
    params = d["function"]["parameters"]["properties"]
    assert "id" in params
    assert "text" in params
    assert set(d["function"]["parameters"]["required"]) == {"id", "text"}
