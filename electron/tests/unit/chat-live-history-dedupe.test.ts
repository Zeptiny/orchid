/**
 * Live-tail / history dedupe — prevents a one-frame double bubble when
 * SESSION_UPDATED commits chain messages before CHAT_DONE clears streamSegments.
 */
import { describe, expect, it } from 'vitest';
import { suppressLiveMessagesAlreadyInHistory } from '../../src/renderer/components/ChatStream';
import { MessageRole, MessageType, type Message } from '../../src/shared/types/message';

function assistantText(id: string, content: string): Message {
  return {
    id,
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    usage: null,
    hidden: false,
    tool_result: null,
  };
}

function assistantThinking(id: string, content: string): Message {
  return {
    ...assistantText(id, content),
    type: MessageType.THINKING,
    thinking: content,
  };
}

describe('suppressLiveMessagesAlreadyInHistory', () => {
  it('keeps live assistant text when history has not committed it yet', () => {
    const live = [
      {
        kind: 'message' as const,
        key: 'seg-1',
        message: assistantText('seg-1', 'Hello world'),
        isStreaming: true,
      },
    ];
    const history = [
      {
        kind: 'message' as const,
        key: 'user-1',
        message: {
          ...assistantText('user-1', 'hi'),
          role: MessageRole.USER,
        },
      },
    ];

    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toEqual(live);
  });

  it('drops live text that already appears in committed history (SESSION_UPDATED race)', () => {
    const content = 'Final answer after tools.';
    const live = [
      {
        kind: 'message' as const,
        key: 'seg-live',
        message: assistantText('seg-live', content),
        isStreaming: false,
      },
    ];
    const history = [
      {
        kind: 'message' as const,
        key: 'chain-msg',
        message: assistantText('chain-msg', content),
      },
    ];

    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toEqual([]);
  });

  it('drops live thinking that matches committed thinking', () => {
    const content = 'I should check the file first.';
    const live = [
      {
        kind: 'message' as const,
        key: 'think-live',
        message: assistantThinking('think-live', content),
        isStreaming: false,
      },
    ];
    const history = [
      {
        kind: 'message' as const,
        key: 'think-hist',
        message: assistantThinking('think-hist', content),
      },
    ];

    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toEqual([]);
  });

  it('does not treat text and thinking with the same body as duplicates', () => {
    const content = 'same body';
    const live = [
      {
        kind: 'message' as const,
        key: 'text-live',
        message: assistantText('text-live', content),
      },
    ];
    const history = [
      {
        kind: 'message' as const,
        key: 'think-hist',
        message: assistantThinking('think-hist', content),
      },
    ];

    expect(suppressLiveMessagesAlreadyInHistory(live, history)).toEqual(live);
  });

  it('uses multiset counts so identical bubbles only suppress matching counts', () => {
    const content = 'ok';
    const live = [
      {
        kind: 'message' as const,
        key: 'live-1',
        message: assistantText('live-1', content),
      },
      {
        kind: 'message' as const,
        key: 'live-2',
        message: assistantText('live-2', content),
      },
      {
        kind: 'message' as const,
        key: 'live-3',
        message: assistantText('live-3', content),
      },
    ];
    const history = [
      {
        kind: 'message' as const,
        key: 'hist-1',
        message: assistantText('hist-1', content),
      },
      {
        kind: 'message' as const,
        key: 'hist-2',
        message: assistantText('hist-2', content),
      },
    ];

    const result = suppressLiveMessagesAlreadyInHistory(live, history);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ key: 'live-3' });
  });

  it('never drops live tool items (tools use emittedToolIds)', () => {
    const live = [
      {
        kind: 'tool' as const,
        key: 'tool-1',
        block: {
          id: 'tool-1',
          toolName: 'read',
          status: 'complete' as const,
          partialArgs: '',
          args: '{}',
          agentProjection: null,
          toolResult: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: null,
        },
      },
      {
        kind: 'message' as const,
        key: 'seg',
        message: assistantText('seg', 'done'),
      },
    ];
    const history = [
      {
        kind: 'message' as const,
        key: 'hist',
        message: assistantText('hist', 'done'),
      },
    ];

    const result = suppressLiveMessagesAlreadyInHistory(live, history);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('tool');
  });

  it('returns live unchanged when history has no assistant text', () => {
    const live = [
      {
        kind: 'message' as const,
        key: 'seg',
        message: assistantText('seg', 'streaming…'),
        isStreaming: true,
      },
    ];
    expect(suppressLiveMessagesAlreadyInHistory(live, [])).toEqual(live);
  });
});
