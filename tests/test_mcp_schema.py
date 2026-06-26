"""Tests for MCP schema conversion (U7)."""
import inspect
import unittest
from unittest.mock import AsyncMock

from stupidex.domain.tool import ExecutorResult
from stupidex.mcp.schema import convert_mcp_tool, make_mcp_executor


class _FakeMCPTool:
    def __init__(self, name: str, description: str, input_schema: dict):
        self.name = name
        self.description = description
        self.inputSchema = input_schema


class TestConvertMCPTool(unittest.TestCase):
    def test_simple_string_params(self):
        mcp_tool = _FakeMCPTool(
            name="greet",
            description="Say hello",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Person's name"},
                },
                "required": ["name"],
            },
        )
        registry_name, tool = convert_mcp_tool("myserver", mcp_tool)

        self.assertEqual(registry_name, "mcp::myserver::greet")
        self.assertEqual(tool.name, "mcp::myserver::greet")
        self.assertEqual(tool.description, "Say hello")
        self.assertIn("name", tool.parameters.properties)
        self.assertEqual(tool.parameters.properties["name"].type, "string")
        self.assertEqual(tool.parameters.properties["name"].description, "Person's name")
        self.assertEqual(tool.parameters.required, ["name"])

    def test_nested_object_params(self):
        mcp_tool = _FakeMCPTool(
            name="create_user",
            description="Create a user",
            input_schema={
                "type": "object",
                "properties": {
                    "user": {
                        "type": "object",
                        "description": "User object",
                    },
                },
                "required": ["user"],
            },
        )
        _, tool = convert_mcp_tool("srv", mcp_tool)

        self.assertIn("user", tool.parameters.properties)
        self.assertEqual(tool.parameters.properties["user"].type, "object")
        self.assertEqual(tool.parameters.properties["user"].description, "User object")

    def test_enum_params_type_preserved(self):
        mcp_tool = _FakeMCPTool(
            name="set_mode",
            description="Set mode",
            input_schema={
                "type": "object",
                "properties": {
                    "mode": {
                        "type": "string",
                        "description": "Mode to set",
                        "enum": ["fast", "slow"],
                    },
                },
                "required": ["mode"],
            },
        )
        _, tool = convert_mcp_tool("srv", mcp_tool)

        self.assertEqual(tool.parameters.properties["mode"].type, "string")
        self.assertEqual(tool.parameters.properties["mode"].description, "Mode to set")

    def test_registry_name_format(self):
        mcp_tool = _FakeMCPTool(name="tool1", description="", input_schema={})
        registry_name, _ = convert_mcp_tool("server_a", mcp_tool)
        self.assertEqual(registry_name, "mcp::server_a::tool1")

    def test_empty_input_schema(self):
        mcp_tool = _FakeMCPTool(name="noop", description="Does nothing", input_schema={})
        _, tool = convert_mcp_tool("srv", mcp_tool)

        self.assertEqual(tool.parameters.properties, {})
        self.assertEqual(tool.parameters.required, [])
        self.assertEqual(tool.parameters.type, "object")

    def test_array_param_with_items(self):
        mcp_tool = _FakeMCPTool(
            name="batch",
            description="Batch op",
            input_schema={
                "type": "object",
                "properties": {
                    "ids": {
                        "type": "array",
                        "description": "List of IDs",
                        "items": {"type": "string"},
                    },
                },
                "required": [],
            },
        )
        _, tool = convert_mcp_tool("srv", mcp_tool)

        self.assertEqual(tool.parameters.properties["ids"].type, "array")
        self.assertEqual(tool.parameters.properties["ids"].items, {"type": "string"})


class TestMakeMCPExecutor(unittest.IsolatedAsyncioTestCase):
    def test_returns_async_callable(self):
        mock_call = AsyncMock(return_value=ExecutorResult(display="ok", content="ok"))
        executor = make_mcp_executor(mock_call, "myserver", "greet")

        self.assertTrue(inspect.iscoroutinefunction(executor))

    async def test_executor_forwards_to_call_tool_fn(self):
        mock_call = AsyncMock(return_value=ExecutorResult(display="hi", content="hi"))
        executor = make_mcp_executor(mock_call, "myserver", "greet")

        result = await executor(name="world")

        mock_call.assert_awaited_once_with("myserver", "greet", {"name": "world"})
        self.assertEqual(result.display, "hi")
        self.assertEqual(result.content, "hi")

    async def test_executor_with_empty_kwargs(self):
        mock_call = AsyncMock(return_value=ExecutorResult(display="done", content="done"))
        executor = make_mcp_executor(mock_call, "srv", "noop")

        result = await executor()

        mock_call.assert_awaited_once_with("srv", "noop", {})
        self.assertEqual(result.content, "done")


if __name__ == "__main__":
    unittest.main()
