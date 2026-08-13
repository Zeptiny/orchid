import { describe, expect, it } from 'vitest';
import {
  CHAIN_COLLAPSE_THRESHOLD,
  buildHistoryStreamItems,
  buildLiveTailItems,
  foldStreamActivityGroups,
  shouldRenderChainFooter,
  suppressLiveMessagesAlreadyInHistory,
  type StreamItem,
} from '../../src/renderer/utils/stream-building';
import { MessageRole, MessageType, type Message, type Usage } from '../../src/shared/types/message';
import { ChainStatus, type Chain } from '../../src/shared/types/chain';
import type { ToolBlock } from '../../src/renderer/hooks/useChat';
import { EMPTY_SUBAGENT_USAGE_SUMMARY } from '../../src/shared/usage';

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

  it('returns true when isTerminal', () => {
    expect(
      shouldRenderChainFooter({ isActive: false, isTerminal: true, hasBody: false, hasUser: false }),
    ).toBe(true);
  });

  it('returns true when hasBody', () => {
    expect(
      shouldRenderChainFooter({ isActive: false, isTerminal: false, hasBody: true, hasUser: false }),
    ).toBe(true);
  });

  it('returns true when hasUser', () => {
    expect(
      shouldRenderChainFooter({ isActive: false, isTerminal: false, hasBody: false, hasUser: true }),
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
});
