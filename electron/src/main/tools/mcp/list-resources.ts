/**
 * list_mcp_resources tool — list resources exposed by connected MCP servers.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';
import type { MCPManager, MCPResourceInfo } from '../../mcp/manager';

/**
 * Result returned by the list_mcp_resources tool handler.
 */
export type ListMcpResourcesResult = GenericBuiltInToolOutcome;

/**
 * Build the list_mcp_resources tool.
 *
 * @param manager - MCPManager instance for resource listing
 */
export function buildListMcpResourcesTool(
  manager: MCPManager,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'list_mcp_resources',
    description:
      'List resources exposed by connected MCP servers. ' +
      'Returns URI, server name, and optional name/description for each resource. ' +
      'Use read_mcp_resource with a URI to fetch content.',
    inputSchema: z.object({}),
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
      return genericBuiltInToolOutcome('list_mcp_resources', `Error listing MCP resources: ${message}`, 'error');
    }

    if (resources.length === 0) {
      return genericBuiltInToolOutcome('list_mcp_resources', { resources: [] }, 'empty');
    }

    return genericBuiltInToolOutcome('list_mcp_resources', {
      resources: resources.map((resource) => ({
        uri: resource.uri,
        server: resource.server,
        ...(resource.name ? { name: resource.name } : {}),
        ...(resource.description ? { description: resource.description } : {}),
      })),
    }, 'complete');
  };

  return { definition, handler };
}
