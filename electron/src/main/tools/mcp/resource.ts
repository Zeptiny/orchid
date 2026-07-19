/**
 * read_mcp_resource tool — read a resource from an MCP server by URI.
 *
 * Ported from Python `src/orchid/tools/mcp_resource.py`.
 *
 * Looks up the server owning the URI via MCPManager.getResourceServer(),
 * then calls manager.readResource() to fetch the content.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { type GenericBuiltInToolOutcome } from '../result';
import { createDynamicToolOutcome } from '../../../shared/types/tool-result';
import type { MCPManager } from '../../mcp/manager';

/**
 * Result returned by the MCP resource tool handler.
 */
export type McpResourceResult = GenericBuiltInToolOutcome;

function mcpResourceOutcome(
  value: unknown,
  options: Parameters<typeof createDynamicToolOutcome>[3] = {},
): McpResourceResult {
  return createDynamicToolOutcome('read_mcp_resource', value, 'mcp', options);
}

/**
 * Build the read_mcp_resource tool.
 *
 * @param manager - MCPManager instance for resource reading
 */
export function buildMcpResourceTool(
  manager: MCPManager,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'read_mcp_resource',
    description:
      'Read a resource from an MCP server by URI. Use to access files, schemas, or other data exposed by MCP servers.',
    inputSchema: z.object({
      uri: z
        .string()
        .describe(
          "The URI of the MCP resource to read (e.g., 'file:///path/to/file')",
        ),
    }),
    actionLabel: 'Reading MCP resource...',
    category: 'mcp',
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<McpResourceResult> => {
    const { uri } = input as { uri: string };

    const serverName = manager.getResourceServer(uri);
    if (serverName === undefined) {
      return mcpResourceOutcome(`Error: No MCP server found for URI '${uri}'.`, {
        status: 'error',
        errorCode: 'mcp_resource_not_found',
        errorMessage: `Error: No MCP server found for URI '${uri}'.`,
      });
    }

    try {
      const content = await manager.readResource(serverName, uri, {
        signal: ctx?.abortSignal,
      });
      if (typeof content === 'string' && content.startsWith('Error:')) {
        return mcpResourceOutcome(content, {
          status: 'error',
          errorCode: 'mcp_resource_error',
          errorMessage: content,
        });
      }
      return mcpResourceOutcome({ uri, content }, { status: 'complete' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return mcpResourceOutcome(`Error reading MCP resource: ${message}`, {
        status: 'error',
        errorCode: 'mcp_resource_error',
        errorMessage: `Error reading MCP resource: ${message}`,
      });
    }
  };

  return { definition, handler };
}
