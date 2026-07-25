/**
 * Recommended MCP catalog — onboarding opt-in list.
 */
import { describe, it, expect } from 'vitest';
import {
  RECOMMENDED_MCP_SERVERS,
  selectedRecommendedMcpServers,
} from '../../src/shared/mcp/recommended-servers';

const SERVER_NAME = /^[a-z0-9-]+$/;

describe('recommended MCP servers', () => {
  it('includes context7 with the prior default npx payload', () => {
    const context7 = RECOMMENDED_MCP_SERVERS.find((entry) => entry.id === 'context7');
    expect(context7).toBeDefined();
    expect(context7!.config.command).toBe('npx');
    expect(context7!.config.args).toEqual(['-y', '@upstash/context7-mcp']);
  });

  it('uses valid server name ids', () => {
    expect(RECOMMENDED_MCP_SERVERS.length).toBeGreaterThan(0);
    for (const entry of RECOMMENDED_MCP_SERVERS) {
      expect(entry.id).toMatch(SERVER_NAME);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(Object.keys(entry.config).length).toBeGreaterThan(0);
    }
  });

  it('builds a mcp_servers map from selected ids only', () => {
    expect(selectedRecommendedMcpServers([])).toEqual({});
    expect(selectedRecommendedMcpServers(['unknown'])).toEqual({});

    const selected = selectedRecommendedMcpServers(['context7']);
    expect(Object.keys(selected)).toEqual(['context7']);
    expect(selected.context7).toEqual({
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    });
  });
});
