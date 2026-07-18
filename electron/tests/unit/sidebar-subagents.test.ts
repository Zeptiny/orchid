import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SubagentRecord } from '../../src/shared/types/subagent';
import {
  partitionSubagentsByStatus,
  SubagentsSection,
} from '../../src/renderer/components/Sidebar';

function subagent(id: string, status: SubagentRecord['status']): SubagentRecord {
  return {
    id,
    agent_name: id,
    agent_type: 'subagent',
    agent_tier: 'bloom',
    task: '',
    status,
    chain_id: `${id}-chain`,
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: null,
    result: null,
    error: null,
    parentChainIndex: null,
    chain: {} as SubagentRecord['chain'],
  };
}

describe('subagent sidebar grouping', () => {
  it('keeps pending and running agents visible and groups terminal agents', () => {
    const groups = partitionSubagentsByStatus([
      subagent('completed-agent', 'completed'),
      subagent('running-agent', 'running'),
      subagent('pending-agent', 'pending'),
      subagent('failed-agent', 'failed'),
    ]);

    expect(groups.running.map((agent) => agent.id)).toEqual([
      'running-agent',
      'pending-agent',
    ]);
    expect(groups.other.map((agent) => agent.id)).toEqual([
      'completed-agent',
      'failed-agent',
    ]);
  });

  it('does not classify interrupted agents as running', () => {
    const groups = partitionSubagentsByStatus([subagent('interrupted-agent', 'interrupted')]);

    expect(groups.running).toHaveLength(0);
    expect(groups.other.map((agent) => agent.id)).toEqual(['interrupted-agent']);
  });

  it('renders active rows first and hides other rows behind the dropdown', () => {
    const html = renderToStaticMarkup(
      createElement(SubagentsSection, {
        state: {
          status: 'ready',
          subagents: [
            subagent('completed-agent', 'completed'),
            subagent('running-agent', 'running'),
          ],
        },
        onRefresh: () => {},
        selectedId: null,
        onSelect: () => {},
        getDetail: () => null,
      }),
    );

    expect(html.indexOf('running-agent')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('running-agent')).toBeLessThan(html.indexOf('Other agents'));
    expect(html).toContain('Show 1 other agent');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('btn btn-ghost btn-xs');
    expect(html).toContain('orchid-subagent-dropdown-flow');
    expect(html).toContain('View all');
    expect(html).toContain('Open in Subagent View');
    expect(html).not.toContain('completed-agent');
  });

  it('keeps the expanded menu in the parent collapse layout', () => {
    const styles = readFileSync(
      new URL('../../src/renderer/styles/components.css', import.meta.url),
      'utf8',
    );

    expect(styles).toMatch(
      /\.orchid-subagent-dropdown-flow\s*>\s*\.dropdown-content\s*\{[\s\S]*?position:\s*static;/,
    );
  });
});
