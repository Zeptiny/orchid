"""Tests for read_mcp_resource tool (U7)."""
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from stupidex.domain.tool import ExecutorResult
from stupidex.tools.mcp_resource import execute_read_mcp_resource


class TestExecuteReadMCPResource(unittest.IsolatedAsyncioTestCase):
    async def test_happy_path(self):
        mock_manager = MagicMock()
        mock_manager.get_resource_server.return_value = "my-server"
        mock_manager.read_resource = AsyncMock(
            return_value=ExecutorResult(display="file contents", content="file contents")
        )

        with patch("stupidex.mcp.get_mcp_manager", return_value=mock_manager):
            result = await execute_read_mcp_resource("file:///tmp/test.txt")

        self.assertIsInstance(result, ExecutorResult)
        self.assertEqual(result.content, "file contents")
        mock_manager.get_resource_server.assert_called_once_with("file:///tmp/test.txt")
        mock_manager.read_resource.assert_awaited_once_with("my-server", "file:///tmp/test.txt")

    async def test_manager_not_initialized(self):
        with patch("stupidex.mcp.get_mcp_manager", return_value=None):
            result = await execute_read_mcp_resource("file:///tmp/test.txt")

        self.assertIsInstance(result, ExecutorResult)
        self.assertIn("MCP manager is not initialized", result.content)
        self.assertEqual(result.display, "MCP not available")

    async def test_uri_not_found(self):
        mock_manager = MagicMock()
        mock_manager.get_resource_server.return_value = None

        with patch("stupidex.mcp.get_mcp_manager", return_value=mock_manager):
            result = await execute_read_mcp_resource("file:///unknown.txt")

        self.assertIsInstance(result, ExecutorResult)
        self.assertIn("No MCP server found for URI", result.content)
        self.assertIn("file:///unknown.txt", result.content)
        self.assertEqual(result.display, "Resource not found")

    async def test_server_returns_error(self):
        mock_manager = MagicMock()
        mock_manager.get_resource_server.return_value = "my-server"
        mock_manager.read_resource = AsyncMock(side_effect=RuntimeError("connection refused"))

        with patch("stupidex.mcp.get_mcp_manager", return_value=mock_manager), self.assertRaises(RuntimeError):
            await execute_read_mcp_resource("file:///tmp/test.txt")


if __name__ == "__main__":
    unittest.main()
