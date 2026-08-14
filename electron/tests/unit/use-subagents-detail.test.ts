import { describe, expect, it } from 'vitest';
import type { Usage } from '../../src/shared/types/message';
import type { SubagentLiveProjection, SubagentSummary } from '../../src/shared/types/subagent';
import { buildSubagentDetail } from '../../src/renderer/hooks/useSubagents';

const durableUsage: Usage = {
  prompt_tokens: 10,
  cached_tokens: 2,
  completion_tokens: 3,
  total_tokens: 13,
  reasoning_tokens: 0,
};

const liveUsage: Usage = {
  prompt_tokens: 40,
  cached_tokens: 8,
  completion_tokens: 12,
  total_tokens: 52,
  reasoning_tokens: 0,
};

function record(status: SubagentSummary['status']): SubagentSummary {
  return {
    id: 'subagent-1',
    agent_name: 'Explore codebase',
    agent_type: 'explorer',
    agent_tier: 'bloom',
    agentRole: 'explorer',
    task: 'Inspect the project',
    status,
    chain_id: 'chain-1',
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: status === 'completed' ? '2026-01-01T00:00:05.000Z' : null,
    parentChainIndex: null,
    usage: durableUsage,
  };
}

function projection(
  usage: Usage | null,
  state: SubagentLiveProjection['state'] = 'running',
): SubagentLiveProjection {
  return {
    sessionId: 'session-1',
    subagentId: 'subagent-1',
    runId: 'run-1',
    sequence: 2,
    state,
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

describe('subagent detail display state', () => {
  it('reads state from the live projection while the frozen record still says pending', () => {
    // Delta path: the record only changes on spawned/terminal, so a running
    // subagent can sit on a pending record. The badge must follow the live
    // projection, matching the snapshot path.
    const detail = buildSubagentDetail(
      record('pending'),
      Date.parse('2026-01-01T00:00:04.000Z'),
      projection(liveUsage, 'running'),
    );

    expect(detail.state).toBe('running');
    expect(detail.isRunning).toBe(true);
  });

  it('falls back to the durable record status when no live projection is present', () => {
    const detail = buildSubagentDetail(
      record('pending'),
      Date.parse('2026-01-01T00:00:04.000Z'),
      null,
    );

    expect(detail.state).toBe('pending');
    expect(detail.isRunning).toBe(true);
  });

  it('treats a queued live projection as not running', () => {
    const detail = buildSubagentDetail(
      record('queued'),
      Date.parse('2026-01-01T00:00:04.000Z'),
      projection(null, 'queued'),
    );

    expect(detail.state).toBe('queued');
    expect(detail.isRunning).toBe(false);
  });
});
