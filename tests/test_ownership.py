"""Tests for ownership/focus mutex + idle auto-release (U5)."""

from __future__ import annotations

import asyncio
import time

import pytest

from orchid.tools.background_io import execute_read_output, execute_send_input
from orchid.tools.background_store import (
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
    store.clear()
    set_background_store(prior)


@pytest.fixture
def short_timeout(monkeypatch):
    """Set a very short idle timeout via env var."""
    monkeypatch.setenv("ORCHID_BACKGROUND_COMMAND_IDLE_TIMEOUT", "0.5")
    return 0.5


# ---------------------------------------------------------------------------
# Scenario 1: take_ownership flips owner; send_input rejects; read_output works
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_take_ownership_blocks_send_input(fresh_store):
    """take_ownership flips to USER; send_input returns rejection; read_output still works."""
    proc_id, _ = await fresh_store.spawn("cat", interactive=True)
    await asyncio.sleep(0.2)

    # Take ownership
    assert fresh_store.take_ownership(proc_id) is True
    entry = fresh_store.get(proc_id)
    assert entry.owner == "USER"
    assert entry.last_user_input_at > 0

    # send_input should be rejected
    result = await execute_send_input(id=proc_id, text="hello\n")
    assert "USER" in result.content
    assert "control: USER" in result.content

    # read_output should still work
    result = await execute_read_output(id=proc_id)
    assert "<command_output" in result.content

    # Clean up
    fresh_store.release_ownership(proc_id)
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# Scenario 2: release_ownership flips back; send_input succeeds
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_release_ownership_allows_send_input(fresh_store):
    """release_ownership flips to AGENT; send_input succeeds again."""
    proc_id, _ = await fresh_store.spawn("cat", interactive=True)
    await asyncio.sleep(0.3)

    # Take then release ownership
    fresh_store.take_ownership(proc_id)
    fresh_store.release_ownership(proc_id)
    entry = fresh_store.get(proc_id)
    assert entry.owner == "AGENT"

    # send_input should now succeed
    result = await execute_send_input(id=proc_id, text="hello-after-release\n")
    assert "Sent input" in result.display
    assert "<input_sent" in result.content

    await asyncio.sleep(0.3)
    text, _ = fresh_store.snapshot(proc_id)
    assert "hello-after-release" in text

    # Clean up
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# Scenario 3: USER-owned entry idle beyond timeout reverts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_idle_ownership_reverts(fresh_store, short_timeout):
    """USER-owned entry idle beyond timeout reverts to AGENT."""
    proc_id, _ = await fresh_store.spawn("sleep 60")
    await asyncio.sleep(0.2)

    # Take ownership
    fresh_store.take_ownership(proc_id)
    entry = fresh_store.get(proc_id)
    assert entry.owner == "USER"

    # Wait for the idle timeout to elapse
    await asyncio.sleep(0.7)

    # check_idle_ownership should revert
    fresh_store.check_idle_ownership(idle_timeout=short_timeout)
    assert entry.owner == "AGENT"

    # Clean up
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# Scenario 4: USER-owned entry receiving user input within window keeps USER
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_user_input_refreshes_idle_window(fresh_store, short_timeout):
    """Receiving user input within the window keeps the entry USER-owned."""
    proc_id, _ = await fresh_store.spawn("cat", interactive=True)
    await asyncio.sleep(0.3)

    # Take ownership
    fresh_store.take_ownership(proc_id)

    # Simulate user input within the idle window (just under timeout)
    entry = fresh_store.get(proc_id)
    entry.last_user_input_at = time.monotonic()  # refresh the timestamp

    await asyncio.sleep(0.3)

    # check_idle_ownership should NOT revert
    fresh_store.check_idle_ownership(idle_timeout=short_timeout)
    assert entry.owner == "USER"

    # Clean up
    fresh_store.release_ownership(proc_id)
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# Scenario 5: Config override via env var shortens timeout
# ---------------------------------------------------------------------------


def test_config_idle_timeout_from_env(monkeypatch):
    """Setting ORCHID_BACKGROUND_COMMAND_IDLE_TIMEOUT env var overrides config."""
    from orchid.config import ConfigManager, validate_config

    ConfigManager.reset()
    monkeypatch.setenv("ORCHID_BACKGROUND_COMMAND_IDLE_TIMEOUT", "42.5")
    try:
        cfg = ConfigManager.load()
        assert cfg.background_command_idle_timeout == 42.5
        errors = validate_config(cfg)
        assert not any("background_command_idle_timeout" in e for e in errors)
    finally:
        ConfigManager.reset()
        monkeypatch.delenv("ORCHID_BACKGROUND_COMMAND_IDLE_TIMEOUT", raising=False)


# ---------------------------------------------------------------------------
# Scenario 6: take_ownership on nonexistent id returns False
# ---------------------------------------------------------------------------


def test_take_ownership_nonexistent(fresh_store):
    """take_ownership on nonexistent id returns False."""
    assert fresh_store.take_ownership(99999) is False


# ---------------------------------------------------------------------------
# Scenario 7: release_ownership on already-AGENT entry is idempotent
# ---------------------------------------------------------------------------


def test_release_ownership_idempotent(fresh_store):
    """release_ownership on already-AGENT entry is idempotent (returns True)."""
    proc_id = _spawn_mock(fresh_store)
    entry = fresh_store.get(proc_id)
    assert entry.owner == "AGENT"

    # release_ownership should succeed even when already AGENT
    assert fresh_store.release_ownership(proc_id) is True
    assert entry.owner == "AGENT"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _spawn_mock(store: BackgroundProcessStore) -> int:
    """Insert a fake entry into the store for unit-testing ownership logic."""
    from unittest.mock import MagicMock

    mock_proc = MagicMock()
    entry = ProcessEntry(
        id=store._next_id,
        command="mock-cmd",
        process=mock_proc,
        buffer=HeadTailBuffer(),
    )
    store._entries[entry.id] = entry
    store._next_id += 1
    return entry.id
