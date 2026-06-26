from __future__ import annotations

import asyncio
import contextlib
import logging
from contextvars import ContextVar

from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.types import BlobResourceContents, TextResourceContents

from stupidex.config import _MCP_SERVER_NAME_RE
from stupidex.domain.tool import ExecutorResult

logger = logging.getLogger(__name__)

_mcp_manager: ContextVar[MCPManager | None] = ContextVar('mcp_manager', default=None)


async def _close_session(session: ClientSession) -> None:
    """Best-effort close of a (possibly already-closed) client session.

    ``ClientSession`` exposes ``__aexit__`` rather than ``aclose``; some
    fake/stub sessions used in tests may only implement one or the other.
    Swallowing of errors is the caller's responsibility (we are gathered
    with ``return_exceptions=True``); this helper just picks whichever
    shutdown coroutine the object offers.
    """
    aclose = getattr(session, "aclose", None)
    if aclose is not None:
        await aclose()
        return
    await session.__aexit__(None, None, None)


def get_mcp_manager() -> MCPManager | None:
    return _mcp_manager.get()


def set_mcp_manager(manager: MCPManager | None) -> None:
    _mcp_manager.set(manager)


class MCPManager:
    """Manages MCP client sessions and their transports.

    The ``stdio_client`` / ``sse_client`` transports wrap ``anyio`` task groups
    whose cancel scopes are task-bound: the task that *enters* a transport
    context must be the one that *exits* it. In the app, ``start_all`` runs from
    ``App.on_mount`` and ``shutdown`` from ``App.on_exit`` — Textual dispatches
    these in different tasks. To keep the enter/exit pair on a single task, the
    whole lifecycle (enter transports, then later close them) runs inside one
    dedicated runner task that owns the :class:`AsyncExitStack`.
    """

    def __init__(self):
        self._exit_stack = contextlib.AsyncExitStack()
        self._sessions: dict[str, ClientSession] = {}
        self._tools: dict[str, dict] = {}
        self._uri_map: dict[str, str] = {}  # uri -> server_name
        self._server_status: dict[str, dict] = {}  # name -> {status, tool_count, error}
        self._runner: asyncio.Task | None = None
        self._ready: asyncio.Event = asyncio.Event()
        self._stop: asyncio.Event = asyncio.Event()
        self._start_error: BaseException | None = None
        # Per-server budget wrapping every blocking RPC/transport entry in
        # ``_start_server``; overall budget guarding ``start_all`` against a
        # hung runner. Overridden by ``start_all`` from config.
        self._per_server_timeout: float = 10.0
        self._startup_timeout: float = 60.0

    async def start_all(
        self,
        servers: dict[str, dict],
        *,
        per_server_timeout: float | None = None,
        startup_timeout: float | None = None,
    ) -> None:
        if self._runner is not None and not self._runner.done():
            raise RuntimeError("MCPManager.start_all already in progress")
        if per_server_timeout is None or startup_timeout is None:
            try:
                from stupidex.config import get_config

                cfg = get_config()
            except Exception:
                cfg = None
            if per_server_timeout is None:
                per_server_timeout = float(getattr(cfg, "mcp_per_server_timeout", 10.0) if cfg else 10.0)
            if startup_timeout is None:
                startup_timeout = float(getattr(cfg, "mcp_startup_timeout", 60.0) if cfg else 60.0)
        self._per_server_timeout = per_server_timeout
        self._startup_timeout = startup_timeout
        # Reinitialize the one-shot lifecycle state so a manager can be
        # restarted after shutdown: the Events were set by the prior run and
        # the exit stack was closed by shutdown, which would otherwise make the
        # second start return before the runner enters any transport.
        self._ready = asyncio.Event()
        self._stop = asyncio.Event()
        self._start_error = None
        self._exit_stack = contextlib.AsyncExitStack()
        for stale in [n for n in self._server_status if n not in servers]:
            del self._server_status[stale]
        for server_name in servers:
            self._server_status[server_name] = {"status": "starting", "tool_count": 0, "error": None}
        # The runner owns the exit stack; transports are entered AND exited in
        # this task, avoiding anyio's cross-task cancel-scope error.
        self._runner = asyncio.create_task(self._run(servers))
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=self._startup_timeout)
        except TimeoutError:
            # Overall budget exhausted. Best-effort skip-and-continue: tear
            # the runner down (closes any half-open transports via the exit
            # stack finally), mark non-terminal servers unavailable, and
            # return so the app stays usable without MCP. Matches the
            # per-server "failed + continue" design in ``_run``.
            logger.warning(
                "MCP startup timed out after %.1fs; continuing with reduced MCP availability",
                self._startup_timeout,
            )
            await self._await_runner()
            for _name, status in self._server_status.items():
                if status["status"] not in ("connected", "failed"):
                    status["status"] = "unavailable"
                    status["error"] = f"startup timed out after {self._startup_timeout:.0f}s"
            # Transports were torn down by ``_await_runner``; drop dead session
            # handles so ``call_tool``/``read_resource`` report cleanly. Explicitly
            # close each session first to avoid a teardown race with later
            # transport cleanup; otherwise orphaned sessions/transport handles
            # can resurface during ``shutdown``. Clear ``_tools`` too so we
            # don't keep advertising dead tool entries to the LLM.
            if self._sessions:
                await asyncio.gather(
                    *[_close_session(s) for s in self._sessions.values() if s is not None],
                    return_exceptions=True,
                )
            self._sessions.clear()
            self._tools.clear()
            self._uri_map.clear()
            return
        if self._start_error is not None:
            # Startup itself failed; ensure the runner has torn down.
            await self._await_runner()
            raise self._start_error

    async def _run(self, servers: dict[str, dict]) -> None:
        try:
            await self._exit_stack.__aenter__()
            for server_name, config in servers.items():
                try:
                    await self._start_server(server_name, config)
                    tool_count = sum(1 for k in self._tools if k.startswith(f"mcp::{server_name}::"))
                    if self._server_status[server_name]["status"] != "failed":
                        self._server_status[server_name] = {"status": "connected", "tool_count": tool_count, "error": None}
                except Exception as e:
                    self._server_status[server_name] = {
                        "status": "failed",
                        "tool_count": 0,
                        "error": f"{type(e).__name__}: {str(e)[:80]}",
                    }
                    logger.warning("Failed to start MCP server '%s'", server_name, exc_info=True)
        except BaseException as e:
            # Captured so start_all can re-raise after the runner unwinds.
            self._start_error = e
        finally:
            self._ready.set()
            # Idle until shutdown is requested, then close the stack in THIS
            # task — the same task that entered every transport.
            # Catch CancelledError so aclose() runs regardless — otherwise
            # the async generators (stdio_client, sse_client) dangle and
            # their finalizers later raise "exit cancel scope in a different
            # task" when the event loop runs shutdown_asyncgens.
            cancelled: bool = False
            try:
                await self._stop.wait()
            except asyncio.CancelledError:
                cancelled = True
            try:
                await self._exit_stack.aclose()
            except Exception:
                logger.warning("Error during MCP shutdown", exc_info=True)
            if cancelled:
                raise

    async def _await_runner(self, timeout: float = 3.0) -> None:
        self._stop.set()
        runner = self._runner
        if runner is not None:
            try:
                await asyncio.wait_for(runner, timeout=timeout)
            except TimeoutError:
                runner.cancel()
                logger.warning("MCP shutdown timed out after %.1fs, cancelling runner", timeout)
                try:
                    await runner
                except asyncio.CancelledError:
                    pass
            except Exception:
                logger.warning("MCP runner task ended with an error", exc_info=True)
        self._runner = None

    async def _start_server(self, server_name: str, config: dict) -> None:
        if not _MCP_SERVER_NAME_RE.match(server_name):
            logger.warning(
                "Skipping MCP server '%s': name does not match [a-z0-9-]+",
                server_name,
            )
            self._server_status[server_name] = {
                "status": "failed",
                "tool_count": 0,
                "error": "invalid server name (must match [a-z0-9-]+)",
            }
            return
        # Wrap the whole connect+initialize+enumerate sequence in one
        # per-server budget. Any hung RPC (or a slow transport
        # ``enter_async_context``) raises ``TimeoutError`` which propagates
        # to ``_run``'s ``except Exception`` -> server marked "failed" and
        # the loop continues. Transports already entered via ``self._exit_stack``
        # are torn down later by ``_run``'s ``finally`` -> ``aclose()``.
        try:
            async with asyncio.timeout(self._per_server_timeout):
                await self._connect_server(server_name, config)
        except TimeoutError as e:
            self._sessions.pop(server_name, None)
            prefix = f"mcp::{server_name}::"
            for k in [k for k in self._tools if k.startswith(prefix)]:
                del self._tools[k]
            for uri in [uri for uri, srv in self._uri_map.items() if srv == server_name]:
                del self._uri_map[uri]
            raise TimeoutError(
                f"MCP server '{server_name}' startup timed out after {self._per_server_timeout}s"
            ) from e

    async def _connect_server(self, server_name: str, config: dict) -> None:
        from stupidex.mcp.schema import convert_mcp_tool, make_mcp_executor

        if "url" in config:
            read_stream, write_stream = await self._exit_stack.enter_async_context(sse_client(url=config["url"]))
        else:
            server_params = StdioServerParameters(
                command=config["command"],
                args=config.get("args", []),
                env=config.get("env"),
            )
            read_stream, write_stream = await self._exit_stack.enter_async_context(stdio_client(server_params))

        session: ClientSession = await self._exit_stack.enter_async_context(ClientSession(read_stream, write_stream))
        await session.initialize()
        self._sessions[server_name] = session

        tools_result = await session.list_tools()
        for tool in tools_result.tools:
            registry_name, tool_obj = convert_mcp_tool(server_name, tool)
            if registry_name in self._tools:
                logger.warning(
                    "MCP tool '%s' from server '%s' shadows existing registration",
                    registry_name,
                    server_name,
                )
            self._tools[registry_name] = {
                "tool": tool_obj,
                "executor": make_mcp_executor(self.call_tool, server_name, tool.name),
            }

        resources_result = await session.list_resources()
        for resource in resources_result.resources:
            self._uri_map[str(resource.uri)] = server_name

    async def shutdown(self) -> None:
        await self._await_runner()
        self._sessions.clear()
        self._tools.clear()
        self._uri_map.clear()

    def get_tools(self) -> dict[str, dict]:
        return dict(self._tools)

    def get_server_statuses(self) -> dict[str, dict]:
        return dict(self._server_status)

    def get_resource_server(self, uri: str) -> str | None:
        return self._uri_map.get(uri)

    async def call_tool(self, server_name: str, tool_name: str, arguments: dict) -> ExecutorResult:
        session = self._sessions.get(server_name)
        if session is None:
            return ExecutorResult(
                display=f"MCP server '{server_name}' not available",
                content=f"Error: MCP server '{server_name}' is not connected.",
            )
        result = await session.call_tool(tool_name, arguments)
        text_parts: list[str] = []
        placeholders: list[str] = []
        for block in result.content:
            btype = getattr(block, "type", None)
            if btype == "text":
                text_parts.append(getattr(block, "text", ""))
            elif btype == "image":
                placeholders.append(f"[image: {getattr(block, 'mimeType', 'application/octet-stream')}]")
            elif btype == "resource":
                resource = getattr(block, "resource", None)
                uri = getattr(resource, "uri", None) if resource is not None else None
                placeholders.append(f"[embedded resource: {uri}]")
            else:
                placeholders.append(f"[{btype} block]")
        dropped_count = len(placeholders)
        if dropped_count:
            logger.warning(
                "MCP tool '%s' returned %d non-text blocks that were dropped",
                tool_name,
                dropped_count,
            )
        content = "\n".join([*text_parts, *placeholders])
        return ExecutorResult(display=content, content=content)

    async def read_resource(self, server_name: str, uri: str) -> ExecutorResult:
        session = self._sessions.get(server_name)
        if session is None:
            return ExecutorResult(
                display=f"MCP server '{server_name}' not available",
                content=f"Error: MCP server '{server_name}' is not connected.",
            )
        result = await session.read_resource(uri)  # type: ignore[arg-type]
        parts: list[str] = []
        for item in result.contents:
            if isinstance(item, TextResourceContents):
                parts.append(item.text)
            elif isinstance(item, BlobResourceContents):
                mime = getattr(item, "mimeType", None) or "application/octet-stream"
                parts.append(f"[binary resource: {mime}, {len(item.blob)} base64 chars]")
                logger.debug(
                    "MCP read_resource returned binary blob for '%s' (%s, %d base64 chars)",
                    uri,
                    mime,
                    len(item.blob),
                )
        content = "\n".join(parts)
        return ExecutorResult(display=content, content=content)
