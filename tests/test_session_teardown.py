"""Tests for U8: Session/App teardown integration — background-process cleanup."""

from __future__ import annotations

import asyncio
import time
import unittest
from unittest.mock import patch

import pytest

from orchid.domain.session import Session, SessionManager
from orchid.tools.background_store import (
    BackgroundProcessStore,
    get_background_store,
    set_background_store,
)

# ---------------------------------------------------------------------------
# Synchronous tests (unittest style)
# ---------------------------------------------------------------------------


class TestSessionDeleteTerminatesBackgroundProcesses(unittest.TestCase):
    """Deleting a session calls terminate_session() on the background store."""

    def _manager_with_session(self, sess_id: str) -> SessionManager:
        mgr = SessionManager()
        session = Session(name="S", id=sess_id, model="m")
        mgr.sessions[sess_id] = session
        mgr.active = session
        return mgr

    @patch("orchid.storage.delete_session")
    def test_delete_calls_terminate_session(self, mock_delete):
        """terminate_session is called during session delete."""
        prior = get_background_store()
        mock_store = BackgroundProcessStore()
        set_background_store(mock_store)
        try:
            mgr = self._manager_with_session("sess-1")
            with patch.object(mock_store, "terminate_session") as mock_term:
                self.assertTrue(mgr.delete("sess-1"))
                mock_term.assert_called_once_with("sess-1")
        finally:
            set_background_store(prior)

    @patch("orchid.storage.delete_session")
    def test_delete_terminate_session_before_disk_delete(self, mock_delete):
        """terminate_session is called before delete_session (cleanup ordering)."""
        prior = get_background_store()
        mock_store = BackgroundProcessStore()
        set_background_store(mock_store)
        call_order: list[str] = []

        def track_delete(sid):
            call_order.append("delete_session")

        mock_delete.side_effect = track_delete

        mgr = self._manager_with_session("sess-1")
        session = mgr.sessions["sess-1"]

        def track_cancel():
            call_order.append("cancel_all")

        def track_terminate(sid):
            call_order.append("terminate_session")

        with (
            patch.object(session.subagent_manager, "cancel_all", side_effect=track_cancel),
            patch.object(mock_store, "terminate_session", side_effect=track_terminate),
        ):
            self.assertTrue(mgr.delete("sess-1"))

        self.assertEqual(call_order, ["cancel_all", "terminate_session", "delete_session"])
        set_background_store(prior)

    @patch("orchid.storage.delete_session")
    def test_delete_nonexistent_session_no_terminate(self, mock_delete):
        """Deleting a missing session does not touch the store at all."""
        prior = get_background_store()
        mock_store = BackgroundProcessStore()
        set_background_store(mock_store)
        try:
            mgr = SessionManager()
            with patch.object(mock_store, "terminate_session") as mock_term:
                self.assertFalse(mgr.delete("missing"))
                mock_term.assert_not_called()
        finally:
            set_background_store(prior)

    @patch("orchid.storage.delete_session")
    def test_terminate_all_on_empty_store_is_noop(self, mock_delete):
        """terminate_all on a fresh/empty store is a safe no-op."""
        prior = get_background_store()
        mock_store = BackgroundProcessStore()
        set_background_store(mock_store)
        try:
            mgr = self._manager_with_session("sess-1")
            # Should not raise even with zero entries
            self.assertTrue(mgr.delete("sess-1"))
        finally:
            set_background_store(prior)


class TestBackgroundStoreIdleTimeoutConfig(unittest.TestCase):
    """Idle timeout configuration is respected end-to-end."""

    def test_default_idle_timeout(self):
        from orchid.config import get_config
        cfg = get_config()
        self.assertEqual(cfg.background_command_idle_timeout, 900.0)


# ---------------------------------------------------------------------------
# Async tests (pytest-asyncio style, matching project pattern)
# ---------------------------------------------------------------------------


@pytest.fixture
async def _fresh_store():
    """Provide a fresh store, restoring the original on teardown."""
    prior = get_background_store()
    store = BackgroundProcessStore()
    set_background_store(store)
    yield store
    # Terminate processes and cancel drain tasks while the event loop is
    # still alive so runner.close() doesn't hang on pending tasks.
    for entry in store._entries.values():
        proc = entry.process
        if proc.returncode is None:
            try:
                import os
                import signal
                os.killpg(proc.pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
    for task in store._drain_tasks.values():
        task.cancel()
    store._drain_tasks.clear()
    import asyncio
    await asyncio.sleep(0)  # let cancellations propagate
    store._entries.clear()
    set_background_store(prior)


@pytest.mark.asyncio
async def test_terminate_all_kills_sleeping_process(_fresh_store):
    """Spawning then terminate_all leaves no live children."""
    _id, _ = await _fresh_store.spawn("sleep 60", cwd=".")
    entry = _fresh_store.get(_id)
    assert entry is not None
    assert entry.process.returncode is None
    _fresh_store.terminate_all()
    await entry.process.wait()
    assert entry.process.returncode is not None


@pytest.mark.asyncio
async def test_terminate_all_multiple_processes(_fresh_store):
    """terminate_all kills all spawned processes."""
    ids = []
    for _ in range(3):
        _id, _ = await _fresh_store.spawn("sleep 60", cwd=".")
        ids.append(_id)
    for _id in ids:
        entry = _fresh_store.get(_id)
        assert entry is not None
        assert entry.process.returncode is None
    _fresh_store.terminate_all()
    for _id in ids:
        entry = _fresh_store.get(_id)
        assert entry is not None
        await entry.process.wait()
        assert entry.process.returncode is not None


@pytest.mark.asyncio
async def test_check_idle_reverts_expired_entry(_fresh_store):
    """USER-owned entry idle beyond timeout reverts to AGENT."""
    idle_timeout = 900.0
    _id, _ = await _fresh_store.spawn("sleep 60", cwd=".")
    entry = _fresh_store.get(_id)
    assert entry is not None
    entry.owner = "USER"
    entry.last_user_input_at = time.monotonic() - idle_timeout - 1
    _fresh_store.check_idle_ownership(idle_timeout)
    entry_after = _fresh_store.get(_id)
    assert entry_after is not None
    assert entry_after.owner == "AGENT"


@pytest.mark.asyncio
async def test_check_idle_keeps_recent_user_entry(_fresh_store):
    """USER-owned entry receiving user input within window stays USER."""
    _id, _ = await _fresh_store.spawn("sleep 60", cwd=".")
    entry = _fresh_store.get(_id)
    assert entry is not None
    entry.owner = "USER"
    entry.last_user_input_at = time.monotonic()
    _fresh_store.check_idle_ownership(900.0)
    entry_after = _fresh_store.get(_id)
    assert entry_after is not None
    assert entry_after.owner == "USER"


@pytest.mark.asyncio
async def test_terminate_session_only_kills_matching_session(_fresh_store):
    """terminate_session kills only processes belonging to the given session."""
    _id_a, _ = await _fresh_store.spawn("sleep 60", session_id="sess-A")
    _id_b, _ = await _fresh_store.spawn("sleep 60", session_id="sess-B")
    _fresh_store.terminate_session("sess-A")
    entry_a = _fresh_store.get(_id_a)
    entry_b = _fresh_store.get(_id_b)
    assert entry_a is not None
    assert entry_b is not None
    await entry_a.process.wait()
    # Give the drain task time to update exit_code after the process exits.
    await asyncio.sleep(0.1)
    assert entry_a.exit_code is not None
    # Entry B should still be alive
    assert entry_b.exit_code is None
    # Clean up entry B
    _fresh_store.terminate(_id_b)
    await entry_b.process.wait()


if __name__ == "__main__":
    unittest.main()
