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
export type { MCPServerStatus, MCPServerStatusValue } from '../../shared/types/ipc-boundary';

// ---------------------------------------------------------------------------
// Server name validation — matches Python `_MCP_SERVER_NAME_RE = r"^[a-z0-9-]+$"`
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME_RE = /^[a-z0-9-]+$/;

export function isValidServerName(name: string): boolean {
  return MCP_SERVER_NAME_RE.test(name);
}

// ---------------------------------------------------------------------------
// MCPServerConfig type
// ---------------------------------------------------------------------------

/**
 * Configuration consumed by the MCP transports.
 *
 * Runtime config validation is owned by the config loader; this module only
 * needs the structural type at its transport/manager boundaries.
 */
export interface MCPServerConfig {
  /** Executable to spawn (stdio transport). */
  command?: string;
  /** Command-line arguments (stdio transport). */
  args?: string[];
  /** Extra environment variables (stdio transport). */
  env?: Record<string, string>;
  /** Working directory (stdio transport). */
  cwd?: string;
  /** SSE endpoint URL (SSE transport). */
  url?: string;
  /** Custom HTTP headers for SSE transport. */
  headers?: Record<string, string>;
  /** Preserve unknown config keys accepted by the config document. */
  [key: string]: unknown;
}
