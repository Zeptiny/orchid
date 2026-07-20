import { describe, expect, it } from 'vitest';
import type { Usage } from '../../src/shared/types/message';
import type { SubagentLiveProjection, SubagentRecord } from '../../src/shared/types/subagent';
import { buildSubagentDetail } from '../../src/renderer/hooks/useSubagents';

const durableUsage: Usage = {
  prompt_tokens: 10,
  cached_tokens: 2,
  completion_tokens: 3,
  total_tokens: 13,
};

const liveUsage: Usage = {
  prompt_tokens: 40,
  cached_tokens: 8,
  completion_tokens: 12,
  total_tokens: 52,
};

function record(status: SubagentRecord['status']): SubagentRecord {
  return {
    id: 'subagent-1',
    agent_name: 'Explore codebase',
    agent_type: 'explorer',
    agent_tier: 'bloom',
    task: 'Inspect the project',
    status,
    chain_id: 'chain-1',
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: status === 'completed' ? '2026-01-01T00:00:05.000Z' : null,
    result: null,
    error: null,
    parentChainIndex: null,
    chain: {
      messages: [{ usage: durableUsage }],
    } as SubagentRecord['chain'],
  };
}

function projection(usage: Usage | null): SubagentLiveProjection {
  return {
    sessionId: 'session-1',
    subagentId: 'subagent-1',
    runId: 'run-1',
    sequence: 2,
    state: 'running',
    segments: [],
    toolCalls: [],
    usage,
    result: null,
    error: null,
  };
}

describe('subagent detail usage', () => {
  it('prefers incremental live usage while the subagent is running', () => {
    const detail = buildSubagentDetail(
      record('running'),
      Date.parse('2026-01-01T00:00:04.000Z'),
      projection(liveUsage),
    );

    expect(detail.usage).toEqual(liveUsage);
  });

  it('falls back to durable chain usage when no live usage is available', () => {
    const detail = buildSubagentDetail(
      record('completed'),
      Date.parse('2026-01-01T00:00:06.000Z'),
      null,
    );

    expect(detail.usage).toEqual(durableUsage);
  });
});
