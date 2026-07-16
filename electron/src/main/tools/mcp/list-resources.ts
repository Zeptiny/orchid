/**
 * list_mcp_resources tool — list resources exposed by connected MCP servers.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import type { MCPManager, MCPResourceInfo } from '../../mcp/manager';

/**
 * Result returned by the list_mcp_resources tool handler.
 */
export interface ListMcpResourcesResult {
  display: string;
  content: string;
  isError?: boolean;
}

/**
 * Build the list_mcp_resources tool.
 *
 * @param manager - MCPManager instance for resource listing
 */
export function buildListMcpResourcesTool(
  manager: MCPManager,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'list_mcp_resources',
    description:
      'List resources exposed by connected MCP servers. ' +
      'Returns URI, server name, and optional name/description for each resource. ' +
      'Use read_mcp_resource with a URI to fetch content.',
    inputSchema: z.object({}),
    actionLabel: 'Listing MCP resources...',
    category: 'mcp',
  };

  const handler: ToolHandler = async (
    _input: unknown,
    _ctx,
  ): Promise<ListMcpResourcesResult> => {
    let resources: MCPResourceInfo[];
    try {
      resources = manager.listResources();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        display: 'MCP list error',
        content: `Error listing MCP resources: ${message}`,
        isError: true,
      };
    }

    if (resources.length === 0) {
      return {
        display: 'No MCP resources',
        content: 'No MCP resources available. Connect MCP servers that expose resources.',
      };
    }

    const lines = resources.map((r) => {
      const parts = [`uri=${r.uri}`, `server=${r.server}`];
      if (r.name) parts.push(`name=${r.name}`);
      if (r.description) parts.push(`description=${r.description}`);
      return parts.join(' | ');
    });

    return {
      display: `${resources.length} MCP resource(s)`,
      content: lines.join('\n'),
    };
  };

  return { definition, handler };
}
