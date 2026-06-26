"""Tests for the example MCP server's tool/resource handlers (P2-129)."""

import unittest

from mcp.types import TextContent
from pydantic import AnyUrl

from stupidex.mcp.example_server import call_tool, list_resources, list_tools, read_resource


class TestExampleServerCallTool(unittest.IsolatedAsyncioTestCase):
    async def test_echo_returns_message_verbatim(self):
        result = await call_tool("echo", {"message": "hello world"})

        self.assertEqual(len(result), 1)
        self.assertIsInstance(result[0], TextContent)
        self.assertEqual(result[0].text, "hello world")

    async def test_echo_empty_message_returns_empty_text(self):
        result = await call_tool("echo", {"message": ""})

        self.assertEqual(result[0].text, "")

    async def test_echo_missing_message_arg_raises_keyerror(self):
        with self.assertRaises(KeyError):
            await call_tool("echo", {})

    async def test_unknown_tool_raises_value_error(self):
        with self.assertRaises(ValueError):
            await call_tool("bogus", {"message": "x"})


class TestExampleServerListTools(unittest.IsolatedAsyncioTestCase):
    async def test_list_tools_exposes_echo(self):
        tools = await list_tools()

        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0].name, "echo")
        self.assertEqual(tools[0].inputSchema["required"], ["message"])


class TestExampleServerResources(unittest.IsolatedAsyncioTestCase):
    async def test_list_resources_exposes_app_info(self):
        resources = await list_resources()

        self.assertEqual(len(resources), 1)
        self.assertEqual(str(resources[0].uri), "example://stupidex")

    async def test_read_known_resource_returns_app_info(self):
        contents = await read_resource(AnyUrl("example://stupidex"))

        self.assertEqual(len(contents), 1)
        self.assertIn("stupidex", contents[0].content)

    async def test_read_unknown_resource_raises_value_error(self):
        with self.assertRaises(ValueError):
            await read_resource(AnyUrl("example://bogus"))


if __name__ == "__main__":
    unittest.main()
