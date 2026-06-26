"""Tests for the `/index-ast` command (unit U6, requirement R12).

Mirrors the pattern in `tests/test_session_commands.py`: exercises the
`execute_command` dispatch path with a mock `app`, verifying the worker
is launched and notifications are sent.

Scenarios from the plan:
- Happy path: `/index-ast` appears in COMMANDS
- Happy path: executing triggers index_project(force=True) and notifies
- Edge case: substring filter picks up `/index-ast` when typing `/index`
- Error path: index_project exception -> error notification, no crash
"""

import asyncio
import inspect
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from stupidex.commands.session_commands import COMMANDS, execute_command

_INDEX_PROJECT = "stupidex.ast.indexer.index_project"
_IS_INDEXING = "stupidex.ast.indexer.is_indexing"


class TestIndexAstCommandInCommands(unittest.TestCase):
    """Scenario 1: /index-ast is registered in the COMMANDS dict."""

    def test_command_present(self):
        self.assertIn("/index-ast", COMMANDS)

    def test_command_description(self):
        desc = COMMANDS["/index-ast"]
        self.assertIn("AST", desc)
        self.assertIn("symbol", desc.lower())

    def test_index_substring_shows_index_ast(self):
        """Edge case: 'index' is a substring of 'index-ast', so the
        command picker will show /index-ast when typing '/index'.
        This is an accepted UX limitation -- just verify the relationship."""
        index_cmds = [cmd for cmd in COMMANDS if "index" in cmd]
        self.assertIn("/index-ast", index_cmds)
        self.assertIn("/index-rag", index_cmds)


class TestIndexAstExecution(unittest.TestCase):
    """Scenario 2 + 4: executing /index-ast calls index_project(force=True)
    via app.run_worker and notifies on success/error."""

    def test_happy_path_notifies_and_runs_worker(self):
        """The initial notification fires and run_worker is called."""
        app = MagicMock()
        app.run_worker = MagicMock()
        app.refresh_index_status = AsyncMock()

        with patch(_INDEX_PROJECT), patch(_IS_INDEXING, return_value=False):
            asyncio.run(execute_command(app, "/index-ast"))

        app.notify.assert_any_call(
            "Re-scanning project for AST symbols...",
            severity="information",
        )
        app.run_worker.assert_called_once()

    def test_run_worker_receives_coroutine_function(self):
        """run_worker receives an async callable (coroutine function),
        not None or a plain function."""
        captured_fn = {}

        def capture_worker(coro_fn):
            captured_fn["fn"] = coro_fn

        app = MagicMock()
        app.run_worker = capture_worker
        app.refresh_index_status = AsyncMock()

        with patch(_INDEX_PROJECT), patch(_IS_INDEXING, return_value=False):
            asyncio.run(execute_command(app, "/index-ast"))

        self.assertIn("fn", captured_fn)
        self.assertTrue(inspect.iscoroutinefunction(captured_fn["fn"]))

    def test_run_worker_receives_different_function_each_call(self):
        """Each invocation of execute_command produces a fresh coroutine
        function (not a stale reference)."""
        captured_fns = []

        def capture_worker(coro_fn):
            captured_fns.append(coro_fn)

        app = MagicMock()
        app.run_worker = capture_worker
        app.refresh_index_status = AsyncMock()

        with patch(_INDEX_PROJECT), patch(_IS_INDEXING, return_value=False):
            asyncio.run(execute_command(app, "/index-ast"))
            asyncio.run(execute_command(app, "/index-ast"))

        self.assertEqual(len(captured_fns), 2)
        # Both are coroutine functions but are distinct objects.
        self.assertTrue(inspect.iscoroutinefunction(captured_fns[0]))
        self.assertTrue(inspect.iscoroutinefunction(captured_fns[1]))
        self.assertIsNot(captured_fns[0], captured_fns[1])

    def test_worker_body_awaits_index_project_force_true(self):
        """The worker coroutine actually calls index_project with force=True."""
        captured_fn = {}

        def capture_worker(coro_fn):
            captured_fn["fn"] = coro_fn

        app = MagicMock()
        app.run_worker = capture_worker
        app.refresh_index_status = AsyncMock()

        mock_index = AsyncMock(return_value=MagicMock(
            files_indexed=1, symbols_extracted=2,
            duration_seconds=0.1, files_skipped=0, files_deleted=0, errors=[],
        ))

        with patch(_INDEX_PROJECT, mock_index), patch(_IS_INDEXING, return_value=False):
            asyncio.run(execute_command(app, "/index-ast"))

        asyncio.run(captured_fn["fn"]())
        mock_index.assert_called_with(force=True)

    def test_error_path_sends_error_notification(self):
        """Scenario 4: index_project exception -> error notification, no crash."""
        captured_fn = {}

        def capture_worker(coro_fn):
            captured_fn["fn"] = coro_fn

        app = MagicMock()
        app.run_worker = capture_worker
        app.refresh_index_status = AsyncMock()

        mock_index = AsyncMock(side_effect=RuntimeError("index exploded"))

        with patch(_INDEX_PROJECT, mock_index), patch(_IS_INDEXING, return_value=False):
            asyncio.run(execute_command(app, "/index-ast"))

        asyncio.run(captured_fn["fn"]())

        app.notify.assert_any_call(
            "AST re-index failed: index exploded",
            severity="error",
        )

if __name__ == "__main__":
    unittest.main()
