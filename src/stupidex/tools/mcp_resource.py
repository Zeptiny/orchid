from stupidex.domain.tool import ExecutorResult, Tool, ToolParameter, ToolParameterProperties

read_mcp_resource_tool = Tool(
    name="read_mcp_resource",
    description="Read a resource from an MCP server by URI. Use to access files, schemas, or other data exposed by MCP servers.",
    parameters=ToolParameter(
        properties={
            "uri": ToolParameterProperties(
                type="string",
                description="The URI of the MCP resource to read (e.g., 'file:///path/to/file')"
            ),
        },
        required=["uri"]
    ),
    action_label="Reading MCP resource...",
)


async def execute_read_mcp_resource(uri: str) -> ExecutorResult:
    from stupidex.mcp import get_mcp_manager

    manager = get_mcp_manager()
    if manager is None:
        return ExecutorResult(display="MCP not available", content="Error: MCP manager is not initialized.")
    server_name = manager.get_resource_server(uri)
    if server_name is None:
        return ExecutorResult(display="Resource not found", content=f"Error: No MCP server found for URI '{uri}'.")
    return await manager.read_resource(server_name, uri)
