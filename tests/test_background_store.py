"""Tests for BackgroundProcessStore: lifecycle, buffer, LRU, termination (U1)."""

from __future__ import annotations

import asyncio

import pytest

from orchid.tools.background_store import (
    _MAX_ENTRIES,
    _TOTAL_CAP,
    BackgroundProcessStore,
    HeadTailBuffer,
    ProcessEntry,
    get_background_store,
    set_background_store,
)

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
    # Clean up any lingering processes before restoring.
    store.clear()
    set_background_store(prior)


# ---------------------------------------------------------------------------
# HeadTailBuffer unit tests
# ---------------------------------------------------------------------------


class TestHeadTailBuffer:
    def test_under_cap_goes_to_tail(self):
        buf = HeadTailBuffer()
        buf.append(b"hello world")
        assert buf.head == bytearray()
        assert buf.tail == b"hello world"
        assert buf.total_bytes() == 11

    def test_over_cap_keeps_head_and_tail(self):
        buf = HeadTailBuffer()
        # Write 600 KiB to push head+tail over 1 MiB
        chunk_a = b"A" * (520 * 1024)
        chunk_b = b"B" * (520 * 1024)
        buf.append(chunk_a)
        buf.append(chunk_b)
        assert len(buf.head) == 512 * 1024
        assert buf.total_bytes() <= _TOTAL_CAP
        assert buf.head.startswith(b"A")
        assert buf.tail.endswith(b"B")

    def test_total_bytes_never_exceeds_cap(self):
        buf = HeadTailBuffer()
        for _ in range(200):
            buf.append(b"x" * 65536)
        assert buf.total_bytes() <= _TOTAL_CAP

    def test_get_tail_returns_string(self):
        buf = HeadTailBuffer()
        buf.append(b"line1\nline2\nline3\n")
        result = buf.get_tail()
        assert isinstance(result, str)
        assert "line1" in result
        assert "line3" in result

    def test_get_tail_last_n_lines(self):
        buf = HeadTailBuffer()
        buf.append(b"line1\nline2\nline3\nline4\nline5\n")
        result = buf.get_tail(last_n=2)
        lines = result.strip().split("\n")
        assert len(lines) == 2
        assert lines[0] == "line4"
        assert lines[1] == "line5"

    def test_get_tail_last_n_zero(self):
        buf = HeadTailBuffer()
        buf.append(b"line1\nline2\n")
        result = buf.get_tail(last_n=0)
        assert result == ""

    def test_head_preserved_when_over_cap(self):
        """After exceeding the cap, head still holds the first 512 KiB."""
        buf = HeadTailBuffer()
        # First append: 600 KiB (over head cap, stored in tail)
        buf.append(b"H" * (600 * 1024))
        assert buf.head == bytearray()
        assert len(buf.tail) == 600 * 1024
        # Second append: push total over 1 MiB → head gets first 512 KiB
        buf.append(b"T" * (600 * 1024))
        assert len(buf.head) == 512 * 1024
        assert buf.head.startswith(b"H")
        assert buf.tail.endswith(b"T")
        assert buf.total_bytes() <= _TOTAL_CAP


# ---------------------------------------------------------------------------
# Singleton tests
# ---------------------------------------------------------------------------


def test_singleton_stable():
    """get_background_store() returns the same instance on repeated calls."""
    s1 = get_background_store()
    s2 = get_background_store()
    assert s1 is s2


def test_set_background_store_overrides():
    """set_background_store() replaces the singleton."""
    original = get_background_store()
    replacement = BackgroundProcessStore()
    set_background_store(replacement)
    try:
        assert get_background_store() is replacement
    finally:
        set_background_store(original)


# ---------------------------------------------------------------------------
# Spawn + buffer + exit_code (scenario 1)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_spawn_populates_buffer_and_records_exit_code(fresh_store):
    """Spawn a quick command, wait for drain, verify buffer and exit_code."""
    proc_id, _ = await fresh_store.spawn("echo hello-from-bg")
    assert isinstance(proc_id, int)
    # Give the drain task time to finish.
    await asyncio.sleep(0.5)

    entry = fresh_store.get(proc_id)
    assert entry is not None
    assert entry.exit_code == 0
    text, exit_code = fresh_store.snapshot(proc_id)
    assert exit_code == 0
    assert "hello-from-bg" in text


# ---------------------------------------------------------------------------
# Buffer overflow 1 MiB (scenario 2)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chatty_command_buffer_bounded(fresh_store):
    """A command that writes >1 MiB must have bounded buffer."""
    # Use yes | head -c to produce a fixed amount > 1 MiB
    proc_id, _ = await fresh_store.spawn(
        "python3 -c \"import sys; sys.stdout.buffer.write(b'x' * (2 * 1024 * 1024))\""
    )
    await asyncio.sleep(1.0)

    entry = fresh_store.get(proc_id)
    assert entry is not None
    assert entry.exit_code == 0
    assert entry.buffer.total_bytes() <= _TOTAL_CAP
    assert len(entry.buffer.head) > 0


# ---------------------------------------------------------------------------
# LRU eviction (scenario 3)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lru_eviction_on_65th_entry(fresh_store):
    """Spawning 65 commands triggers LRU eviction down to ≤64."""
    proc_ids = []
    for i in range(_MAX_ENTRIES + 1):
        pid, _ = await fresh_store.spawn(f"echo spawn-{i}")
        proc_ids.append(pid)
        # Tiny yield so drain tasks don't stack up.
        await asyncio.sleep(0.01)

    # Wait a bit for drains to finish.
    await asyncio.sleep(0.3)

    # The store should have at most _MAX_ENTRIES entries.
    assert len(fresh_store.list()) <= _MAX_ENTRIES

    # The 8 most-recent entries (indices -8..) are protected from eviction.
    # The oldest entry (proc_ids[0]) should have been evicted first.
    assert fresh_store.get(proc_ids[0]) is None
    # The newest 8 entries should still be present.
    for pid in proc_ids[-_MAX_ENTRIES // 2:]:
        assert fresh_store.get(pid) is not None


# ---------------------------------------------------------------------------
# terminate_all (scenario 4)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_terminate_all_kills_sleeping_processes(fresh_store):
    """terminate_all() must kill long-sleeping processes."""
    pids = []
    for _ in range(3):
        pid, _ = await fresh_store.spawn("sleep 60")
        pids.append(pid)
    await asyncio.sleep(0.2)

    fresh_store.terminate_all()
    await asyncio.sleep(0.8)

    for pid in pids:
        entry = fresh_store.get(pid)
        if entry is not None:
            # Process should have been killed (exit code != 0 or entry removed).
            assert entry.exit_code is not None


# ---------------------------------------------------------------------------
# snapshot (scenario 5)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_snapshot_returns_tail_and_exit_code(fresh_store):
    """snapshot() returns (tail_text, exit_code)."""
    proc_id, _ = await fresh_store.spawn(
        "sh -c 'for i in 1 2 3 4 5; do echo line-$i; done'"
    )
    await asyncio.sleep(0.5)

    text, exit_code = fresh_store.snapshot(proc_id)
    assert exit_code == 0
    assert "line-1" in text
    assert "line-5" in text


@pytest.mark.asyncio
async def test_snapshot_last_n_lines(fresh_store):
    """snapshot(id, last_n=5) returns approximately 5 lines."""
    lines = "\\n".join(f"line-{i}" for i in range(20))
    proc_id, _ = await fresh_store.spawn(f"echo '{lines}'")
    await asyncio.sleep(0.5)

    text, exit_code = fresh_store.snapshot(proc_id, last_n=5)
    assert exit_code == 0
    # Should contain the last ~5 lines
    assert "line-19" in text


# ---------------------------------------------------------------------------
# send on non-interactive (scenario 6)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_non_interactive_returns_false(fresh_store):
    """send() on a non-interactive process returns False."""
    proc_id, _ = await fresh_store.spawn("sleep 60")
    await asyncio.sleep(0.1)

    result = await fresh_store.send(proc_id, "hello")
    assert result is False

    # Clean up
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# wait_for_progress (scenario 7)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wait_for_progress_resolves_on_output(fresh_store):
    """wait_for_progress() returns quickly when output arrives."""
    proc_id, _ = await fresh_store.spawn(
        "sh -c 'sleep 0.1 && echo progress-data'"
    )

    import time

    t0 = time.monotonic()
    await fresh_store.wait_for_progress(proc_id, wait_ms=5000)
    elapsed = time.monotonic() - t0

    # Should resolve well within 5 seconds (the command outputs after ~0.1s).
    assert elapsed < 3.0

    text, _ = fresh_store.snapshot(proc_id)
    assert "progress-data" in text

    # Clean up
    await asyncio.sleep(0.5)


# ---------------------------------------------------------------------------
# send on interactive (bonus – verifies the interactive=True path)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_interactive_returns_true(fresh_store):
    """send() on an interactive process with live stdin writes successfully."""
    proc_id, _ = await fresh_store.spawn("cat", interactive=True)
    await asyncio.sleep(0.2)

    result = await fresh_store.send(proc_id, "hello-interactive\n")
    assert result is True

    await asyncio.sleep(0.3)
    text, _ = fresh_store.snapshot(proc_id)
    assert "hello-interactive" in text

    # Clean up
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# ENV_SUPPRESSION shared constant
# ---------------------------------------------------------------------------


def test_env_suppression_imported():
    """ENV_SUPPRESSION is importable from both exec and background_store."""
    import orchid.tools.background_store as bg_mod
    import orchid.tools.exec as exec_mod

    # They should be the same object (imported, not redefined).
    assert exec_mod.ENV_SUPPRESSION is bg_mod.ENV_SUPPRESSION
    assert exec_mod.ENV_SUPPRESSION == {"NO_COLOR": "1", "TERM": "dumb", "PAGER": "cat"}


# ---------------------------------------------------------------------------
# ProcessEntry dataclass
# ---------------------------------------------------------------------------


def test_process_entry_defaults():
    """ProcessEntry has expected default values."""
    # We can't easily create a real asyncio.Process, so use a mock-like approach.
    from unittest.mock import MagicMock

    mock_proc = MagicMock()
    entry = ProcessEntry(id=1, command="echo test", process=mock_proc, buffer=HeadTailBuffer())
    assert entry.owner == "AGENT"
    assert entry.exit_code is None
    assert entry.interactive is False
    assert entry.master_fd is None
    assert entry.created_at > 0
    assert entry.last_output_at > 0


# ---------------------------------------------------------------------------
# get / list / snapshot on missing id
# ---------------------------------------------------------------------------


def test_get_missing_returns_none(fresh_store):
    """get() returns None for unknown id."""
    assert fresh_store.get(99999) is None


def test_list_empty_store(fresh_store):
    """list() on empty store returns empty list."""
    assert fresh_store.list() == []


def test_snapshot_missing_returns_none(fresh_store):
    """snapshot() returns None for unknown id."""
    assert fresh_store.snapshot(99999) is None


# ---------------------------------------------------------------------------
# spawn returns int id immediately
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_spawn_returns_int_id_immediately(fresh_store):
    """spawn() returns a tuple with an int id and None."""
    result = await fresh_store.spawn("echo fast")
    assert isinstance(result, tuple)
    assert len(result) == 2
    proc_id, none_val = result
    assert isinstance(proc_id, int)
    assert none_val is None
    # Clean up
    await asyncio.sleep(0.5)
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)
