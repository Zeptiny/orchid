import { describe, expect, it } from 'vitest';
import type { Chain } from '../../src/shared/types/chain';
import {
  SubagentLiveProjectionStore,
  materializeProjectionTail,
} from '../../src/main/agents/subagent-live-projection';
import { SubagentRunAssembler } from '../../src/main/agents/subagent-run-assembler';

describe('SubagentLiveProjectionStore', () => {
  it('owns cloned run snapshots and rotates them for a fresh run', () => {
    const store = new SubagentLiveProjectionStore();

    store.start({
      subagentId: 'subagent-1',
      sessionId: 'session-1',
      state: 'pending',
      runId: 'run-1',
    });
    const first = store.get('subagent-1');
    const second = store.get('subagent-1');

    expect(first).not.toBe(second);
    expect(first?.segments).not.toBe(second?.segments);
    expect(second?.segments).toEqual([]);

    store.start({
      subagentId: 'subagent-1',
      sessionId: 'session-1',
      state: 'pending',
      runId: 'run-2',
    });

    expect(store.get('subagent-1')).toMatchObject({ runId: 'run-2', sequence: 0 });
  });

  it('tracks an explicit checkpoint and publishes monotonically ordered deltas', () => {
    const store = new SubagentLiveProjectionStore({
      now: () => 100,
      getUsageDeltaIntervalMs: () => 0,
    });
    const events: Array<{ type: string; sequence: number; sessionRevision: number }> = [];
    store.setOnDelta((event) => events.push(event));
    store.start({
      subagentId: 'subagent-1',
      sessionId: 'session-1',
      state: 'running',
      runId: 'run-1',
    });

    for (const applied of store.applyAssemblerEffects('subagent-1', [{
      type: 'append_text',
      kind: 'text',
      segmentId: 'segment-1',
      append: 'partial',
    }])) {
      applied.publish?.();
    }
    const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cached_tokens: 0 };
    for (const applied of store.applyAssemblerEffects('subagent-1', [{ type: 'usage', usage }])) {
      applied.publish?.();
    }

    expect(store.getCheckpoint('subagent-1')).toEqual({
      segments: [{ kind: 'text', id: 'segment-1', content: 'partial' }],
      committedSegmentCount: 0,
      usage,
    });
    expect(events.map(({ type, sequence, sessionRevision }) => ({ type, sequence, sessionRevision }))).toEqual([
      { type: 'text_delta', sequence: 1, sessionRevision: 1 },
      { type: 'usage', sequence: 2, sessionRevision: 2 },
    ]);

    const batched = store.applyAssemblerEffects('subagent-1', [
      { type: 'append_text', kind: 'thinking', segmentId: 'segment-2', append: 'thought' },
      { type: 'append_text', kind: 'text', segmentId: 'segment-3', append: 'answer' },
    ]);
    for (const applied of batched) applied.publish?.();

    expect(events.at(-2)?.sequence).toBeLessThan(events.at(-1)!.sequence);
  });

  it('advances the checkpoint cursor at a tool boundary so durable prefixes are not duplicated', () => {
    const store = new SubagentLiveProjectionStore();
    const subagentId = 'subagent-1';
    store.start({ subagentId, sessionId: 'session-1', state: 'running', runId: 'run-1' });

    store.applyAssemblerEffects(subagentId, [{
      type: 'append_text', kind: 'text', segmentId: 'text-before', append: 'before',
    }]);
    store.applyAssemblerEffects(subagentId, [{
      type: 'append_text', kind: 'thinking', segmentId: 'thinking-before', append: 'thought',
    }]);
    store.applyAssemblerEffects(subagentId, [{
      type: 'tool_start', toolCallId: 'tool-1', toolName: 'grep',
      segmentId: 'tool-before', startedAt: '2026-08-01T00:00:00.000Z',
    }]);
    store.applyAssemblerEffects(subagentId, [{
      type: 'tool_call', toolCallId: 'tool-1', toolName: 'grep', args: '{}',
      segmentId: 'tool-before', startedAt: '2026-08-01T00:00:00.000Z',
      messages: [], committedSegmentCount: 3,
    }]);
    store.applyAssemblerEffects(subagentId, [{
      type: 'append_text', kind: 'text', segmentId: 'text-after', append: 'after',
    }]);

    const checkpoint = store.getCheckpoint(subagentId)!;
    const durableChain = {
      messages: [{ content: 'before' }, { content: 'thought' }, { content: '' }],
    } as unknown as Chain;

    expect(checkpoint.committedSegmentCount).toBe(3);
    expect(materializeProjectionTail(checkpoint, durableChain).messages.map((message) => message.content))
      .toEqual(['before', 'thought', '', 'after']);
  });

  it('replaces an unknown live tool name when the full call follows an args delta', () => {
    const store = new SubagentLiveProjectionStore();
    const subagentId = 'subagent-1';
    const assembler = new SubagentRunAssembler([], {
      newId: () => 'tool-segment',
      now: () => '2026-08-01T00:00:00.000Z',
    });
    store.start({ subagentId, sessionId: 'session-1', state: 'running', runId: 'run-1' });

    store.applyAssemblerEffects(subagentId, assembler.accept({
      type: 'tool_call_delta', toolCallId: 'tool-1', argsDelta: '{"path":',
    }));
    expect(store.get(subagentId)?.toolCalls[0]).toMatchObject({ toolName: 'unknown', status: 'generating' });

    store.applyAssemblerEffects(subagentId, assembler.accept({
      type: 'tool_call', toolCallId: 'tool-1', toolName: 'read', args: '{"path":"README.md"}',
    }));

    expect(store.get(subagentId)?.toolCalls[0]).toMatchObject({
      toolName: 'read',
      status: 'running',
      args: '{"path":"README.md"}',
    });
  });

  it('projects compaction progress into the subagent stream keyed by subagent id (R27)', () => {
    const store = new SubagentLiveProjectionStore();
    store.start({ subagentId: 'subagent-1', sessionId: 'session-1', state: 'running', runId: 'run-1' });
    store.start({ subagentId: 'subagent-2', sessionId: 'session-1', state: 'running', runId: 'run-9' });
    const events: Array<{ type: string; subagentId: string; sequence: number }> = [];
    store.setOnDelta((event) => events.push(event as { type: string; subagentId: string; sequence: number }));

    store.emitCompactionProgress('subagent-1', {
      phase: 'preparing',
      detail: 'Summarizing history',
      mode: 'simple',
    });
    store.emitCompactionProgress('subagent-1', {
      phase: 'compacting',
      streamText: 'SUMMARY partial',
      estimatedTokens: 12,
    });
    store.emitCompactionProgress('subagent-2', { phase: 'preparing', mode: 'selective' });

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: 'compaction_progress',
      subagentId: 'subagent-1',
      sessionId: 'session-1',
      phase: 'preparing',
      detail: 'Summarizing history',
      mode: 'simple',
    });
    expect(events[1]).toMatchObject({
      type: 'compaction_progress',
      subagentId: 'subagent-1',
      phase: 'compacting',
      streamText: 'SUMMARY partial',
      estimatedTokens: 12,
    });
    expect(events[2]).toMatchObject({
      type: 'compaction_progress',
      subagentId: 'subagent-2',
      phase: 'preparing',
      mode: 'selective',
    });
    expect(events[0]!.sequence).toBeLessThan(events[1]!.sequence);

    // The latest progress is retained on the projection for the renderer.
    expect(store.get('subagent-1')?.compactionProgress).toMatchObject({
      type: 'compaction_progress',
      phase: 'compacting',
      streamText: 'SUMMARY partial',
    });
    expect(store.get('subagent-2')?.compactionProgress).toMatchObject({
      type: 'compaction_progress',
      phase: 'preparing',
      mode: 'selective',
    });
  });

  it('retains a terminal compaction phase until the next run or clear resets it', () => {
    const store = new SubagentLiveProjectionStore();
    store.start({ subagentId: 'subagent-1', sessionId: 'session-1', state: 'running', runId: 'run-1' });
    const events: Array<{ type: string; phase?: string }> = [];
    store.setOnDelta((event) => events.push(event as { type: string; phase?: string }));

    store.emitCompactionProgress('subagent-1', { phase: 'complete', detail: 'Context compacted — resuming' });
    expect(store.get('subagent-1')?.compactionProgress).toMatchObject({
      phase: 'complete',
      detail: 'Context compacted — resuming',
    });

    store.clearLiveTail('subagent-1');
    expect(store.get('subagent-1')?.compactionProgress).toBeNull();

    store.emitCompactionProgress('subagent-1', { phase: 'preparing' });
    store.start({ subagentId: 'subagent-1', sessionId: 'session-1', state: 'running', runId: 'run-2' });
    expect(store.get('subagent-1')?.compactionProgress).toBeNull();
  });
});
