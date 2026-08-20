import { describe, expect, it } from 'vitest';
import {
  CHAIN_COLLAPSE_THRESHOLD,
  buildHistoryStreamItems,
  buildLiveTailItems,
  compactionProgressToWidgetItem,
  foldStreamActivityGroups,
  shouldRenderChainFooter,
  suppressLiveMessagesAlreadyInHistory,
  type StreamItem,
} from '../../src/renderer/utils/stream-building';
import {
  MessageRole,
  MessageType,
  type CompactedMarker,
  type Message,
  type Usage,
} from '../../src/shared/types/message';
import { ChainStatus, type Chain } from '../../src/shared/types/chain';
import type { ToolBlock } from '../../src/renderer/hooks/useChat';
import { EMPTY_SUBAGENT_USAGE_SUMMARY } from '../../src/shared/usage';
import {
  CANONICAL_TOOL_RESULT_VERSION,
  type CanonicalToolResult,
} from '../../src/shared/types/tool-result';

function msg(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: MessageRole.ASSISTANT,
    content: '',
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    usage: null,
    hidden: false,
    tool_result: null,
    ...overrides,
  };
}

function userMsg(id: string, content: string): Message {
  return msg({ id, role: MessageRole.USER, content });
}

function assistantText(id: string, content: string): Message {
  return msg({ id, content });
}

function thinkingMsg(id: string, content: string, isStreaming?: boolean): Message {
  return msg({ id, content, type: MessageType.THINKING, thinking: content });
}

function toolBlock(id: string, toolName: string, status: string = 'completed'): ToolBlock {
  return {
    id,
    toolName,
    status: status as ToolBlock['status'],
    partialArgs: '',
    args: '{}',
    agentProjection: null,
    toolResult: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: status === 'completed' || status === 'failed' ? '2026-01-01T00:00:01.000Z' : null,
  };
}

function chain(overrides: Partial<Chain> & { id: string }): Chain {
  return {
    sessionId: 'sess-1',
    messages: [],
    status: ChainStatus.COMPLETED,
    selection: null,
    modelLabel: 'test-model',
    agentName: 'default',
    agentType: 'main',
    agentTier: 'crown',
    subagentRecord: null,
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:10.000Z',
    ...overrides,
  };
}

function messageItem(id: string, message: Message, isStreaming?: boolean): StreamItem {
  return { kind: 'message', key: id, message, isStreaming };
}

function toolItem(block: ToolBlock): StreamItem {
  return { kind: 'tool', key: block.id, block };
}

/** Chain body without the per-chain footer, so ordering assertions stay focused. */
function bodyItems(items: readonly StreamItem[]): StreamItem[] {
  return items.filter((it) => it.kind !== 'footer');
}

// ── Compaction fixtures ──────────────────────────────────────────────────────

function compactionMarker(overrides: Partial<CompactedMarker> = {}): CompactedMarker {
  return {
    rangeStart: 'range-start-message-id',
    rangeEnd: 'range-end-message-id',
    mode: 'simple',
    ...overrides,
  };
}

/** Compaction summary head — replayed to the model, rendered first-class. */
function summaryHead(id: string, content: string, overrides: Partial<Message> = {}): Message {
  return msg({ id, content, compacted: compactionMarker(), ...overrides });
}

/** Display-only message kept visible in history but excluded from the model. */
function excludedText(id: string, content: string, overrides: Partial<Message> = {}): Message {
  return msg({ id, content, excludeFromModel: true, ...overrides });
}

function excludedThinking(id: string, content: string): Message {
  return msg({
    id,
    content,
    type: MessageType.THINKING,
    thinking: content,
    excludeFromModel: true,
  });
}

function toolCallMsg(
  id: string,
  callId: string,
  toolName: string,
  overrides: Partial<Message> = {},
): Message {
  return msg({
    id,
    type: MessageType.TOOL_CALL,
    content: '',
    tool_calls: [{
      id: callId,
      type: 'function',
      function: { name: toolName, arguments: '{"path":"a.ts"}' },
    }],
    ...overrides,
  });
}

function toolResultMsg(
  id: string,
  callId: string,
  overrides: Partial<Message> = {},
): Message {
  return msg({
    id,
    role: MessageRole.TOOL,
    type: MessageType.TOOL_RESULT,
    content: 'tool output body',
    tool_call_id: callId,
    name: 'read',
    ...overrides,
  });
}

function canonicalResult(status: 'complete' = 'complete'): CanonicalToolResult {
  return {
    schemaVersion: CANONICAL_TOOL_RESULT_VERSION,
    family: 'generic',
    data: { value: 'ok' },
    status,
    completeness: 'complete',
  };
}

describe('shouldRenderChainFooter', () => {
  it('returns false when all inputs are false', () => {
    expect(
      shouldRenderChainFooter({ isActive: false, isTerminal: false, hasBody: false, hasUser: false }),
    ).toBe(false);
  });

  it('returns true when isActive', () => {
    expect(
      shouldRenderChainFooter({ isActive: true, isTerminal: false, hasBody: false, hasUser: false }),
    ).toBe(true);
  });

  it('returns false when isTerminal alone — a body-less chain drops no stray footer', () => {
    expect(
      shouldRenderChainFooter({ isActive: false, isTerminal: true, hasBody: false, hasUser: false }),
    ).toBe(false);
  });

  it('returns true when isTerminal with a body', () => {
    expect(
      shouldRenderChainFooter({ isActive: false, isTerminal: true, hasBody: true, hasUser: false }),
    ).toBe(true);
  });

  it('returns true when isTerminal with a user turn', () => {
    expect(
      shouldRenderChainFooter({ isActive: false, isTerminal: true, hasBody: false, hasUser: true }),
    ).toBe(true);
  });

  it('returns true when hasBody', () => {
    expect(
      shouldRenderChainFooter({ isActive: false, isTerminal: false, hasBody: true, hasUser: false }),
    ).toBe(true);
  });
});

describe('suppressLiveMessagesAlreadyInHistory', () => {
  it('keeps live items when history is empty', () => {
    const live = [messageItem('seg-1', assistantText('seg-1', 'Hello'))];
    expect(suppressLiveMessagesAlreadyInHistory(live, [])).toEqual(live);
  });

  it('drops live assistant text that matches committed history', () => {
    const content = 'Final answer.';
    const live = [messageItem('live-1', assistantText('live-1', content))];
    const history = [messageItem('hist-1', assistantText('hist-1', content))];
    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toEqual([]);
  });

  it('drops live thinking that matches committed thinking', () => {
    const content = 'Let me think...';
    const live = [messageItem('live-t', thinkingMsg('live-t', content))];
    const history = [messageItem('hist-t', thinkingMsg('hist-t', content))];
    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toEqual([]);
  });

  it('does not suppress text matching thinking with same body', () => {
    const content = 'same';
    const live = [messageItem('live-text', assistantText('live-text', content))];
    const history = [messageItem('hist-think', thinkingMsg('hist-think', content))];
    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toEqual(live);
  });

  it('uses multiset counts for identical content', () => {
    const content = 'dup';
    const live = [
      messageItem('l1', assistantText('l1', content)),
      messageItem('l2', assistantText('l2', content)),
      messageItem('l3', assistantText('l3', content)),
    ];
    const history = [
      messageItem('h1', assistantText('h1', content)),
      messageItem('h2', assistantText('h2', content)),
    ];
    const result = suppressLiveMessagesAlreadyInHistory(live, history);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ key: 'l3' });
  });

  it('never drops tool items', () => {
    const live = [
      toolItem(toolBlock('t1', 'read')),
      messageItem('seg', assistantText('seg', 'done')),
    ];
    const history = [messageItem('h', assistantText('h', 'done'))];
    const result = suppressLiveMessagesAlreadyInHistory(live, history);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('tool');
  });

  it('ignores user messages in history for dedup', () => {
    const content = 'hello';
    const live = [messageItem('live', assistantText('live', content))];
    const history = [messageItem('user', userMsg('user', content))];
    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toEqual(live);
  });
});

describe('foldStreamActivityGroups', () => {
  it('groups two or more settled groupable tools', () => {
    const items: StreamItem[] = [
      toolItem(toolBlock('t1', 'grep')),
      toolItem(toolBlock('t2', 'read')),
    ];
    const result = foldStreamActivityGroups(items);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('tool-group');
  });

  it('groups settled tool + settled thought', () => {
    const items: StreamItem[] = [
      messageItem('think', thinkingMsg('think', 'hmm')),
      toolItem(toolBlock('t1', 'grep')),
    ];
    const result = foldStreamActivityGroups(items);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('tool-group');
  });

  it('keeps a single settled tool solo', () => {
    const items: StreamItem[] = [toolItem(toolBlock('t1', 'grep'))];
    const result = foldStreamActivityGroups(items);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('tool');
  });

  it('keeps active (running) tools solo', () => {
    const items: StreamItem[] = [
      toolItem(toolBlock('t1', 'grep', 'completed')),
      toolItem(toolBlock('t2', 'read', 'running')),
    ];
    const result = foldStreamActivityGroups(items);
    expect(result).toHaveLength(2);
    expect(result[0]?.kind).toBe('tool');
    expect(result[1]?.kind).toBe('tool');
  });

  it('keeps streaming thoughts solo', () => {
    const items: StreamItem[] = [
      toolItem(toolBlock('t1', 'grep')),
      { kind: 'message', key: 'think', message: thinkingMsg('think', '...'), isStreaming: true },
    ];
    const result = foldStreamActivityGroups(items);
    expect(result).toHaveLength(2);
  });

  it('breaks on non-groupable tools (mutations)', () => {
    const items: StreamItem[] = [
      toolItem(toolBlock('t1', 'grep')),
      toolItem(toolBlock('t2', 'edit')),
      toolItem(toolBlock('t3', 'read')),
    ];
    const result = foldStreamActivityGroups(items);
    const kinds = result.map((r) => r.kind);
    expect(kinds).toContain('tool');
    const editItem = result.find(
      (r) => r.kind === 'tool' && r.block.toolName === 'edit',
    );
    expect(editItem).toBeDefined();
  });

  it('preserves chronological order in group children', () => {
    const items: StreamItem[] = [
      messageItem('think', thinkingMsg('think', 'reasoning')),
      toolItem(toolBlock('t1', 'grep')),
      toolItem(toolBlock('t2', 'read')),
    ];
    const result = foldStreamActivityGroups(items);
    expect(result).toHaveLength(1);
    const group = result[0];
    if (group?.kind !== 'tool-group') throw new Error('expected tool-group');
    expect(group.children).toHaveLength(3);
    expect(group.children[0]?.kind).toBe('thought');
    expect(group.children[1]?.kind).toBe('tool');
    expect(group.children[2]?.kind).toBe('tool');
  });
});

describe('buildHistoryStreamItems', () => {
  const baseOpts = {
    messages: [] as Message[],
    toolBlocks: [] as ToolBlock[],
    status: 'idle' as const,
    liveUsage: null as Usage | null,
    subagentUsage: EMPTY_SUBAGENT_USAGE_SUMMARY,
    interrupted: false,
    expandedChainIndexes: new Set<number>(),
  };

  it('collapses chains beyond the threshold into stubs', () => {
    const chains = Array.from({ length: CHAIN_COLLAPSE_THRESHOLD + 5 }, (_, i) =>
      chain({ id: `chain-${i}`, messages: [userMsg(`u${i}`, `msg ${i}`)] }),
    );
    const result = buildHistoryStreamItems({ ...baseOpts, sessionChains: chains });
    const stubs = result.items.filter((it) => it.kind === 'collapsed-stub');
    expect(stubs).toHaveLength(5);
  });

  it('does not collapse chains within the threshold', () => {
    const chains = Array.from({ length: CHAIN_COLLAPSE_THRESHOLD }, (_, i) =>
      chain({ id: `chain-${i}`, messages: [userMsg(`u${i}`, `msg ${i}`)] }),
    );
    const result = buildHistoryStreamItems({ ...baseOpts, sessionChains: chains });
    const stubs = result.items.filter((it) => it.kind === 'collapsed-stub');
    expect(stubs).toHaveLength(0);
  });

  it('respects expandedChainIndexes to un-collapse', () => {
    const chains = Array.from({ length: CHAIN_COLLAPSE_THRESHOLD + 3 }, (_, i) =>
      chain({ id: `chain-${i}`, messages: [userMsg(`u${i}`, `msg ${i}`)] }),
    );
    const result = buildHistoryStreamItems({
      ...baseOpts,
      sessionChains: chains,
      expandedChainIndexes: new Set([0, 1]),
    });
    const stubs = result.items.filter((it) => it.kind === 'collapsed-stub');
    expect(stubs).toHaveLength(1);
  });

  it('renders footer with model label from chain', () => {
    const chains = [
      chain({ id: 'c1', modelLabel: 'gpt-4o', messages: [userMsg('u1', 'hi')] }),
    ];
    const result = buildHistoryStreamItems({ ...baseOpts, sessionChains: chains });
    const footers = result.items.filter((it) => it.kind === 'footer');
    expect(footers).toHaveLength(1);
    expect(footers[0]).toMatchObject({ kind: 'footer', model: 'gpt-4o' });
  });

  it('renders a history gap while preserving full-chain footer usage and errors', () => {
    const usage: Usage = {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      cached_tokens: 10,
    };
    const chains = [chain({
      id: 'paged-chain',
      status: ChainStatus.FAILED,
      messages: [assistantText('recent', 'recent tail')],
      messagesLoaded: false,
      messageStartIndex: 8,
      messageCount: 9,
      usageSummary: usage,
      preview: 'original question',
      errorDetail: 'provider failed',
    })];

    const result = buildHistoryStreamItems({ ...baseOpts, sessionChains: chains });

    expect(result.items[0]).toMatchObject({ kind: 'history-gap', chainIndex: 0 });
    expect(result.items.find((item) => item.kind === 'message')).toBeDefined();
    expect(result.items.find((item) => item.kind === 'footer')).toMatchObject({
      kind: 'footer',
      usage,
      failed: true,
      errorDetail: 'provider failed',
    });
  });

  it('renders one global history gap targeting the newest incomplete chain', () => {
    const chains = [
      chain({
        id: 'older-incomplete',
        messages: [],
        messagesLoaded: false,
        messageStartIndex: 8,
        messageCount: 8,
      }),
      chain({
        id: 'newer-incomplete',
        messages: [assistantText('recent', 'recent tail')],
        messagesLoaded: false,
        messageStartIndex: 4,
        messageCount: 5,
      }),
    ];

    const result = buildHistoryStreamItems({ ...baseOpts, sessionChains: chains });
    const gaps = result.items.filter((item) => item.kind === 'history-gap');

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ chainIndex: 1 });
    expect(result.items[0]).toMatchObject({ kind: 'history-gap', chainIndex: 1 });
  });

  it('emits the global history gap only when its collapsed chain is expanded', () => {
    const chains = Array.from(
      { length: CHAIN_COLLAPSE_THRESHOLD + 1 },
      (_, index) => chain({
        id: `chain-${index}`,
        ...(index === 0
          ? {
              messagesLoaded: false,
              messageStartIndex: 2,
              messageCount: 2,
            }
          : {}),
      }),
    );

    const collapsed = buildHistoryStreamItems({ ...baseOpts, sessionChains: chains });
    expect(collapsed.items.some((item) => item.kind === 'history-gap')).toBe(false);

    const expanded = buildHistoryStreamItems({
      ...baseOpts,
      sessionChains: chains,
      expandedChainIndexes: new Set([0]),
    });
    expect(expanded.items.filter((item) => item.kind === 'history-gap'))
      .toEqual([expect.objectContaining({ chainIndex: 0 })]);
  });

  it('marks footer as interrupted for INTERRUPTED chains', () => {
    const chains = [
      chain({ id: 'c1', status: ChainStatus.INTERRUPTED, messages: [userMsg('u1', 'hi')] }),
    ];
    const result = buildHistoryStreamItems({ ...baseOpts, sessionChains: chains });
    const footers = result.items.filter((it) => it.kind === 'footer');
    expect(footers).toHaveLength(1);
    expect(footers[0]).toMatchObject({ interrupted: true });
  });

  it('marks footer as failed for FAILED chains', () => {
    const chains = [
      chain({ id: 'c1', status: ChainStatus.FAILED, messages: [userMsg('u1', 'hi')] }),
    ];
    const result = buildHistoryStreamItems({ ...baseOpts, sessionChains: chains });
    const footers = result.items.filter((it) => it.kind === 'footer');
    expect(footers).toHaveLength(1);
    expect(footers[0]).toMatchObject({ failed: true });
  });

  it('returns activeFooter for the active chain instead of pushing it', () => {
    const chains = [
      chain({ id: 'c1', status: ChainStatus.ACTIVE, messages: [userMsg('u1', 'hi')] }),
    ];
    const result = buildHistoryStreamItems({ ...baseOpts, sessionChains: chains });
    expect(result.activeFooter).not.toBeNull();
    expect(result.activeFooter?.model).toBe('test-model');
    const inlineFooters = result.items.filter((it) => it.kind === 'footer');
    expect(inlineFooters).toHaveLength(0);
  });

  it('emits idle leftover tool blocks not in history', () => {
    const chains = [chain({ id: 'c1', messages: [userMsg('u1', 'hi')] })];
    const blocks = [toolBlock('orphan-1', 'grep')];
    const result = buildHistoryStreamItems({ ...baseOpts, sessionChains: chains, toolBlocks: blocks });
    const tools = result.items.filter((it) => it.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(result.emittedToolIds.has('orphan-1')).toBe(true);
  });
});

describe('buildLiveTailItems', () => {
  it('returns empty when not streaming and no segments', () => {
    const result = buildLiveTailItems({
      toolBlocks: [],
      streamSegments: [],
      streamingContent: '',
      status: 'idle',
      emittedToolIds: new Set(),
    });
    expect(result).toEqual([]);
  });

  it('maps text segments to message items', () => {
    const result = buildLiveTailItems({
      toolBlocks: [],
      streamSegments: [{ kind: 'text', id: 'seg-1', content: 'Hello world' }],
      streamingContent: '',
      status: 'streaming',
      emittedToolIds: new Set(),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'message',
      isStreaming: true,
    });
    if (result[0]?.kind === 'message') {
      expect(result[0].message.content).toBe('Hello world');
      expect(result[0].message.type).toBe(MessageType.TEXT);
    }
  });

  it('maps thinking segments to thinking message items', () => {
    const result = buildLiveTailItems({
      toolBlocks: [],
      streamSegments: [{ kind: 'thinking', id: 'seg-t', content: 'reasoning...' }],
      streamingContent: '',
      status: 'streaming',
      emittedToolIds: new Set(),
    });
    expect(result).toHaveLength(1);
    if (result[0]?.kind === 'message') {
      expect(result[0].message.type).toBe(MessageType.THINKING);
      expect(result[0].message.thinking).toBe('reasoning...');
      expect(result[0].isStreaming).toBe(true);
    }
  });

  it('marks non-trailing segments as not streaming', () => {
    const result = buildLiveTailItems({
      toolBlocks: [],
      streamSegments: [
        { kind: 'text', id: 'seg-1', content: 'first' },
        { kind: 'text', id: 'seg-2', content: 'second' },
      ],
      streamingContent: '',
      status: 'streaming',
      emittedToolIds: new Set(),
    });
    expect(result).toHaveLength(2);
    if (result[0]?.kind === 'message') expect(result[0].isStreaming).toBe(false);
    if (result[1]?.kind === 'message') expect(result[1].isStreaming).toBe(true);
  });

  it('maps tool segments using live tool blocks', () => {
    const block = toolBlock('tc-1', 'grep', 'running');
    const result = buildLiveTailItems({
      toolBlocks: [block],
      streamSegments: [{ kind: 'tool', toolCallId: 'tc-1' }],
      streamingContent: '',
      status: 'streaming',
      emittedToolIds: new Set(),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'tool', key: 'tc-1' });
  });

  it('skips tools already in emittedToolIds', () => {
    const block = toolBlock('tc-1', 'grep');
    const result = buildLiveTailItems({
      toolBlocks: [block],
      streamSegments: [{ kind: 'tool', toolCallId: 'tc-1' }],
      streamingContent: '',
      status: 'streaming',
      emittedToolIds: new Set(['tc-1']),
    });
    expect(result).toHaveLength(0);
  });

  it('falls back to streamingContent when segments are empty', () => {
    const result = buildLiveTailItems({
      toolBlocks: [],
      streamSegments: [],
      streamingContent: 'fallback text',
      status: 'streaming',
      emittedToolIds: new Set(),
    });
    expect(result).toHaveLength(1);
    if (result[0]?.kind === 'message') {
      expect(result[0].message.content).toBe('fallback text');
      expect(result[0].isStreaming).toBe(true);
    }
  });

  it('renders idle leftover tools when segments exist but status is idle', () => {
    const block = toolBlock('tc-idle', 'read');
    const result = buildLiveTailItems({
      toolBlocks: [block],
      streamSegments: [{ kind: 'tool', toolCallId: 'tc-idle' }],
      streamingContent: '',
      status: 'idle',
      emittedToolIds: new Set(),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('tool');
  });

  it('keys live text by segment id and position, not by timestamp', () => {
    const segments = [
      { kind: 'text' as const, id: 'seg-1', content: 'first' },
      { kind: 'tool' as const, toolCallId: 'tc-9' },
      { kind: 'text' as const, id: 'seg-2', content: 'second' },
    ];
    const result = buildLiveTailItems({
      toolBlocks: [toolBlock('tc-9', 'read', 'running')],
      streamSegments: segments,
      streamingContent: '',
      status: 'streaming',
      emittedToolIds: new Set(),
    });
    expect(result.map((it) => it.key)).toEqual([
      'live-seg-1-0',
      'tc-9',
      'live-seg-2-streaming',
    ]);
  });

  it('keeps live tail keys stable across rebuilds of identical segments', () => {
    const segments = [
      { kind: 'text' as const, id: 'seg-a', content: 'hello' },
      { kind: 'thinking' as const, id: 'seg-b', content: 'reasoning' },
    ];
    const build = () => buildLiveTailItems({
      toolBlocks: [],
      streamSegments: segments,
      streamingContent: '',
      status: 'streaming',
      emittedToolIds: new Set(),
    });
    const first = build();
    const second = build();
    expect(second.map((it) => it.key)).toEqual(['live-seg-a-0', 'live-seg-b-streaming']);
    expect(second.map((it) => it.key)).toEqual(first.map((it) => it.key));
  });
});

// ── Compaction projection ────────────────────────────────────────────────────

describe('buildHistoryStreamItems — compaction projection', () => {
  const opts = {
    messages: [] as Message[],
    toolBlocks: [] as ToolBlock[],
    status: 'idle' as const,
    liveUsage: null as Usage | null,
    subagentUsage: EMPTY_SUBAGENT_USAGE_SUMMARY,
    interrupted: false,
    expandedChainIndexes: new Set<number>(),
  };

  it('renders a summary head followed by one collapsed stub for the excluded range', () => {
    const messages = [
      summaryHead('sum-1', 'Earlier work summarized.'),
      excludedText('m1', 'old assistant turn'),
      excludedText('m2', 'old tool output'),
    ];
    const result = buildHistoryStreamItems({
      ...opts,
      sessionChains: [chain({ id: 'c1', messages })],
    });

    const body = bodyItems(result.items);
    expect(body.map((it) => it.kind)).toEqual(['compaction-summary', 'compacted-stub']);
    if (body[0]?.kind !== 'compaction-summary') throw new Error('expected compaction-summary');
    expect(body[0].key).toBe('c0-compaction-sum-1-0');
    expect(body[0].message.content).toBe('Earlier work summarized.');
    if (body[1]?.kind !== 'compacted-stub') throw new Error('expected compacted-stub');
    expect(body[1].key).toBe('compacted-stub-m1');
    expect(body[1].count).toBe(2);
    expect(body[1].messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('flushes the stub before the next non-excluded message so order is preserved', () => {
    const messages = [excludedText('m1', 'old turn'), userMsg('u1', 'next question')];
    const result = buildHistoryStreamItems({
      ...opts,
      sessionChains: [chain({ id: 'c1', messages })],
    });

    const body = bodyItems(result.items);
    expect(body.map((it) => it.kind)).toEqual(['compacted-stub', 'message']);
    if (body[0]?.kind !== 'compacted-stub') throw new Error('expected compacted-stub');
    expect(body[0].count).toBe(1);
    if (body[1]?.kind !== 'message') throw new Error('expected message');
    expect(body[1].message.role).toBe(MessageRole.USER);
    expect(body[1].message.content).toBe('next question');
  });

  it('splits excluded runs into separate stubs at each summary head', () => {
    const messages = [
      excludedText('m1', 'pre-summary turn'),
      summaryHead('sum-1', 'Summary A.'),
      excludedText('m2', 'post-summary turn'),
    ];
    const result = buildHistoryStreamItems({
      ...opts,
      sessionChains: [chain({ id: 'c1', messages })],
    });

    const body = bodyItems(result.items);
    expect(body.map((it) => it.kind)).toEqual([
      'compacted-stub',
      'compaction-summary',
      'compacted-stub',
    ]);
    if (body[0]?.kind !== 'compacted-stub' || body[2]?.kind !== 'compacted-stub') {
      throw new Error('expected compacted stubs');
    }
    expect(body[0].messages.map((m) => m.id)).toEqual(['m1']);
    expect(body[2].messages.map((m) => m.id)).toEqual(['m2']);
  });

  it('drops hidden messages from the compacted stub', () => {
    const messages = [
      excludedText('m1', 'visible old turn'),
      msg({ id: 'm2', content: 'hidden old turn', hidden: true, excludeFromModel: true }),
    ];
    const result = buildHistoryStreamItems({
      ...opts,
      sessionChains: [chain({ id: 'c1', messages })],
    });

    const stub = bodyItems(result.items).find((it) => it.kind === 'compacted-stub');
    if (stub?.kind !== 'compacted-stub') throw new Error('expected compacted-stub');
    expect(stub.count).toBe(1);
    expect(stub.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('expands a stub into thought / tool-pair / text items when its key is expanded', () => {
    const toolResult = canonicalResult('complete');
    const messages = [
      summaryHead('sum-1', 'Summary.'),
      excludedThinking('th1', 'old reasoning'),
      toolCallMsg('call-1', 'tc-1', 'read', { excludeFromModel: true }),
      toolResultMsg('res-1', 'tc-1', { tool_result: toolResult, excludeFromModel: true }),
      excludedText('m-text', 'old assistant answer'),
    ];
    const sessionChains = [chain({ id: 'c1', messages })];

    // First build collapsed to learn the stub key (mirrors the click flow).
    const collapsed = buildHistoryStreamItems({ ...opts, sessionChains });
    const stub = collapsed.items.find((it) => it.kind === 'compacted-stub');
    if (stub?.kind !== 'compacted-stub') throw new Error('expected compacted-stub');
    expect(stub.count).toBe(4);

    const expanded = buildHistoryStreamItems({
      ...opts,
      sessionChains,
      expandedCompactedKeys: new Set([stub.key]),
    });

    const body = bodyItems(expanded.items);
    expect(body.map((it) => it.kind)).toEqual([
      'compaction-summary',
      'message',
      'tool',
      'message',
    ]);
    expect(body.some((it) => it.kind === 'compacted-stub')).toBe(false);

    const thought = body[1];
    if (thought?.kind !== 'message') throw new Error('expected message');
    expect(thought.message.id).toBe('th1');
    expect(thought.message.type).toBe(MessageType.THINKING);

    // The buffered call+result pair is reconstructed as a single tool block.
    const tool = body[2];
    if (tool?.kind !== 'tool') throw new Error('expected tool');
    expect(tool.block.id).toBe('tc-1');
    expect(tool.block.toolName).toBe('read');
    expect(tool.block.status).toBe('complete');
    expect(tool.block.args).toBe('{"path":"a.ts"}');
    expect(tool.block.agentProjection).toBe('tool output body');
    expect(tool.block.toolResult).toBe(toolResult);
    expect(expanded.emittedToolIds.has('tc-1')).toBe(true);

    const text = body[3];
    if (text?.kind !== 'message') throw new Error('expected message');
    expect(text.message.content).toBe('old assistant answer');
  });

  it('expands an unpaired buffered result into a result-only tool block', () => {
    const messages = [
      summaryHead('sum-1', 'Summary.'),
      toolResultMsg('res-x', 'tc-x', {
        name: 'grep',
        content: 'grep output',
        tool_result: canonicalResult(),
        excludeFromModel: true,
      }),
    ];
    const sessionChains = [chain({ id: 'c1', messages })];

    const collapsed = buildHistoryStreamItems({ ...opts, sessionChains });
    const stub = collapsed.items.find((it) => it.kind === 'compacted-stub');
    if (stub?.kind !== 'compacted-stub') throw new Error('expected compacted-stub');

    const expanded = buildHistoryStreamItems({
      ...opts,
      sessionChains,
      expandedCompactedKeys: new Set([stub.key]),
    });

    const tools = expanded.items.filter((it) => it.kind === 'tool');
    expect(tools).toHaveLength(1);
    if (tools[0]?.kind !== 'tool') throw new Error('expected tool');
    expect(tools[0].block.id).toBe('tc-x');
    expect(tools[0].block.toolName).toBe('grep');
    expect(tools[0].block.agentProjection).toBe('grep output');
    expect(tools[0].block.toolResult?.status).toBe('complete');
  });

  it('prefers a live tool block over the persisted pair when expanding', () => {
    const messages = [
      summaryHead('sum-1', 'Summary.'),
      toolCallMsg('call-1', 'tc-1', 'read', { excludeFromModel: true }),
      toolResultMsg('res-1', 'tc-1', { excludeFromModel: true }),
    ];
    const sessionChains = [chain({ id: 'c1', messages })];
    const live = toolBlock('tc-1', 'read', 'running');

    const collapsed = buildHistoryStreamItems({ ...opts, sessionChains });
    const stub = collapsed.items.find((it) => it.kind === 'compacted-stub');
    if (stub?.kind !== 'compacted-stub') throw new Error('expected compacted-stub');

    const expanded = buildHistoryStreamItems({
      ...opts,
      sessionChains,
      toolBlocks: [live],
      expandedCompactedKeys: new Set([stub.key]),
    });

    const tools = expanded.items.filter((it) => it.kind === 'tool');
    expect(tools).toHaveLength(1);
    if (tools[0]?.kind !== 'tool') throw new Error('expected tool');
    expect(tools[0].block).toBe(live);
  });

  it('claims compacted tool ids while collapsed so a stale live tail cannot re-render them', () => {
    const messages = [
      summaryHead('sum-1', 'Summary.'),
      toolCallMsg('call-1', 'tc-1', 'read', { excludeFromModel: true }),
      toolResultMsg('res-1', 'tc-1', { excludeFromModel: true }),
      assistantText('m-kept', 'preserved answer'),
    ];
    const sessionChains = [chain({ id: 'c1', messages })];
    // Compaction rewrote the chains mid-turn, but the live projection still
    // holds the pre-compaction read tool.
    const stale = toolBlock('tc-1', 'read', 'completed');

    const history = buildHistoryStreamItems({ ...opts, sessionChains });
    expect(history.emittedToolIds.has('tc-1')).toBe(true);

    const liveTail = buildLiveTailItems({
      toolBlocks: [stale],
      streamSegments: [{ kind: 'tool', toolCallId: 'tc-1' }],
      streamingContent: '',
      status: 'streaming',
      emittedToolIds: history.emittedToolIds,
    });
    expect(liveTail).toEqual([]);

    // After CHAT_DONE the same block must not be appended below the chain
    // footer by the idle leftover-tools path either.
    const idle = buildHistoryStreamItems({ ...opts, sessionChains, toolBlocks: [stale] });
    expect(bodyItems(idle.items).some((it) => it.kind === 'tool')).toBe(false);
  });

  it('counts compaction items as chain body so a compaction-only chain keeps its footer', () => {
    // Note: `hasBody` cannot be isolated end-to-end — every non-ACTIVE chain
    // status is terminal, which already forces a footer. This pins that a chain
    // whose only body is compaction items still emits one.
    const messages = [summaryHead('sum-1', 'Summary.'), excludedText('m1', 'old turn')];
    const result = buildHistoryStreamItems({
      ...opts,
      sessionChains: [chain({ id: 'compaction-only', messages })],
    });

    expect(result.items.some((it) => it.kind === 'compaction-summary')).toBe(true);
    expect(result.items.some((it) => it.kind === 'compacted-stub')).toBe(true);
    expect(result.items.filter((it) => it.kind === 'message')).toHaveLength(0);
    expect(result.items.filter((it) => it.kind === 'footer')).toHaveLength(1);
  });

  it('returns the footer as activeFooter for an active compaction-only chain', () => {
    const messages = [summaryHead('sum-1', 'Summary.'), excludedText('m1', 'old turn')];
    const result = buildHistoryStreamItems({
      ...opts,
      sessionChains: [chain({ id: 'active-compaction', status: ChainStatus.ACTIVE, messages })],
    });

    expect(result.activeFooter).not.toBeNull();
    expect(result.items.filter((it) => it.kind === 'footer')).toHaveLength(0);
  });
});

describe('buildHistoryStreamItems — summary head dedupe across chains', () => {
  const opts = {
    messages: [] as Message[],
    toolBlocks: [] as ToolBlock[],
    status: 'idle' as const,
    liveUsage: null as Usage | null,
    subagentUsage: EMPTY_SUBAGENT_USAGE_SUMMARY,
    interrupted: false,
    expandedChainIndexes: new Set<number>(),
  };

  it('renders a summary head repeated in two chains only once', () => {
    const shared = summaryHead('sum-1', 'Same summary head.');
    const result = buildHistoryStreamItems({
      ...opts,
      sessionChains: [
        chain({ id: 'c1', messages: [shared, excludedText('m1', 'old turn')] }),
        chain({ id: 'c2', messages: [shared, userMsg('u2', 'follow-up')] }),
      ],
    });

    const summaries = result.items.filter((it) => it.kind === 'compaction-summary');
    expect(summaries).toHaveLength(1);
    if (summaries[0]?.kind !== 'compaction-summary') throw new Error('expected summary');
    expect(summaries[0].message.id).toBe('sum-1');

    // Chain 2 renders only its own user turn — no duplicate summary.
    const users = result.items.filter(
      (it) => it.kind === 'message' && it.message.role === MessageRole.USER,
    );
    expect(users).toHaveLength(1);
  });

  it('skips a duplicated excluded summary head already rendered by an earlier chain', () => {
    const result = buildHistoryStreamItems({
      ...opts,
      sessionChains: [
        chain({ id: 'c1', messages: [summaryHead('sum-1', 'Summary head.')] }),
        chain({
          id: 'c2',
          messages: [
            summaryHead('sum-1', 'Summary head.', { excludeFromModel: true }),
            excludedText('m1', 'old turn'),
          ],
        }),
      ],
    });

    expect(result.items.filter((it) => it.kind === 'compaction-summary')).toHaveLength(1);
    const stub = bodyItems(result.items).filter((it) => it.kind === 'compacted-stub');
    expect(stub).toHaveLength(1);
    if (stub[0]?.kind !== 'compacted-stub') throw new Error('expected compacted-stub');
    // The mirrored head id is deduped — only the genuinely new message counts.
    expect(stub[0].messages.map((m) => m.id)).toEqual(['m1']);
    expect(stub[0].count).toBe(1);
  });

  it('renders distinct summary heads once per chain', () => {
    const result = buildHistoryStreamItems({
      ...opts,
      sessionChains: [
        chain({ id: 'c1', messages: [summaryHead('sum-a', 'Summary A.')] }),
        chain({ id: 'c2', messages: [summaryHead('sum-b', 'Summary B.')] }),
      ],
    });

    const summaries = result.items.filter((it) => it.kind === 'compaction-summary');
    expect(summaries.map((it) => (it.kind === 'compaction-summary' ? it.message.id : null)))
      .toEqual(['sum-a', 'sum-b']);
  });
});

describe('buildHistoryStreamItems — compacted runs merge across chain boundaries', () => {
  const opts = {
    messages: [] as Message[],
    toolBlocks: [] as ToolBlock[],
    status: 'idle' as const,
    liveUsage: null as Usage | null,
    subagentUsage: EMPTY_SUBAGENT_USAGE_SUMMARY,
    interrupted: false,
    expandedChainIndexes: new Set<number>(),
  };

  /**
   * Live mid-turn layout after a re-compaction (storage split rows): a
   * flagged prefix row, a superseded-head summary row whose single message
   * was flagged by the newer compaction, the current summary row, and the
   * continuing tail. Buffering per chain renders the superseded head as its
   * own "Compacted 1 message" stub; the shared buffer must merge it into the
   * adjacent range.
   */
  it('merges a flagged prefix row and a superseded-head row into ONE stub', () => {
    const result = buildHistoryStreamItems({
      ...opts,
      sessionChains: [
        chain({
          id: 'prefix',
          messages: [userMsg('u1', 'explore'), excludedText('m1', 'old turn'), excludedText('m2', 'old tool')],
        }),
        chain({
          id: 'superseded-head',
          messages: [summaryHead('head-1', 'Superseded summary.', { excludeFromModel: true })],
        }),
        chain({ id: 'summary-2', messages: [summaryHead('sum-2', 'Current summary.')] }),
        chain({ id: 'tail', messages: [assistantText('kept-1', 'preserved answer')] }),
      ],
    });

    const stubs = bodyItems(result.items).filter((it) => it.kind === 'compacted-stub');
    expect(stubs).toHaveLength(1);
    if (stubs[0]?.kind !== 'compacted-stub') throw new Error('expected compacted-stub');
    expect(stubs[0].count).toBe(3);
    expect(stubs[0].messages.map((m) => m.id)).toEqual(['m1', 'm2', 'head-1']);

    // The prefix row (user + compacted run only) and the superseded-head row
    // drop no footers — nothing sits between the merged stub and the summary.
    expect(result.items.map((it) => it.kind)).toEqual([
      'message',
      'compacted-stub',
      'compaction-summary',
      'footer',
      'message',
      'footer',
    ]);
  });

  it('carries an open run through an all-flagged chain and dedupes ids mirrored across rows', () => {
    const result = buildHistoryStreamItems({
      ...opts,
      sessionChains: [
        chain({ id: 'c0', messages: [excludedText('m1', 'old turn')] }),
        // Stale split mirror: m1 duplicated + one more flagged message.
        chain({ id: 'mirror', messages: [excludedText('m1', 'old turn'), excludedText('m2', 'old tool')] }),
        chain({ id: 'c2', messages: [userMsg('u2', 'next question')] }),
      ],
    });

    expect(bodyItems(result.items).map((it) => it.kind)).toEqual([
      'compacted-stub',
      'message',
    ]);
    const stub = bodyItems(result.items)[0];
    if (stub?.kind !== 'compacted-stub') throw new Error('expected compacted-stub');
    expect(stub.count).toBe(2);
    expect(stub.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    // Neither flagged-only chain renders a footer.
    expect(result.items.filter((it) => it.kind === 'footer')).toHaveLength(1);
  });

  it('expands a merged cross-chain stub to full fidelity', () => {
    const sessionChains = [
      chain({ id: 'prefix', messages: [excludedThinking('th1', 'old reasoning')] }),
      chain({
        id: 'mirror-head',
        messages: [
          summaryHead('head-1', 'Superseded summary.', { excludeFromModel: true }),
          toolCallMsg('call-1', 'tc-1', 'read', { excludeFromModel: true }),
        ],
      }),
      chain({ id: 'res-row', messages: [toolResultMsg('res-1', 'tc-1', { excludeFromModel: true })] }),
      chain({ id: 'c3', messages: [userMsg('u1', 'next')] }),
    ];

    const collapsed = buildHistoryStreamItems({ ...opts, sessionChains });
    const stub = collapsed.items.find((it) => it.kind === 'compacted-stub');
    if (stub?.kind !== 'compacted-stub') throw new Error('expected compacted-stub');
    expect(stub.count).toBe(4);

    const expanded = buildHistoryStreamItems({
      ...opts,
      sessionChains,
      expandedCompactedKeys: new Set([stub.key]),
    });

    expect(expanded.items.some((it) => it.kind === 'compacted-stub')).toBe(false);
    // The tool pair is reconstructed even though its call and result sat in
    // DIFFERENT chains of the merged run.
    const tools = expanded.items.filter((it) => it.kind === 'tool');
    expect(tools).toHaveLength(1);
    if (tools[0]?.kind !== 'tool') throw new Error('expected tool');
    expect(tools[0].block.id).toBe('tc-1');
    expect(tools[0].block.toolName).toBe('read');
    expect(tools[0].block.agentProjection).toBe('tool output body');
    const thoughts = expanded.items.filter(
      (it) => it.kind === 'message' && it.message.type === MessageType.THINKING,
    );
    expect(thoughts).toHaveLength(1);
  });

  it('renders a superseded summary head inside an expanded run as the compaction widget, not an agent bubble', () => {
    const sessionChains = [
      chain({
        id: 'run',
        messages: [
          excludedText('m1', 'old turn'),
          summaryHead('head-1', 'Superseded summary.', { excludeFromModel: true }),
          excludedText('m2', 'later old turn'),
        ],
      }),
      chain({ id: 'c2', messages: [userMsg('u1', 'next')] }),
    ];

    const collapsed = buildHistoryStreamItems({ ...opts, sessionChains });
    const stub = collapsed.items.find((it) => it.kind === 'compacted-stub');
    if (stub?.kind !== 'compacted-stub') throw new Error('expected compacted-stub');

    const expanded = buildHistoryStreamItems({
      ...opts,
      sessionChains,
      expandedCompactedKeys: new Set([stub.key]),
    });

    const body = bodyItems(expanded.items);
    // The flagged head stays a compaction-summary item (CompactionWidget)
    // between the two ordinary compacted messages.
    expect(body.map((it) => it.kind)).toEqual([
      'message',
      'compaction-summary',
      'message',
      'message',
    ]);
    const summary = body[1];
    if (summary?.kind !== 'compaction-summary') throw new Error('expected compaction-summary');
    expect(summary.message.id).toBe('head-1');
    expect(summary.message.excludeFromModel).toBe(true);
  });
});

describe('suppressLiveMessagesAlreadyInHistory — exact-id suppression', () => {
  it('drops a live message whose id is already committed, even when content differs', () => {
    const live = [messageItem('msg-9', assistantText('msg-9', 'partial stream text'))];
    const history = [messageItem('msg-9', assistantText('msg-9', 'committed final text'))];
    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toEqual([]);
  });

  it('does not let an id match consume the content-multiset budget', () => {
    const live = [
      messageItem('h1', assistantText('h1', 'streaming variant')),
      messageItem('l2', assistantText('l2', 'alpha')),
    ];
    const history = [messageItem('h1', assistantText('h1', 'alpha'))];
    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toEqual([]);
  });

  it('keeps the live array identity when history contributes no dedupe keys', () => {
    const live: StreamItem[] = [
      toolItem(toolBlock('t1', 'read')),
      messageItem('seg-1', assistantText('seg-1', 'live')),
    ];
    const history = [toolItem(toolBlock('t2', 'read'))];
    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toBe(live);
  });

  it('ignores compaction items in history — they neither id- nor content-suppress live text', () => {
    const content = 'Summary: earlier work.';
    const history: StreamItem[] = [
      { kind: 'compaction-summary', key: 'k1', message: summaryHead('sum-1', content) },
      { kind: 'compacted-stub', key: 'k2', messages: [excludedText('m1', content)], count: 1 },
    ];
    const live = [messageItem('live-1', assistantText('live-1', content))];
    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toEqual(live);
  });
});

describe('stream item React keys', () => {
  const opts = {
    messages: [] as Message[],
    toolBlocks: [] as ToolBlock[],
    status: 'idle' as const,
    liveUsage: null as Usage | null,
    subagentUsage: EMPTY_SUBAGENT_USAGE_SUMMARY,
    interrupted: false,
    expandedChainIndexes: new Set<number>(),
  };

  const mixedChain = chain({
    id: 'c1',
    messages: [
      userMsg('u1', 'hi'),
      thinkingMsg('th1', 'hmm'),
      toolCallMsg('call-1', 'tc-1', 'read'),
      toolResultMsg('res-1', 'tc-1'),
      assistantText('a1', 'done'),
    ],
  });

  it('formats history message keys as prefix-kind-id-index and tool keys as prefix-tool-id-size', () => {
    const result = buildHistoryStreamItems({ ...opts, sessionChains: [mixedChain] });
    expect(bodyItems(result.items).map((it) => it.key)).toEqual([
      'c0-user-u1-0',
      'c0-thought-th1-1',
      'c0-tool-tc-1-1',
      'c0-asst-a1-4',
    ]);
  });

  it('produces identical keys across rebuilds of the same history', () => {
    const build = () => buildHistoryStreamItems({
      ...opts,
      sessionChains: [mixedChain],
      expandedChainIndexes: new Set<number>(),
      expandedCompactedKeys: new Set<string>(),
    });
    const first = build();
    const second = build();
    expect(second.items.map((it) => it.key)).toEqual(first.items.map((it) => it.key));
    expect(second.items.map((it) => it.key)).toEqual([
      'c0-user-u1-0',
      'c0-thought-th1-1',
      'c0-tool-tc-1-1',
      'c0-asst-a1-4',
      'footer-chain-c1',
    ]);
  });

  it('keeps earlier chain keys stable when a later chain is appended', () => {
    const solo = buildHistoryStreamItems({
      ...opts,
      sessionChains: [mixedChain],
    });
    const withSecond = buildHistoryStreamItems({
      ...opts,
      sessionChains: [mixedChain, chain({ id: 'c2', messages: [userMsg('u2', 'again')] })],
    });

    const soloKeys = bodyItems(solo.items).map((it) => it.key);
    expect(soloKeys).toEqual([
      'c0-user-u1-0',
      'c0-thought-th1-1',
      'c0-tool-tc-1-1',
      'c0-asst-a1-4',
    ]);
    expect(bodyItems(withSecond.items).map((it) => it.key).slice(0, soloKeys.length))
      .toEqual(soloKeys);
    expect(bodyItems(withSecond.items).map((it) => it.key).slice(-1)).toEqual(['c1-user-u2-0']);
  });

  it('keys compaction items with chain-scoped, expansion-stable keys', () => {
    const messages = [
      summaryHead('sum-1', 'Summary.'),
      excludedText('m1', 'old turn'),
      userMsg('u1', 'next'),
    ];
    const sessionChains = [chain({ id: 'c1', messages })];
    const collapsed = buildHistoryStreamItems({ ...opts, sessionChains });
    expect(bodyItems(collapsed.items).map((it) => it.key)).toEqual([
      'c0-compaction-sum-1-0',
      'compacted-stub-m1',
      'c0-user-u1-2',
    ]);

    const stubKey = 'compacted-stub-m1';
    const expanded = buildHistoryStreamItems({
      ...opts,
      sessionChains,
      expandedCompactedKeys: new Set([stubKey]),
    });
    // The summary and later items keep their keys; only the stub is replaced.
    const expandedKeys = bodyItems(expanded.items).map((it) => it.key);
    expect(expandedKeys[0]).toBe('c0-compaction-sum-1-0');
    expect(expandedKeys[2]).toBe('c0-user-u1-2');
    expect(expandedKeys).toHaveLength(3);
  });
});

describe('compactionProgressToWidgetItem — live widget from the scoped event', () => {
  it('builds the widget item for the main scope with a stable key', () => {
    const item = compactionProgressToWidgetItem('main', {
      phase: 'compacting',
      mode: 'simple',
      detail: 'Summarizing history',
      streamText: 'SUMMARY partial',
      estimatedTokens: 12,
    });
    expect(item).toEqual({
      kind: 'compaction-progress',
      key: 'compaction-main',
      status: 'generating',
      phase: 'compacting',
      mode: 'simple',
      detail: 'Summarizing history',
      streamText: 'SUMMARY partial',
      estimatedTokens: 12,
    });
  });

  it('builds the widget item for a subagent scope keyed by the subagent id', () => {
    const item = compactionProgressToWidgetItem('subagent-42', {
      phase: 'preparing',
      mode: 'selective',
    });
    expect(item).toEqual({
      kind: 'compaction-progress',
      key: 'compaction-subagent-42',
      status: 'running',
      phase: 'preparing',
      mode: 'selective',
    });
  });

  it('keeps the key stable across phases of one compaction', () => {
    const preparing = compactionProgressToWidgetItem('main', { phase: 'preparing' });
    const compacting = compactionProgressToWidgetItem('main', {
      phase: 'compacting',
      streamText: 'tail',
    });
    expect(preparing?.key).toBe('compaction-main');
    expect(compacting?.key).toBe('compaction-main');
    expect(preparing?.status).toBe('running');
    expect(compacting?.status).toBe('generating');
  });

  it('produces no item for terminal phases or absent progress', () => {
    expect(compactionProgressToWidgetItem('main', { phase: 'complete' })).toBeNull();
    expect(compactionProgressToWidgetItem('main', { phase: 'failed' })).toBeNull();
    expect(compactionProgressToWidgetItem('main', null)).toBeNull();
    expect(compactionProgressToWidgetItem('main', undefined)).toBeNull();
  });

  it('replay derives widget completion from the persisted compacted marker, not live events', () => {
    // A compacted-then-reloaded session renders the summary head from the
    // marker with NO live progress input — the widget's terminal state
    // survives a snapshot replay in both scopes.
    const result = buildHistoryStreamItems({
      messages: [],
      toolBlocks: [],
      status: 'idle',
      liveUsage: null,
      subagentUsage: EMPTY_SUBAGENT_USAGE_SUMMARY,
      interrupted: false,
      expandedChainIndexes: new Set<number>(),
      sessionChains: [chain({
        id: 'c1',
        messages: [summaryHead('sum-1', 'Handoff summary.'), userMsg('u1', 'next')],
      })],
    });

    const summary = bodyItems(result.items).find((it) => it.kind === 'compaction-summary');
    if (summary?.kind !== 'compaction-summary') throw new Error('expected compaction-summary');
    expect(summary.message.compacted).toBeDefined();
    expect(compactionProgressToWidgetItem('main', null)).toBeNull();
  });
});
