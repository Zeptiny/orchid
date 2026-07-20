import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SubagentRecord } from '../../src/shared/types/subagent';
import {
  countRunningSubagents,
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

  it('counts only pending and running agents for the section badge', () => {
    expect(countRunningSubagents([
      subagent('completed-agent', 'completed'),
      subagent('running-agent', 'running'),
      subagent('pending-agent', 'pending'),
      subagent('failed-agent', 'failed'),
    ])).toBe(2);
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
    expect(html).not.toContain('View all');
    expect(html).toContain('Open in Subagent View');
    expect(html).toContain('aria-label="Open running-agent in Subagent View"');
    expect(html).not.toMatch(/>Open in Subagent View<\/button>/);
    expect(html.indexOf('aria-label="Open running-agent in Subagent View"'))
      .toBeLessThan(html.indexOf('inspector-row-label mono truncate'));
    expect(html).not.toContain('completed-agent');
  });

  it('places the Subagent View action beside the collapse title', () => {
    const source = readFileSync(
      new URL('../../src/renderer/components/Sidebar.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('leadingAction={');
    expect(source).toContain('label="Open Subagent View"');
    expect(source).toContain('icon="maximize"');
    expect(source).toContain('onClick={() => onOpenSubagentView()}');
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

  it('uses chain-style input, cache, and output usage formatting', () => {
    const agent = { ...subagent('running-agent', 'running'), task: 'PROMPT MUST NOT APPEAR' };
    const html = renderToStaticMarkup(createElement(SubagentsSection, {
      state: { status: 'ready', subagents: [agent] },
      onRefresh: () => {},
      selectedId: agent.id,
      onSelect: () => {},
      getDetail: () => ({
        id: agent.id,
        name: agent.agent_name,
        type: 'Explorer',
        tier: agent.agent_tier,
        state: agent.status,
        task: agent.task,
        elapsed: '1s',
        isRunning: true,
        result: null,
        error: null,
        usage: {
          prompt_tokens: 1_234,
          cached_tokens: 345,
          completion_tokens: 5_678,
          total_tokens: 6_912,
        },
      }),
    }));

    expect(html).toContain('in 1.2k cached 345 out 5.7k');
    expect(html).toContain('elapsed 1s · Explorer · bloom');
    expect(html).not.toContain('PROMPT MUST NOT APPEAR');
  });
});
