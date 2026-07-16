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
    is_error: false,
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
