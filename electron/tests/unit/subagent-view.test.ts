import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SubagentRecord } from '../../src/shared/types/subagent';
import {
  formatSubagentUsage,
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
  it('formats usage exactly like the chain footer', () => {
    expect(formatSubagentUsage({
      prompt_tokens: 1_234,
      cached_tokens: 345,
      completion_tokens: 5_678,
      total_tokens: 6_912,
    })).toBe('in 1.2k cached 345 out 5.7k');
    expect(formatSubagentUsage(null)).toBe('in 0 cached 0 out 0');
  });

  it('keeps prompts collapsed and uses stats instead of prompts in list summaries', () => {
    const prompt = 'PROMPT SHOULD ONLY APPEAR IN THE COLLAPSE';
    const selectedRecord = {
      ...record('running', 'running', '2026-01-01T00:01:00.000Z'),
      agent_type: 'explorer',
      task: prompt,
    };
    const state = {
      status: 'ready' as const,
      subagents: [selectedRecord],
    };
    const html = renderToStaticMarkup(createElement(SubagentView, {
      subagents: {
        state, subagents: state.subagents, groups: { running: state.subagents, ended: [] },
        totalUsage: null, usageByParentChain: new Map(), refresh: async () => {}, retry: async () => {},
        isRetrying: false, applyFromSession: () => {}, selectedId: 'running', select: () => {},
        getDetail: () => ({
          id: 'running', name: 'running', type: 'Explorer', tier: 'bloom', state: 'running',
          task: prompt, elapsed: '1s', isRunning: true, result: null, error: null,
          usage: { prompt_tokens: 1_234, cached_tokens: 345, completion_tokens: 5_678, total_tokens: 6_912 },
        }),
        live: new Map(), getLive: () => null,
      },
      onBackToChat: () => {},
      openRequest: { generation: 1, id: 'running' },
    }));
    expect(html).toContain('Running');
    expect(html).toContain('Ended');
    expect(html).toContain('running');
    expect(html).toContain('Back to chat');
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('Prompt');
    expect(html.match(new RegExp(prompt, 'g'))).toHaveLength(1);
    expect(html).toContain('Elapsed 1s · in 1.2k cached 345 out 5.7k · Explorer');
    expect(html).toContain('<span>Explorer</span>');
    expect(html).not.toContain('<span>subagent</span>');
    expect(html).not.toContain('Inspect live and completed output for this session.');
    expect(html).not.toContain('Active-session output');
    expect(html).not.toContain('Retry');
  });

  it('keeps general opens on the list and row opens on the requested detail', () => {
    expect(resolveSubagentOpenRequest({ generation: 1, id: null })).toEqual({ selectedId: null, narrowDetail: false });
    expect(resolveSubagentOpenRequest({ generation: 2, id: 'ended' })).toEqual({ selectedId: 'ended', narrowDetail: true });
  });

  it('renders a 49-record unselected list at full width without a detail panel', () => {
    const records = Array.from({ length: 49 }, (_, index) =>
      record(`ended-${index}`, 'completed', `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`));
    const html = renderToStaticMarkup(createElement(SubagentView, {
      subagents: {
        state: { status: 'ready', subagents: records }, subagents: records,
        groups: { running: [], ended: records }, totalUsage: null,
        usageByParentChain: new Map(), refresh: async () => {}, retry: async () => {},
        isRetrying: false, applyFromSession: () => {}, selectedId: records[0].id, select: () => {},
        getDetail: () => null, live: new Map(), getLive: () => null,
      },
      onBackToChat: () => {},
      openRequest: { generation: 1, id: null },
    }));
    expect(html).toContain('orchid-subagent-view-container-single');
    expect(html.match(/class="orchid-subagent-view-row(?:\s|")/g)).toHaveLength(49);
    expect(html).not.toContain('aria-label="Subagent detail"');
  });

  it('renders recovery detail when a requested subagent is missing', () => {
    const html = renderToStaticMarkup(createElement(SubagentView, {
      subagents: {
        state: { status: 'ready', subagents: [] }, subagents: [],
        groups: { running: [], ended: [] }, totalUsage: null,
        usageByParentChain: new Map(), refresh: async () => {}, retry: async () => {},
        isRetrying: false, applyFromSession: () => {}, selectedId: null, select: () => {},
        getDetail: () => null, live: new Map(), getLive: () => null,
      },
      onBackToChat: () => {},
      openRequest: { generation: 1, id: 'missing-agent' },
    }));

    expect(html).toContain('aria-label="Subagent detail"');
    expect(html).toContain('Selected subagent is no longer available');
    expect(html).toContain('Back to list');
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
    expect(styles).toMatch(
      /\.orchid-subagent-view-container\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\);/,
    );
    expect(styles).toMatch(
      /\.orchid-subagent-view-container\s*>\s*div,[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*hidden;/,
    );
    expect(styles).toMatch(/\.orchid-subagent-view-groups\s*\{[\s\S]*?flex: 1 1 auto;[\s\S]*?overflow-y: auto;/);
    expect(styles).toMatch(
      /\.orchid-subagent-view-transcript\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow:\s*hidden;/,
    );
    expect(styles).toMatch(
      /\.orchid-subagent-view-container-single\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    );
    expect(styles).toMatch(
      /@container \(min-width: 720px\)[\s\S]*?grid-template-columns:\s*minmax\(220px,\s*0\.28fr\)\s*minmax\(0,\s*0\.72fr\);/,
    );
    expect(styles).toMatch(
      /\.orchid-subagent-view-list,[\s\S]*?\.orchid-subagent-view-detail\s*\{[\s\S]*?width:\s*100%;/,
    );
    expect(styles).not.toMatch(/orchid-subagent-view-actions/);
    expect(view).toMatch(/state\.status === 'error'[\s\S]*Retry/);
    expect(chat).toMatch(/orchid-chat-content-preserved/);
    expect(chat).toMatch(/setAttribute\('inert'/);
    expect(chat).toMatch(/aria-hidden/);
  });

  it('freezes the CSS-hidden chat presentation while subagents are shown and restores it in chat mode', () => {
    const chat = readFileSync(new URL('../../src/renderer/components/ChatView.tsx', import.meta.url), 'utf8');

    expect(chat).toMatch(/const\s+chatSurfaceVisible\s*=\s*isVisible\s*&&\s*contentMode\s*===\s*'chat'/);
    expect(chat).toMatch(
      /<DeferredSurface\s+isVisible=\{chatSurfaceVisible\}>\s*<ChatStream\s+isVisible=\{chatSurfaceVisible\}/,
    );
  });
});
