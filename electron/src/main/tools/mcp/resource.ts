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
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';
import type { MCPManager } from '../../mcp/manager';

/**
 * Result returned by the MCP resource tool handler.
 */
export type McpResourceResult = GenericBuiltInToolOutcome;

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
      return genericBuiltInToolOutcome('read_mcp_resource', `Error: No MCP server found for URI '${uri}'.`, 'error');
    }

    try {
      const content = await manager.readResource(serverName, uri, {
        signal: ctx?.abortSignal,
      });
      if (typeof content === 'string' && content.startsWith('Error:')) {
        return genericBuiltInToolOutcome('read_mcp_resource', content, 'error');
      }
      return genericBuiltInToolOutcome('read_mcp_resource', content, 'complete');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return genericBuiltInToolOutcome('read_mcp_resource', `Error reading MCP resource: ${message}`, 'error');
    }
  };

  return { definition, handler };
}
