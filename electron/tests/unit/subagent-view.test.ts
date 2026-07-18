import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SubagentRecord } from '../../src/shared/types/subagent';
import {
  chooseNewestSubagent,
  keepSubagentRowSelected,
  resolveSubagentOpenRequest,
  SubagentView,
} from '../../src/renderer/components/SubagentView';

function record(id: string, status: SubagentRecord['status'], start_time: string): SubagentRecord {
  return {
    id, agent_name: id, agent_type: 'worker', agent_tier: 'bloom', task: `Task ${id}`,
    status, chain_id: `${id}-chain`, start_time, end_time: status === 'running' ? null : start_time,
    result: null, error: null, parentChainIndex: null, chain: { messages: [] } as SubagentRecord['chain'],
  };
}

describe('SubagentView', () => {
  it('chooses the newest running record before ended records', () => {
    expect(chooseNewestSubagent([
      record('ended', 'completed', '2026-01-01T00:05:00.000Z'),
      record('running', 'running', '2026-01-01T00:01:00.000Z'),
      record('pending-newest', 'pending', '2026-01-01T00:02:00.000Z'),
    ])).toBe('pending-newest');
  });

  it('renders explicit status text, groups, metadata controls, and recovery labels', () => {
    const state = {
      status: 'ready' as const,
      subagents: [record('running', 'running', '2026-01-01T00:01:00.000Z')],
    };
    const html = renderToStaticMarkup(createElement(SubagentView, {
      subagents: {
        state, subagents: state.subagents, groups: { running: state.subagents, ended: [] },
        totalUsage: null, usageByParentChain: new Map(), refresh: async () => {}, retry: async () => {},
        isRetrying: false, applyFromSession: () => {}, selectedId: 'running', select: () => {},
        getDetail: () => ({ id: 'running', name: 'running', type: 'worker', tier: 'bloom', state: 'running', task: 'Task running', elapsed: '1s', isRunning: true, result: null, error: null, usage: null }),
        live: new Map(), getLive: () => null,
      },
      onBackToChat: () => {},
      openRequest: { generation: 1, id: 'running' },
    }));
    expect(html).toContain('Running');
    expect(html).toContain('Ended');
    expect(html).toContain('running');
    expect(html).toContain('Back to chat');
    expect(html).not.toContain('Retry');
  });

  it('keeps general opens on the list and row opens on the requested detail', () => {
    const records = [record('newest', 'running', '2026-01-01T00:02:00.000Z'), record('ended', 'completed', '2026-01-01T00:01:00.000Z')];
    expect(resolveSubagentOpenRequest({ generation: 1, id: null }, records)).toEqual({ selectedId: 'newest', narrowDetail: false });
    expect(resolveSubagentOpenRequest({ generation: 2, id: 'ended' }, records)).toEqual({ selectedId: 'ended', narrowDetail: true });
  });

  it('does not toggle the selected row off when clicked again', () => {
    expect(keepSubagentRowSelected('same', 'same')).toBe('same');
    expect(keepSubagentRowSelected('other', 'same')).toBe('same');
  });

  it('uses a component query and preserves the mounted chat subtree contract', () => {
    const styles = readFileSync(new URL('../../src/renderer/styles/components.css', import.meta.url), 'utf8');
    const chat = readFileSync(new URL('../../src/renderer/components/ChatView.tsx', import.meta.url), 'utf8');
    const view = readFileSync(new URL('../../src/renderer/components/SubagentView.tsx', import.meta.url), 'utf8');
    expect(styles).toMatch(/@container \(min-width: 720px\)/);
    expect(styles).toMatch(/@container \(max-width: 719px\)/);
    expect(styles).toMatch(/\.orchid-subagent-view-groups\s*\{[\s\S]*?flex: 1 1 auto;[\s\S]*?overflow-y: auto;/);
    expect(styles).not.toMatch(/orchid-subagent-view-actions/);
    expect(view).toMatch(/state\.status === 'error'[\s\S]*Retry/);
    expect(chat).toMatch(/orchid-chat-content-preserved/);
    expect(chat).toMatch(/setAttribute\('inert'/);
    expect(chat).toMatch(/aria-hidden/);
  });
});
