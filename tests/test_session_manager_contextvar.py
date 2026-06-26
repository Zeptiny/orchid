"""Tests for SessionManager ContextVar binding centralization (P1-26).

The original finding flagged `_current_store` as not being rebound on
SessionManager.switch/load/create — a false-positive in the current code
(rebinding was done at every caller site). These tests pin the centralized
invariant introduced by moving `set_todo_store` + `set_current_session_id`
into SessionManager.create/switch/load themselves, so future transition
sites cannot forget to rebind.
"""

import unittest
from unittest.mock import patch

from stupidex.domain.session import (
    Session,
    SessionManager,
    get_current_session_id,
    set_current_session_id,
)
from stupidex.domain.todo import TodoStore, get_todo_store, set_todo_store


def _reset_contextvars():
    """Clear both session-scoped ContextVars between tests."""
    # ContextVar.reset requires a token from a prior .set(); simplest is to
    # set a None/empty value and let the next test's setup override.
    set_todo_store(TodoStore())
    set_current_session_id(None)


class TestSessionManagerContextVarBinding(unittest.TestCase):
    def setUp(self) -> None:
        _reset_contextvars()
        # SessionManager.__init__ patches config; mock default_model read.
        patcher = patch("stupidex.domain.session.get_config")
        self.mock_get_config = patcher.start()
        self.addCleanup(patcher.stop)
        self.mock_get_config.return_value.default_model = "test-model"

    def tearDown(self) -> None:
        _reset_contextvars()

    def test_create_rebinds_todo_store_and_session_id(self):
        """create() rebinds both ContextVars to the newly-created session."""
        sm = SessionManager()
        session = sm.create()

        # Both ContextVars point at the new session's data.
        self.assertIs(get_todo_store(), session.todo_store)
        self.assertEqual(get_current_session_id(), session.id)
        self.assertIs(sm.active, session)

    def test_switch_rebinds_todo_store_and_session_id(self):
        """switch() rebinds both ContextVars to the target session."""
        sm = SessionManager()
        a = sm.create()
        b = Session(name="b", model="m")
        sm.sessions[b.id] = b

        switched = sm.switch(b.id)
        self.assertIs(switched, b)
        self.assertIs(get_todo_store(), b.todo_store)
        self.assertEqual(get_current_session_id(), b.id)
        self.assertIs(sm.active, b)

        # Switching back rebinds again.
        sm.switch(a.id)
        self.assertIs(get_todo_store(), a.todo_store)
        self.assertEqual(get_current_session_id(), a.id)

    def test_switch_unknown_id_returns_none_and_does_not_rebind(self):
        """switch() on an unknown id returns None and leaves ContextVars alone."""
        sm = SessionManager()
        original = sm.create()
        result = sm.switch("does-not-exist")
        self.assertIsNone(result)
        # ContextVars unchanged.
        self.assertEqual(get_current_session_id(), original.id)
        self.assertIs(get_todo_store(), original.todo_store)

    def test_load_rebinds_on_success(self):
        """load() rebinds both ContextVars after a successful from_storage_dict."""
        sm = SessionManager()
        # Build a session with a known todo task, persist + reload.
        original = sm.create()
        original.todo_store.create("preexisting-task")
        storage_dict = original.to_storage_dict()

        # Bump ContextVar to a sentinel store so we can detect rebinding.
        sentinel = TodoStore()
        set_todo_store(sentinel)
        self.assertIs(get_todo_store(), sentinel)

        # Mock load_session to return the serialized form.
        with patch("stupidex.storage.load_session", return_value=storage_dict):
            loaded = sm.load(original.id)

        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertIs(get_todo_store(), loaded.todo_store)
        self.assertEqual(get_current_session_id(), loaded.id)
        # The loaded store actually has the task from the original.
        self.assertEqual(len(loaded.todo_store.list()), 1)

    def test_load_does_not_rebind_on_failure(self):
        """load() leaves ContextVars untouched when deserialization fails."""
        sm = SessionManager()
        original = sm.create()
        sentinel_store = TodoStore()
        set_todo_store(sentinel_store)
        sentinel_session_id = "sentinel-session-id"
        from stupidex.domain.session import set_current_session_id

        set_current_session_id(sentinel_session_id)

        # Simulate a corrupt session file that raises during from_storage_dict.
        # A missing "id" key triggers KeyError in Session.from_storage_dict,
        # which propagates up through the bare Session constructor call.
        # (Unknown enum values no longer raise — they fall back per U3 / P2-9.)
        with patch(
            "stupidex.storage.load_session",
            return_value={"name": "bad", "chains": []},
        ):
            result = sm.load("x")

        self.assertIsNone(result)
        # ContextVars untouched.
        self.assertIs(get_todo_store(), sentinel_store)
        self.assertEqual(get_current_session_id(), sentinel_session_id)
        # active pointer also unchanged.
        self.assertIs(sm.active, original)

    def test_load_returns_none_when_storage_missing(self):
        """load() returns None when load_session returns None (no file)."""
        sm = SessionManager()
        original = sm.create()
        sentinel = TodoStore()
        set_todo_store(sentinel)

        with patch("stupidex.storage.load_session", return_value=None):
            result = sm.load("nonexistent-id")

        self.assertIsNone(result)
        self.assertIs(get_todo_store(), sentinel)
        self.assertEqual(get_current_session_id(), original.id)


if __name__ == "__main__":
    unittest.main()
