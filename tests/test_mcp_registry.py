"""Tests for P1-19, P1-20, P1-21: MCP registry collisions, non-text blocks, blob resources.

P1-19: Registry name uses ``::`` delimiters so server/tool name collisions
(under the old ``mcp_{server}_{tool}`` scheme) cannot silently shadow each
other, plus a shadow guard logs a warning on duplicate registration.

P1-20: ``call_tool`` no longer silently drops non-text content blocks —
image and embedded-resource blocks become placeholder markers and a
warning is logged counting the dropped blocks.

P1-21: ``read_resource`` no longer joins raw base64 ``blob`` text into the
result — a readable placeholder is emitted instead.
"""
import logging
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch

from stupidex.mcp import MCPManager
from stupidex.mcp.schema import convert_mcp_tool


class _RecordingHandler(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def warnings_matching(self, needle: str) -> list[logging.LogRecord]:
        return [
            r for r in self.records
            if r.levelno >= logging.WARNING and needle in (r.getMessage() or "")
        ]


def _mcp_tool(name: str, description: str = "", schema: dict | None = None):
    return SimpleNamespace(
        name=name,
        description=description,
        inputSchema=schema or {},
    )


class TestRegistryNaming(unittest.TestCase):
    def test_registry_name_uses_colon_delimiter(self):
        registry_name, _ = convert_mcp_tool("my-server", _mcp_tool("search"))
        self.assertEqual(registry_name, "mcp::my-server::search")

    def test_collision_avoided_between_ambiguous_names(self):
        """`server="a", tool="b_c"` vs `server="a_b", tool="c"` must differ."""
        name_a, _ = convert_mcp_tool("a", _mcp_tool("b_c"))
        name_ab, _ = convert_mcp_tool("a_b", _mcp_tool("c"))
        self.assertNotEqual(name_a, name_ab)
        self.assertEqual(name_a, "mcp::a::b_c")
        self.assertEqual(name_ab, "mcp::a_b::c")

    def test_convert_mcp_tool_builds_tool_from_schema(self):
        schema = {
            "type": "object",
            "properties": {"q": {"type": "string", "description": "query"}},
            "required": ["q"],
        }
        registry_name, tool = convert_mcp_tool("srv", _mcp_tool("t", schema=schema))
        self.assertEqual(registry_name, "mcp::srv::t")
        self.assertEqual(tool.name, "mcp::srv::t")
        self.assertEqual(tool.parameters.required, ["q"])


class TestShadowWarning(unittest.IsolatedAsyncioTestCase):
    async def test_duplicate_registration_logs_warning(self):
        """Shadow guard (mcp/__init__.py:227-232) fires through the real
        ``_connect_server`` registration loop.

        Per P1-19 the ``mcp::{server}::{tool}`` scheme deliberately prevents
        collisions *across* different servers, so the shadow path can only be
        exercised by re-registering the same ``(server, tool)`` pair. Here the
        manager connects "srv1" a second time with a fresh fake session that
        advertises the same tool name "dup". The real body of
        ``_connect_server`` runs ``session.list_tools()``, the guard check,
        the ``logger.warning`` call, and the executor-overwriting dict
        assignment — the test never calls ``logger.warning`` directly, so
        deleting the guard breaks this test.
        """
        manager = MCPManager()
        handler = _RecordingHandler()
        logger = logging.getLogger("stupidex.mcp")
        logger.addHandler(handler)
        try:
            # Two fake sessions, each advertising a tool named "dup". The
            # second connection's session returns a distinguishable call
            # result so we can prove the second registration overwrote the
            # first via the real code path.
            session1 = _FakeSession(tool_names=["dup"])
            session2 = _FakeSession(
                tool_names=["dup"],
                call_result=_CallToolResult([
                    SimpleNamespace(type="text", text="from-session2"),
                ]),
            )

            @asynccontextmanager
            async def fake_stdio(params):
                # Transport handles are opaque to _connect_server; the fake
                # session ignores them.
                yield (SimpleNamespace(), SimpleNamespace())

            def session_cm(session_obj):
                @asynccontextmanager
                async def _cm(read, write):
                    yield session_obj
                return _cm

            config = {"command": "x", "args": []}

            # First registration: _connect_server lists "dup" and writes
            # manager._tools["mcp::srv1::dup"]. No prior entry -> no warning.
            with (
                patch("stupidex.mcp.stdio_client", side_effect=fake_stdio),
                patch("stupidex.mcp.ClientSession", side_effect=session_cm(session1)),
            ):
                await manager._connect_server("srv1", config)
            self.assertEqual(handler.warnings_matching("shadows existing registration"), [])

            # Second registration of the same (server, tool): the REAL guard
            # at line 227 fires before the dict assignment overwrites.
            with (
                patch("stupidex.mcp.stdio_client", side_effect=fake_stdio),
                patch("stupidex.mcp.ClientSession", side_effect=session_cm(session2)),
            ):
                await manager._connect_server("srv1", config)

            warnings = handler.warnings_matching("shadows existing registration")
            self.assertEqual(len(warnings), 1)
            self.assertIn("mcp::srv1::dup", warnings[0].getMessage())
            self.assertIn("srv1", warnings[0].getMessage())

            # The second connect's session displaced the first (current
            # behavior being characterized), and the registered executor —
            # built by the real ``make_mcp_executor`` in ``_connect_server`` —
            # now routes tool calls to session2.
            self.assertIs(manager._sessions["srv1"], session2)
            tool_entry = manager.get_tools()["mcp::srv1::dup"]
            result = await tool_entry["executor"]()
            self.assertEqual(result.content, "from-session2")
        finally:
            logger.removeHandler(handler)
            await manager.shutdown()


class TestInvalidServerName(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_server_name_is_skipped(self):
        manager = MCPManager()
        handler = _RecordingHandler()
        logger = logging.getLogger("stupidex.mcp")
        logger.addHandler(handler)
        try:
            # Avoid hitting the real transport; only the name guard matters here.
            with (
                patch("stupidex.mcp.stdio_client", side_effect=AssertionError("should not connect")),
            ):
                manager._per_server_timeout = 5.0
                manager._server_status["Bad_Name"] = {"status": "starting", "tool_count": 0, "error": None}
                await manager._start_server("Bad_Name", {"command": "x", "args": []})

            status = manager.get_server_statuses()["Bad_Name"]
            self.assertEqual(status["status"], "failed")
            self.assertIn("[a-z0-9-]+", status["error"])
            self.assertNotIn("Bad_Name", manager._sessions)
            self.assertGreater(len(handler.warnings_matching("does not match")), 0)
        finally:
            logger.removeHandler(handler)
            await manager.shutdown()


class _CallToolResult:
    def __init__(self, blocks):
        self.content = blocks


class _ReadResourceResult:
    def __init__(self, contents):
        self.contents = contents


class _FakeSession:
    def __init__(self, *, tool_names=(), call_result=None, read_result=None):
        self._tool_names = list(tool_names)
        self._call_result = call_result
        self._read_result = read_result

    async def initialize(self):
        return None

    async def list_tools(self):
        return SimpleNamespace(tools=[_mcp_tool(n) for n in self._tool_names])

    async def list_resources(self):
        return SimpleNamespace(resources=[])

    async def call_tool(self, tool_name, arguments):
        return self._call_result

    async def read_resource(self, uri):
        return self._read_result

    async def aclose(self):
        return None


class TestCallToolBlocks(unittest.IsolatedAsyncioTestCase):
    async def test_text_only_blocks_joined_no_warning(self):
        manager = MCPManager()
        handler = _RecordingHandler()
        logger = logging.getLogger("stupidex.mcp")
        logger.addHandler(handler)
        try:
            session = _FakeSession(call_result=_CallToolResult([
                SimpleNamespace(type="text", text="hello"),
                SimpleNamespace(type="text", text="world"),
            ]))
            manager._sessions["srv"] = session  # type: ignore[assignment]

            result = await manager.call_tool("srv", "t", {})
            self.assertEqual(result.content, "hello\nworld")
            self.assertEqual(result.display, "hello\nworld")
            self.assertEqual(handler.warnings_matching("non-text blocks"), [])
        finally:
            logger.removeHandler(handler)
            await manager.shutdown()

    async def test_mixed_blocks_text_plus_placeholders_and_warning(self):
        manager = MCPManager()
        handler = _RecordingHandler()
        logger = logging.getLogger("stupidex.mcp")
        logger.addHandler(handler)
        try:
            embedded_resource = SimpleNamespace(uri="file:///foo/bar.txt")
            session = _FakeSession(call_result=_CallToolResult([
                SimpleNamespace(type="text", text="payload"),
                SimpleNamespace(type="image", mimeType="image/png"),
                SimpleNamespace(type="resource", resource=embedded_resource),
            ]))
            manager._sessions["srv"] = session  # type: ignore[assignment]

            result = await manager.call_tool("srv", "mytool", {})
            self.assertIn("payload", result.content)
            self.assertIn("[image: image/png]", result.content)
            self.assertIn("[embedded resource: file:///foo/bar.txt]", result.content)

            warnings = handler.warnings_matching("non-text blocks")
            self.assertEqual(len(warnings), 1)
            # Two non-text blocks dropped.
            self.assertIn("2", warnings[0].getMessage())
            self.assertIn("mytool", warnings[0].getMessage())
        finally:
            logger.removeHandler(handler)
            await manager.shutdown()

    async def test_all_non_text_blocks_returns_placeholders(self):
        manager = MCPManager()
        handler = _RecordingHandler()
        logger = logging.getLogger("stupidex.mcp")
        logger.addHandler(handler)
        try:
            session = _FakeSession(call_result=_CallToolResult([
                SimpleNamespace(type="image", mimeType="image/jpeg"),
            ]))
            manager._sessions["srv"] = session  # type: ignore[assignment]

            result = await manager.call_tool("srv", "t", {})
            self.assertEqual(result.content, "[image: image/jpeg]")
            self.assertNotEqual(result.content, "")
            self.assertGreater(len(handler.warnings_matching("non-text blocks")), 0)
        finally:
            logger.removeHandler(handler)
            await manager.shutdown()


class TestReadResource(unittest.IsolatedAsyncioTestCase):
    async def test_text_resource_unchanged(self):
        from mcp.types import TextResourceContents

        manager = MCPManager()
        try:
            uri = "file:///notes.txt"
            session = _FakeSession(read_result=_ReadResourceResult([
                TextResourceContents(uri=uri, mimeType="text/plain", text="hello notes"),  # type: ignore[arg-type]
            ]))
            manager._sessions["srv"] = session  # type: ignore[assignment]

            result = await manager.read_resource("srv", uri)
            self.assertEqual(result.content, "hello notes")
            self.assertEqual(result.display, "hello notes")
        finally:
            await manager.shutdown()

    async def test_blob_resource_returns_placeholder_not_raw_base64(self):
        from mcp.types import BlobResourceContents

        manager = MCPManager()
        try:
            uri = "file:///blob.bin"
            raw_blob = "AAEC9fjaQw=="  # base64 — must NOT appear verbatim in output
            session = _FakeSession(read_result=_ReadResourceResult([
                BlobResourceContents(uri=uri, mimeType="image/png", blob=raw_blob),  # type: ignore[arg-type]
            ]))
            manager._sessions["srv"] = session  # type: ignore[assignment]

            result = await manager.read_resource("srv", uri)
            self.assertNotIn(raw_blob, result.content)
            self.assertIn("[binary resource: image/png", result.content)
            self.assertIn("base64 chars]", result.content)
            self.assertIn(str(len(raw_blob)), result.content)
        finally:
            await manager.shutdown()


if __name__ == "__main__":
    unittest.main()
