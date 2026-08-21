import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildSubagentTranscriptItems,
  isVisibleSubagentMessage,
} from '../../src/renderer/components/SubagentTranscript';
import { MessageRole, MessageType, type Message } from '../../src/shared/types/message';
import type { Chain } from '../../src/shared/types/chain';
import type { SubagentLiveProjection, SubagentRecord } from '../../src/shared/types/subagent';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

const message = (overrides: Partial<Message>): Message => ({
  id: 'message', role: MessageRole.ASSISTANT, content: 'text', type: MessageType.TEXT,
  tool_calls: null, tool_call_id: null, name: null, thinking: null,
  timestamp: '2026-07-18T00:00:00.000Z', usage: null, hidden: false,
  tool_result: null,
  ...overrides,
});

const chain = (messages: Message[]): Chain => ({
  id: 'chain-1', sessionId: 'session-1', status: 'completed', messages,
  selection: null, modelLabel: null, agentName: 'worker', agentType: 'worker', agentTier: 'bloom',
  startTime: null, endTime: null, subagentRecord: null,
  errorDetail: null, errorTitle: null,
});

const record = (messages: Message[]): SubagentRecord => ({
  id: 'sub-1', agent_name: 'worker', agent_type: 'worker', agent_tier: 'bloom',
  task: 'inspect', status: 'running', chain_id: 'chain-1',
  start_time: '2026-07-18T00:00:00.000Z', end_time: null, result: null, error: null,
  parentChainIndex: null, chain: chain(messages),
});

const live = (segments: SubagentLiveProjection['segments']): SubagentLiveProjection => ({
  sessionId: 'session-1', subagentId: 'sub-1', runId: 'run-1', sequence: 3,
  state: 'running', segments, toolCalls: [], usage: null, result: null, error: null,
  compactionProgress: null,
});

const transcriptSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/SubagentTranscript.tsx'),
  'utf8',
);

describe('SubagentTranscript pure rendering contract (U4)', () => {
  it('keeps durable text/tool/result before the live text tail', () => {
    const items = buildSubagentTranscriptItems(
      record([
        message({ id: 'a', content: 'before' }),
        message({ id: 'call', role: MessageRole.ASSISTANT, type: MessageType.TOOL_CALL,
          content: '', tool_call_id: 'tool-1', name: 'read',
          tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
        message({ id: 'result', role: MessageRole.TOOL, type: MessageType.TOOL_RESULT,
          content: 'done', tool_call_id: 'tool-1', name: 'read',
          tool_result: createCanonicalToolResult('generic', {
            status: 'complete', data: { value: 'done' },
          }) }),
      ]),
      live([{ kind: 'text', id: 'live-1', content: 'after' }]),
    );
    expect(items.map((item) => item.kind)).toEqual(['message', 'tool', 'message']);
    expect(items.map((item) => item.kind === 'message' ? item.message.content : item.block.toolName))
      .toEqual(['before', 'read', 'after']);
  });

  it('retains canonical facts when reconstructing a live subagent tool block', () => {
    const canonical = createCanonicalToolResult('generic', {
      status: 'cancelled',
      data: { value: 'cancelled projection' },
    });
    const projection = live([{ kind: 'tool', id: 'segment-tool', toolCallId: 'tool-1' }]);
    projection.toolCalls = [{
      toolCallId: 'tool-1',
      toolName: 'read',
      status: 'cancelled',
      partialArgs: '{}',
      args: '{}',
      content: 'cancelled projection',
      toolResult: canonical,
      startedAt: '2026-07-18T00:00:00.000Z',
      finishedAt: '2026-07-18T00:00:01.000Z',
    }];

    const items = buildSubagentTranscriptItems(record([]), projection);
    expect(items).toHaveLength(1);
    expect(items[0].kind === 'tool' && items[0].block.toolResult).toEqual(canonical);
    expect(items[0].kind === 'tool' && items[0].block.agentProjection).toBe('cancelled projection');
  });

  it('filters hidden/system messages and preserves thinking as a collapsible message', () => {
    expect(isVisibleSubagentMessage(message({ hidden: true }))).toBe(false);
    expect(isVisibleSubagentMessage(message({ role: MessageRole.SYSTEM }))).toBe(false);
    const items = buildSubagentTranscriptItems(record([
      message({ id: 'hidden', hidden: true }),
      message({ id: 'system', role: MessageRole.SYSTEM }),
      message({ id: 'thought', type: MessageType.THINKING, content: 'reasoning' }),
    ]), null);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('message');
    expect(items[0].kind === 'message' && items[0].message.type).toBe(MessageType.THINKING);
  });

  it('uses canonical status semantics for durable tool results', () => {
    const canonical = createCanonicalToolResult('generic', {
      status: 'error',
      data: { value: 'failed' },
      error: { code: 'tool_failed', message: 'failed' },
    });
    const items = buildSubagentTranscriptItems(record([
      message({ id: 'call', type: MessageType.TOOL_CALL, content: '', tool_call_id: 'tool-1',
        tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'exec', arguments: '{}' } }] }),
      message({ id: 'result', role: MessageRole.TOOL, type: MessageType.TOOL_RESULT,
        content: 'failed', tool_call_id: 'tool-1', name: 'exec', tool_result: canonical }),
    ]), null);
    expect(items).toHaveLength(1);
    expect(items[0].kind === 'tool' && items[0].block.status).toBe('failed');
    expect(items[0].kind === 'tool' && items[0].block.agentProjection).toBe('failed');
  });

  it('treats a persisted tool call without a result as completed like ChatStream', () => {
    const items = buildSubagentTranscriptItems(record([
      message({ id: 'call', type: MessageType.TOOL_CALL, content: '', tool_call_id: 'tool-1',
        tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'exec', arguments: '{}' } }] }),
    ]), null);
    expect(items[0].kind === 'tool' && items[0].block.status).toBe('completed');
    expect(items[0].kind === 'tool' && items[0].block.finishedAt).toBe('2026-07-18T00:00:00.000Z');
  });

  it('drops a live segment already committed by terminal handoff', () => {
    const items = buildSubagentTranscriptItems(
      record([message({ id: 'same', content: 'committed' })]),
      live([{ kind: 'text', id: 'same', content: 'committed' }, { kind: 'text', id: 'new', content: 'new' }]),
    );
    expect(items.filter((item) => item.kind === 'message').map((item) => item.kind === 'message' && item.message.id))
      .toEqual(['same', 'new']);
  });

  it('gives separated same-shaped activity groups unique identity-based keys', () => {
    const items = buildSubagentTranscriptItems(record([
      message({ id: 'call-a1', type: MessageType.TOOL_CALL, content: '', tool_call_id: 'tool-a1',
        tool_calls: [{ id: 'tool-a1', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
      message({ id: 'result-a1', role: MessageRole.TOOL, type: MessageType.TOOL_RESULT, content: 'a1', tool_call_id: 'tool-a1', name: 'read' }),
      message({ id: 'call-a2', type: MessageType.TOOL_CALL, content: '', tool_call_id: 'tool-a2',
        tool_calls: [{ id: 'tool-a2', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
      message({ id: 'result-a2', role: MessageRole.TOOL, type: MessageType.TOOL_RESULT, content: 'a2', tool_call_id: 'tool-a2', name: 'read' }),
      message({ id: 'separator', content: 'between' }),
      message({ id: 'call-b1', type: MessageType.TOOL_CALL, content: '', tool_call_id: 'tool-b1',
        tool_calls: [{ id: 'tool-b1', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
      message({ id: 'result-b1', role: MessageRole.TOOL, type: MessageType.TOOL_RESULT, content: 'b1', tool_call_id: 'tool-b1', name: 'read' }),
      message({ id: 'call-b2', type: MessageType.TOOL_CALL, content: '', tool_call_id: 'tool-b2',
        tool_calls: [{ id: 'tool-b2', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
      message({ id: 'result-b2', role: MessageRole.TOOL, type: MessageType.TOOL_RESULT, content: 'b2', tool_call_id: 'tool-b2', name: 'read' }),
    ]), null);
    const groups = items.filter((item) => item.kind === 'tool-group');
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((item) => item.key)).size).toBe(2);
    expect(groups.map((item) => item.key)).toEqual([
      'subagent-activity-tool:tool-a1|tool:tool-a2',
      'subagent-activity-tool:tool-b1|tool:tool-b2',
    ]);
  });

  it('anchors Jump to latest outside the scroll container and invokes the hook action', () => {
    const scrollRef = transcriptSource.indexOf('ref={scroll.containerRef}');
    const button = transcriptSource.indexOf('onClick={scroll.jumpToLatest}');
    const scrollClose = transcriptSource.lastIndexOf('</div>', button);
    expect(transcriptSource).toMatch(/<div className="relative flex min-h-0 min-w-0 w-full max-w-full flex-1 flex-col overflow-hidden">/);
    expect(transcriptSource).toMatch(/orchid-chat-scroll min-h-0 min-w-0 w-full max-w-full flex-1/);
    expect(scrollRef).toBeGreaterThan(0);
    expect(scrollClose).toBeGreaterThan(scrollRef);
    expect(button).toBeGreaterThan(scrollClose);
    expect(transcriptSource).toContain('Jump to latest');
    expect(transcriptSource).toContain('pointer-events-auto');
  });

  it('renders the live compaction widget from the subagent live projection (R27)', () => {
    const projection = live([{ kind: 'text', id: 'live-1', content: 'working' }]);
    projection.compactionProgress = {
      type: 'compaction_progress',
      sessionId: 'session-1',
      subagentId: 'sub-1',
      runId: 'run-1',
      sequence: 4,
      sessionRevision: 4,
      phase: 'compacting',
      mode: 'simple',
      streamText: 'SUMMARY partial',
      estimatedTokens: 12,
    };

    const items = buildSubagentTranscriptItems(
      record([message({ id: 'a', content: 'before' })]),
      projection,
    );

    const widget = items.find((item) => item.kind === 'compaction-progress');
    if (widget?.kind !== 'compaction-progress') throw new Error('expected compaction-progress');
    expect(widget.key).toBe('compaction-sub-1');
    expect(widget.item).toMatchObject({
      status: 'generating',
      phase: 'compacting',
      mode: 'simple',
      streamText: 'SUMMARY partial',
      estimatedTokens: 12,
    });
    // The live widget rides at the tail, after the durable and live content.
    expect(items.at(-1)?.kind).toBe('compaction-progress');
  });

  it('drops the live compaction widget once the phase is terminal', () => {
    const projection = live([]);
    projection.compactionProgress = {
      type: 'compaction_progress',
      sessionId: 'session-1',
      subagentId: 'sub-1',
      runId: 'run-1',
      sequence: 5,
      sessionRevision: 5,
      phase: 'complete',
      detail: 'Context compacted — resuming',
    };

    const items = buildSubagentTranscriptItems(record([]), projection);
    expect(items.some((item) => item.kind === 'compaction-progress')).toBe(false);
  });

  it('renders the compaction summary card from the persisted compacted marker on replay (R27)', () => {
    const items = buildSubagentTranscriptItems(record([
      message({ id: 'sum-1', content: 'Handoff summary.', compacted: {
        mode: 'simple', rangeStart: 'm0', rangeEnd: 'm9', summarizedCount: 10,
      } }),
      message({ id: 'after', content: 'resumed work' }),
    ]), null);

    expect(items.map((item) => item.kind)).toEqual(['compaction-summary', 'message']);
    const summary = items[0];
    if (summary?.kind !== 'compaction-summary') throw new Error('expected compaction-summary');
    expect(summary.key).toBe('sum-1');
    expect(summary.messages[0]!.compacted?.summarizedCount).toBe(10);
  });

  it('coalesces consecutive stacked summary heads into ONE compaction-summary item', () => {
    const items = buildSubagentTranscriptItems(record([
      message({ id: 'sum-1', content: 'Section one.', compacted: {
        mode: 'selective', rangeStart: 'm0', rangeEnd: 'm1', summarizedCount: 2,
      } }),
      message({ id: 'sum-2', content: 'Section two.', compacted: {
        mode: 'selective', rangeStart: 'm2', rangeEnd: 'm3', summarizedCount: 2,
      } }),
      message({ id: 'after', content: 'resumed work' }),
    ]), null);

    expect(items.map((item) => item.kind)).toEqual(['compaction-summary', 'message']);
    const summary = items[0];
    if (summary?.kind !== 'compaction-summary') throw new Error('expected compaction-summary');
    expect(summary.messages.map((m) => m.id)).toEqual(['sum-1', 'sum-2']);
  });
});
