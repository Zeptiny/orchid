/**
 * Unit tests for toApiMessages (history.ts) — pairing / match-set invariants.
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '../../src/shared/types/message';
import { MessageType, MessageRole } from '../../src/shared/types/message';
import type { ToolCall } from '../../src/shared/types/tool';
import { toApiMessages } from '../../src/main/llm/history';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: crypto.randomUUID(),
    role: MessageRole.ASSISTANT,
    content: '',
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: new Date().toISOString(),
    usage: null,
    hidden: false,
    ...overrides,
  };
}

function makeToolCall(id: string, name: string, args: string = '{}'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: args },
  };
}

describe('toApiMessages match-set', () => {
  it('does not revive an earlier dangling call when a later turn reuses its id', () => {
    const reusedId = 'wait_for_subagent_36';
    const messages: Message[] = [
      makeMessage({
        role: MessageRole.USER,
        content: 'Wait for the subagent',
        type: MessageType.TEXT,
      }),
      makeMessage({
        role: MessageRole.ASSISTANT,
        type: MessageType.TOOL_CALL,
        tool_calls: [makeToolCall(reusedId, 'wait_for_subagent')],
        tool_call_id: reusedId,
      }),
      makeMessage({
        role: MessageRole.USER,
        content: 'Try waiting again',
        type: MessageType.TEXT,
      }),
      makeMessage({
        role: MessageRole.ASSISTANT,
        type: MessageType.TOOL_CALL,
        tool_calls: [makeToolCall(reusedId, 'wait_for_subagent')],
        tool_call_id: reusedId,
      }),
      makeMessage({
        role: MessageRole.TOOL,
        content: 'Subagent completed',
        type: MessageType.TOOL_RESULT,
        tool_call_id: reusedId,
      }),
    ];

    const result = toApiMessages(messages);

    expect(result).toHaveLength(4);
    expect(result[0].content).toBe('Wait for the subagent');
    expect(result[1].content).toBe('Try waiting again');
    expect(result[2].tool_calls?.map((call) => call.id)).toEqual([reusedId]);
    expect(result[3].tool_call_id).toBe(reusedId);
  });

  it('rebuilds match-set from surviving tool_calls only (partial filter)', () => {
    const tc1 = makeToolCall('tc-1', 'read');
    const tc2 = makeToolCall('tc-2', 'grep');
    const messages: Message[] = [
      makeMessage({
        role: MessageRole.USER,
        content: 'Read and grep',
        type: MessageType.TEXT,
      }),
      makeMessage({
        role: MessageRole.ASSISTANT,
        content: 'Let me check',
        type: MessageType.TOOL_CALL,
        tool_calls: [tc1, tc2],
      }),
      makeMessage({
        role: MessageRole.TOOL,
        content: 'file contents',
        type: MessageType.TOOL_RESULT,
        tool_call_id: 'tc-1',
      }),
      // tc-2 dangling — no result
      makeMessage({
        role: MessageRole.ASSISTANT,
        content: 'Done with partial tools',
        type: MessageType.TEXT,
      }),
    ];

    const result = toApiMessages(messages);

    expect(result).toHaveLength(4);
    expect(result[1].tool_calls).toHaveLength(1);
    expect(result[1].tool_calls![0].id).toBe('tc-1');
    expect(result[1].tool_calls!.some((tc) => tc.id === 'tc-2')).toBe(false);
    expect(result[2].tool_call_id).toBe('tc-1');
    expect(result[3].content).toBe('Done with partial tools');
  });
});

describe('toApiMessages hidden filtering', () => {
  it('excludes hidden messages from API output', () => {
    const messages: Message[] = [
      makeMessage({
        role: MessageRole.USER,
        content: 'Hello',
        type: MessageType.TEXT,
      }),
      makeMessage({
        role: MessageRole.ASSISTANT,
        content: 'Visible reply',
        type: MessageType.TEXT,
      }),
      makeMessage({
        role: MessageRole.ASSISTANT,
        content: 'Hidden note',
        type: MessageType.TEXT,
        hidden: true,
      }),
    ];

    const result = toApiMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Hello');
    expect(result[1].content).toBe('Visible reply');
  });

  it('drops tool_call whose only result is hidden (cancelled tool)', () => {
    const tc = makeToolCall('tc-cancelled', 'ask_question');
    const messages: Message[] = [
      makeMessage({
        role: MessageRole.USER,
        content: 'Do something',
        type: MessageType.TEXT,
      }),
      makeMessage({
        role: MessageRole.ASSISTANT,
        content: '',
        type: MessageType.TOOL_CALL,
        tool_calls: [tc],
        tool_call_id: 'tc-cancelled',
      }),
      makeMessage({
        role: MessageRole.TOOL,
        content: 'cancelled',
        type: MessageType.TOOL_RESULT,
        tool_call_id: 'tc-cancelled',
        hidden: true,
      }),
      makeMessage({
        role: MessageRole.ASSISTANT,
        content: 'Turn interrupted',
        type: MessageType.TEXT,
      }),
    ];

    const result = toApiMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Do something');
    expect(result[1].content).toBe('Turn interrupted');
    expect(result.some((m) => m.tool_call_id === 'tc-cancelled')).toBe(false);
    expect(result.some((m) => m.tool_calls?.some((t) => t.id === 'tc-cancelled'))).toBe(false);
  });

  it('drops a visible tool result explicitly excluded from model context', () => {
    const tc = makeToolCall('tc-cancelled-visible', 'ask_question');
    const messages: Message[] = [
      makeMessage({
        role: MessageRole.USER,
        content: 'Do something',
        type: MessageType.TEXT,
      }),
      makeMessage({
        role: MessageRole.ASSISTANT,
        type: MessageType.TOOL_CALL,
        tool_calls: [tc],
      }),
      makeMessage({
        role: MessageRole.TOOL,
        content: 'cancelled',
        type: MessageType.TOOL_RESULT,
        tool_call_id: tc.id,
        excludeFromModel: true,
      }),
    ];

    const result = toApiMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Do something');
  });
});
