/**
 * Code-owned recommended MCP servers offered during first-run onboarding.
 *
 * Not installed by default — users opt in by selecting entries. Extend this
 * list to surface additional recommendations; Settings remains free-form.
 */

export interface RecommendedMcpServer {
  /** Config key / server name (`^[a-z0-9-]+$`). */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Payload stored under `mcp_servers[id]` when selected. */
  readonly config: Readonly<Record<string, unknown>>;
}

export const RECOMMENDED_MCP_SERVERS: readonly RecommendedMcpServer[] = [
  {
    id: 'context7',
    title: 'Context7',
    description: 'Up-to-date library docs and code examples for common frameworks.',
    config: {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    },
  },
] as const;

/** Build a partial `mcp_servers` map from selected recommended ids. */
export function selectedRecommendedMcpServers(
  selectedIds: readonly string[],
): Record<string, Record<string, unknown>> {
  const selected = new Set(selectedIds);
  const result: Record<string, Record<string, unknown>> = {};
  for (const entry of RECOMMENDED_MCP_SERVERS) {
    if (!selected.has(entry.id)) continue;
    result[entry.id] = { ...entry.config };
  }
  return result;
}
