/**
 * Transport creation — stdio and SSE transport factories for MCP.
 *
 * Ported from src/orchid/mcp/__init__.py (_connect_server transport branch).
 *
 * Creates the appropriate MCP SDK transport based on server config:
 * - StdioClientTransport: spawns a child process, communicates via stdin/stdout
 * - SSEClientTransport: connects to a remote SSE endpoint with optional headers
 *
 * Note: SSEClientTransport is deprecated upstream in favor of StreamableHTTPClientTransport.
 * We keep SSE support because many MCP servers still use it.
 */
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPServerConfig } from './schema';

// Re-export for testability
export { StdioClientTransport, SSEClientTransport };
export type { Transport };

/**
 * Create a transport instance for the given MCP server configuration.
 *
 * Determines transport type by config shape:
 * - Has `url` → SSE transport
 * - Has `command` (or neither) → Stdio transport
 *
 * @param config - Parsed MCP server configuration.
 * @returns A Transport instance ready to be passed to Client.connect().
 */
export function createTransport(config: MCPServerConfig): Transport {
  if (config.url) {
    return new SSEClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  }

  // Stdio transport (default)
  return new StdioClientTransport({
    command: config.command ?? '',
    args: config.args,
    env: config.env as Record<string, string> | undefined,
    cwd: config.cwd,
  });
}
