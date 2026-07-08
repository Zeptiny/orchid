/**
 * MCP schemas — Zod schemas and types for MCP server configuration and status.
 *
 * Ported from src/orchid/mcp/schema.py and src/orchid/config.py.
 *
 * MCPServerConfig covers two transport types:
 * - Stdio: command + args + env (spawns a child process)
 * - SSE:   url + headers (connects to a remote SSE endpoint)
 *
 * MCPServerStatus tracks per-server lifecycle state:
 * - "starting":    initial state during startup
 * - "connected":   successfully initialized, tools enumerated
 * - "failed":      server startup failed (timeout, crash, bad config)
 * - "unavailable": overall startup budget exhausted before this server started
 */
import { z } from 'zod';
import type { MCPServerStatus, MCPServerStatusValue } from '../../shared/types/ipc-boundary';

export type { MCPServerStatus, MCPServerStatusValue } from '../../shared/types/ipc-boundary';

// ---------------------------------------------------------------------------
// Server name validation — matches Python `_MCP_SERVER_NAME_RE = r"^[a-z0-9-]+$"`
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME_RE = /^[a-z0-9-]+$/;

export function isValidServerName(name: string): boolean {
  return MCP_SERVER_NAME_RE.test(name);
}

// ---------------------------------------------------------------------------
// MCPServerConfig schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for an MCP server configuration entry.
 *
 * Discriminated by presence of "url" (SSE) vs "command" (stdio).
 * Accepts both shapes from the config file's `mcp_servers` record.
 */
export const mcpServerConfigSchema = z
  .object({
    /** Executable to spawn (stdio transport). */
    command: z.string().optional(),
    /** Command-line arguments (stdio transport). */
    args: z.array(z.string()).optional(),
    /** Extra environment variables (stdio transport). */
    env: z.record(z.string(), z.string()).optional(),
    /** Working directory (stdio transport). */
    cwd: z.string().optional(),
    /** SSE endpoint URL (SSE transport). Mutually exclusive with command. */
    url: z.string().url().optional(),
    /** Custom HTTP headers for SSE transport. */
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type MCPServerConfig = z.infer<typeof mcpServerConfigSchema>;
