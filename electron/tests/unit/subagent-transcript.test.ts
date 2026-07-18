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

const message = (overrides: Partial<Message>): Message => ({
  id: 'message', role: MessageRole.ASSISTANT, content: 'text', type: MessageType.TEXT,
  tool_calls: null, tool_call_id: null, name: null, thinking: null,
  timestamp: '2026-07-18T00:00:00.000Z', usage: null, hidden: false, is_error: false,
  ...overrides,
});

const chain = (messages: Message[]): Chain => ({
  id: 'chain-1', sessionId: 'session-1', status: 'completed', messages,
  selection: null, modelLabel: null, agentName: 'worker', agentType: 'worker', agentTier: 'bloom',
  startTime: null, endTime: null, subagentRecord: null,
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
          content: 'done', tool_call_id: 'tool-1', name: 'read' }),
      ]),
      live([{ kind: 'text', id: 'live-1', content: 'after' }]),
    );
    expect(items.map((item) => item.kind)).toEqual(['message', 'tool', 'message']);
    expect(items.map((item) => item.kind === 'message' ? item.message.content : item.block.toolName))
      .toEqual(['before', 'read', 'after']);
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

  it('uses explicit is_error semantics for durable tool results', () => {
    const items = buildSubagentTranscriptItems(record([
      message({ id: 'call', type: MessageType.TOOL_CALL, content: '', tool_call_id: 'tool-1',
        tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'exec', arguments: '{}' } }] }),
      message({ id: 'result', role: MessageRole.TOOL, type: MessageType.TOOL_RESULT,
        content: 'failed', tool_call_id: 'tool-1', name: 'exec', is_error: true }),
    ]), null);
    expect(items).toHaveLength(1);
    expect(items[0].kind === 'tool' && items[0].block.status).toBe('failed');
    expect(items[0].kind === 'tool' && items[0].block.error).toBe('failed');
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
    expect(transcriptSource).toMatch(/<div className="relative flex min-h-0 flex-1 flex-col">/);
    expect(scrollRef).toBeGreaterThan(0);
    expect(scrollClose).toBeGreaterThan(scrollRef);
    expect(button).toBeGreaterThan(scrollClose);
    expect(transcriptSource).toContain('Jump to latest');
    expect(transcriptSource).toContain('pointer-events-auto');
  });
});
