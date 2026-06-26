"""Minimal example MCP server demonstrating tool + resource usage.

A reference implementation for testing and learning. Not intended for production.
Demonstrates the MCP server structure: tool registration, resource exposure, and
stdio transport. For real MCP servers, see the official MCP server implementations
at https://github.com/modelcontextprotocol/servers.

Run standalone: python -m stupidex.mcp.example_server
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable

from mcp.server.lowlevel import Server
from mcp.server.lowlevel.helper_types import ReadResourceContents
from mcp.server.stdio import stdio_server
from mcp.types import Resource, TextContent, Tool
from pydantic import AnyUrl

server = Server("stupidex-example")


@server.list_tools()
async def list_tools() -> list[Tool]:
    """Return the list of tools this server exposes. Called by the MCP framework during tool discovery."""
    return [
        Tool(
            name="echo",
            description="Echoes the input message back to the caller",
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "The message to echo"},
                },
                "required": ["message"],
            },
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Handle a tool invocation. Called by the MCP framework when an agent calls a tool."""
    if name == "echo":
        return [TextContent(type="text", text=arguments["message"])]
    raise ValueError(f"Unknown tool: {name}")


@server.list_resources()
async def list_resources() -> list[Resource]:
    """Return the list of readable resources this server exposes. Called during resource discovery."""
    return [
        Resource(
            uri=AnyUrl("example://stupidex"),
            name="App Info",
            description="Basic information about the stupidex application",
            mimeType="text/plain",
        )
    ]


@server.read_resource()
async def read_resource(uri: AnyUrl) -> Iterable[ReadResourceContents]:
    """Read a resource by URI. Called by the MCP framework when an agent requests a resource."""
    if str(uri) == "example://stupidex":
        return [ReadResourceContents(
            content="stupidex is a coding CLI with MCP support",
            mime_type="text/plain",
        )]
    raise ValueError(f"Unknown resource: {uri}")


async def _run() -> None:
    async with stdio_server() as (read_stream, write_stream):
        init_options = server.create_initialization_options()
        await server.run(read_stream, write_stream, init_options)


if __name__ == "__main__":
    asyncio.run(_run())
