"""Tests for P0-6: configurable MCP startup timeouts.

Regression coverage for the hang where a single MCP server whose
``initialize``/``list_tools``/``list_resources`` (or transport
``enter_async_context``) never returns would block ``App.on_mount``
forever, because none of the blocking awaits were bounded by an
``asyncio.wait_for``.

The fix layers two budgets:

* a per-server budget wrapping the whole ``_start_server`` body — on
  timeout the server is marked ``"failed"`` (via ``_run``'s existing
  ``except Exception``) and the loop continues;
* an overall budget guarding ``start_all``'s ``await self._ready.wait()``
  — on timeout the runner is torn down (``_await_runner``) and
  ``start_all`` returns skip-and-continue so the app stays usable.

These tests stub the MCP transport and ``ClientSession`` (no real
subprocesses are spawned), mirroring ``tests/test_mcp_lifecycle.py``.
"""
import asyncio
import logging
import time
import unittest
from contextlib import asynccontextmanager
from unittest.mock import patch

import anyio


@asynccontextmanager
async def fake_stdio_client(server_params, *, fail_enter=False):
    """Mimics ``mcp.client.stdio.stdio_client``'s anyio task-group shape.

    A long-lived reader subtask is spawned so the task group's cancel scope
    is task-bound — matching the real transport's cross-task-exit
    behaviour (see ``test_mcp_lifecycle.py``).

    The yielded ``read_stream`` carries the server's ``command`` string so
    ``FakeClientSession`` can branch its behaviour per server (hung vs
    healthy vs hang-on-list-tools) without spawning a real subprocess.

    If ``fail_enter`` is set, entering the transport context hangs (awaits
    an Event that never fires) — exercises the per-server timeout around
    ``enter_async_context`` rather than around an RPC.
    """

    async def reader():
        try:
            await anyio.sleep_forever()
        except anyio.get_cancelled_exc_class():
            pass

    if fail_enter:
        # Never reaches the yield: transport enter itself hangs.
        async with anyio.create_task_group() as tg:
            tg.start_soon(reader)
            try:
                await asyncio.Event().wait()
                yield (server_params.command, object())  # pragma: no cover
            finally:
                tg.cancel_scope.cancel()
        return

    async with anyio.create_task_group() as tg:
        tg.start_soon(reader)
        try:
            yield (server_params.command, object())
        finally:
            tg.cancel_scope.cancel()


class _ToolsResult:
    def __init__(self):
        self.tools = []


class _ResourcesResult:
    def __init__(self):
        self.resources = []


class _ScriptedClientSession:
    """Stand-in for ``mcp.ClientSession`` with controllable hang points.

    ``behavior`` selects what the server does:
    * ``"healthy"`` — every RPC returns immediately;
    * ``"hung-initialize"`` — ``initialize`` awaits an never-set Event;
    * ``"hung-list-tools"`` — ``initialize`` returns, ``list_tools`` hangs.
    """

    def __init__(self, read_stream, write_stream, *, behavior="healthy"):
        self.command = read_stream
        self.behavior = behavior

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def initialize(self):
        if self.behavior == "hung-initialize":
            await asyncio.Event().wait()  # pragma: no cover
        # healthy / hung-list-tools: return immediately

    async def list_tools(self):
        if self.behavior == "hung-list-tools":
            await asyncio.Event().wait()  # pragma: no cover
        return _ToolsResult()

    async def list_resources(self):
        return _ResourcesResult()


def _scripted_factory(behaviors: dict[str, str]):
    """Build a patched ``ClientSession`` callable that picks behavior by command."""

    def patched_client_session(read_stream, write_stream):
        behavior = behaviors.get(read_stream, "healthy")
        return _ScriptedClientSession(read_stream, write_stream, behavior=behavior)

    return patched_client_session


class _RecordingHandler(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


class TestMCPStartupTimeout(unittest.IsolatedAsyncioTestCase):
    async def test_start_server_times_out_on_hung_initialize(self):
        """A hung ``initialize`` is bounded by the per-server timeout.

        One hung server followed by one healthy server: the hung one is
        marked ``"failed"`` and the healthy one still connects.
        ``start_all`` returns within ``per_server + slack``.
        """
        from stupidex.mcp import MCPManager

        behaviors = {"hung": "hung-initialize", "healthy": "healthy"}
        servers = {
            "srv-hung": {"command": "hung", "args": []},
            "srv-healthy": {"command": "healthy", "args": []},
        }
        manager = MCPManager()
        handler = _RecordingHandler()
        logger = logging.getLogger("stupidex.mcp")
        logger.addHandler(handler)
        try:
            with (
                patch("stupidex.mcp.stdio_client", fake_stdio_client),
                patch("stupidex.mcp.ClientSession", _scripted_factory(behaviors)),
            ):
                t0 = time.monotonic()
                await manager.start_all(
                    servers,
                    per_server_timeout=0.2,
                    startup_timeout=5.0,
                )
                elapsed = time.monotonic() - t0

            statuses = manager.get_server_statuses()
            self.assertEqual(statuses["srv-hung"]["status"], "failed")
            self.assertIn("timed out", statuses["srv-hung"]["error"])
            self.assertEqual(statuses["srv-healthy"]["status"], "connected")
            # Hung server never registered a live session.
            self.assertNotIn("srv-hung", manager._sessions)
            self.assertIn("srv-healthy", manager._sessions)
            # Bounded: per-server budget for the hung server + a small slack
            # for the healthy connect. Generous upper bound to avoid CI flake.
            self.assertLess(elapsed, 1.5)
        finally:
            logger.removeHandler(handler)
            await manager.shutdown()

    async def test_start_all_overall_timeout_skip_and_continue(self):
        """Overall budget bounds ``start_all`` even with a large per-server budget.

        Three hung servers with a per-server timeout larger than the overall
        timeout: the overall budget fires first, ``start_all`` returns
        skip-and-continue (no raise), the runner is torn down, non-terminal
        servers are marked ``"unavailable"``, and sessions are cleared so
        later ``call_tool`` calls report cleanly.
        """
        from stupidex.mcp import MCPManager

        behaviors = {f"hung-{i}": "hung-initialize" for i in range(3)}
        servers = {f"srv-{i}": {"command": f"hung-{i}", "args": []} for i in range(3)}
        manager = MCPManager()
        handler = _RecordingHandler()
        logger = logging.getLogger("stupidex.mcp")
        logger.addHandler(handler)
        try:
            with (
                patch("stupidex.mcp.stdio_client", fake_stdio_client),
                patch("stupidex.mcp.ClientSession", _scripted_factory(behaviors)),
            ):
                t0 = time.monotonic()
                # ``start_all`` must NOT raise on overall timeout (skip-and-continue).
                await manager.start_all(
                    servers,
                    per_server_timeout=5.0,
                    startup_timeout=0.3,
                )
                elapsed = time.monotonic() - t0

            statuses = manager.get_server_statuses()
            # Every server was still "starting" when the overall budget
            # fired — all should now be marked unavailable.
            for name, status in statuses.items():
                self.assertEqual(status["status"], "unavailable", f"{name}: {status}")
                self.assertIn("timed out", status["error"])
            # Runner torn down and the dead-session map cleared.
            self.assertIsNone(manager._runner)
            self.assertEqual(manager._sessions, {})
            # Bounded by overall + _await_runner's 3s shutdown budget.
            self.assertLess(elapsed, 4.5)
            # A warning was logged so the skip-and-continue is observable.
            startup_warnings = [
                r for r in handler.records
                if r.levelno >= logging.WARNING and "startup timed out" in (r.getMessage() or "").lower()
            ]
            self.assertGreater(len(startup_warnings), 0)
        finally:
            logger.removeHandler(handler)
            # Manager already torn down by skip-and-continue path; shutdown is a no-op
            # but safe to call.
            await manager.shutdown()


    async def test_startup_timeout_clears_tools(self):
        """After an overall startup timeout, orphaned tool registrations are dropped.

        Regression for the bug where the ``except TimeoutError`` branch in
        ``start_all`` cleared ``self._sessions`` but left ``self._tools``
        populated — the LLM would then be advertised dead tool entries whose
        executors could never run (no backing session), producing confusing
        "not connected" failures from user-initiated tool calls.

        This pre-populates ``_tools``/``_sessions`` to model the state where
        some servers connected and registered tools before the overall budget
        fired on a remaining hung server, then verifies the timeout path wipes
        both maps and that a subsequent ``call_tool`` reports cleanly.
        """
        from stupidex.mcp import MCPManager

        behaviors = {f"hung-{i}": "hung-initialize" for i in range(2)}
        servers = {f"srv-{i}": {"command": f"hung-{i}", "args": []} for i in range(2)}
        manager = MCPManager()
        # Simulate tools/sessions registered by a since-superseded state so we
        # can assert the timeout branch actually clears them.
        manager._tools["mcp::srv-0::dead_tool"] = {"tool": object(), "executor": None}
        manager._sessions["srv-0"] = None  # type: ignore[assignment]
        handler = _RecordingHandler()
        logger = logging.getLogger("stupidex.mcp")
        logger.addHandler(handler)
        try:
            with (
                patch("stupidex.mcp.stdio_client", fake_stdio_client),
                patch("stupidex.mcp.ClientSession", _scripted_factory(behaviors)),
            ):
                # ``start_all`` must NOT raise on overall timeout (skip-and-continue).
                await manager.start_all(
                    servers,
                    per_server_timeout=5.0,
                    startup_timeout=0.3,
                )

            # Both maps wiped: no orphaned tools advertised, no dead sessions.
            self.assertEqual(manager._tools, {})
            self.assertEqual(manager.get_tools(), {})
            self.assertEqual(manager._sessions, {})

            # A tool call against a dropped session reports "not connected"
            # rather than dispatching into a dead executor/session.
            result = await manager.call_tool("srv-0", "dead_tool", {})
            self.assertIn("not connected", result.content)
        finally:
            logger.removeHandler(handler)
            await manager.shutdown()


if __name__ == "__main__":
    unittest.main()
