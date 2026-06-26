from __future__ import annotations

from collections.abc import Callable
from typing import Any

from stupidex.domain.tool import ExecutorResult, Tool, ToolParameter, ToolParameterProperties


def convert_mcp_tool(server_name: str, mcp_tool: Any) -> tuple[str, Tool]:
    """Convert an MCP tool definition into the internal Tool domain model.

    Args:
        server_name: Name of the MCP server the tool belongs to.
        mcp_tool: MCP tool object with `.name`, `.description`, and `.inputSchema`.

    Returns:
        Tuple of (registry_name, Tool) where registry_name is
        ``mcp::{server_name}::{tool_name}``.
    """
    tool_name: str = mcp_tool.name
    description: str = mcp_tool.description or ""
    input_schema: dict[str, Any] = mcp_tool.inputSchema or {}

    registry_name = f"mcp::{server_name}::{tool_name}"

    properties: dict[str, ToolParameterProperties] = {}
    for param_name, param_schema in input_schema.get("properties", {}).items():
        properties[param_name] = ToolParameterProperties(
            type=param_schema.get("type", ""),
            description=param_schema.get("description", ""),
            items=param_schema.get("items"),
        )

    required: list[str] = input_schema.get("required", [])

    tool = Tool(
        name=registry_name,
        description=description,
        parameters=ToolParameter(
            properties=properties,
            required=required,
            type=input_schema.get("type", "object"),
        ),
    )

    return registry_name, tool


def make_mcp_executor(
    call_tool_fn: Callable[..., Any],
    server_name: str,
    tool_name: str,
) -> Callable[..., Any]:
    """Create an async executor that delegates to an MCP server tool.

    Args:
        call_tool_fn: Callable with signature
            ``(server_name, tool_name, arguments) -> ExecutorResult``,
            typically ``MCPManager.call_tool``.
        server_name: Registered name of the MCP server.
        tool_name: Original (un-prefixed) tool name on the server.

    Returns:
        Async function ``execute(**kwargs) -> ExecutorResult``.
    """

    async def execute(**kwargs: Any) -> ExecutorResult:
        return await call_tool_fn(server_name, tool_name, kwargs)

    return execute
