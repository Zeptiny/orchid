/**
 * Unit tests for shared Message factories (message-factories.ts).
 *
 * Ensures a single shape for conversation history construction across chat
 * IPC, subagent manager, and tool-dispatch — including Error: prefixing.
 */
import { describe, it, expect } from 'vitest';
import {
  makeUserMessage,
  makeAssistantMessage,
  makeThinkingMessage,
  makeToolCallMessage,
  makeToolResultMessage,
} from '../../src/main/llm/message-factories';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import type { Usage } from '../../src/shared/types/message';

const sampleUsage: Usage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  cached_tokens: 2,
};

describe('makeUserMessage', () => {
  it('builds a USER TEXT message', () => {
    const msg = makeUserMessage('Hello');
    expect(msg.role).toBe(MessageRole.USER);
    expect(msg.type).toBe(MessageType.TEXT);
    expect(msg.content).toBe('Hello');
    expect(msg.tool_calls).toBeNull();
    expect(msg.tool_call_id).toBeNull();
    expect(msg.name).toBeNull();
    expect(msg.thinking).toBeNull();
    expect(msg.usage).toBeNull();
    expect(msg.hidden).toBe(false);
    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('assigns unique ids', () => {
    const a = makeUserMessage('a');
    const b = makeUserMessage('b');
    expect(a.id).not.toBe(b.id);
  });
});

describe('makeAssistantMessage', () => {
  it('builds an ASSISTANT TEXT message with null usage by default', () => {
    const msg = makeAssistantMessage('Reply');
    expect(msg.role).toBe(MessageRole.ASSISTANT);
    expect(msg.type).toBe(MessageType.TEXT);
    expect(msg.content).toBe('Reply');
    expect(msg.usage).toBeNull();
    expect(msg.tool_calls).toBeNull();
    expect(msg.hidden).toBe(false);
  });

  it('attaches usage when provided', () => {
    const msg = makeAssistantMessage('Done', sampleUsage);
    expect(msg.usage).toEqual(sampleUsage);
  });

  it('allows empty content with usage (final usage-only bubble)', () => {
    const msg = makeAssistantMessage('', sampleUsage);
    expect(msg.content).toBe('');
    expect(msg.usage).toEqual(sampleUsage);
  });
});

describe('makeThinkingMessage', () => {
  it('builds a THINKING message with mirrored thinking field', () => {
    const msg = makeThinkingMessage('Reasoning step');
    expect(msg.role).toBe(MessageRole.ASSISTANT);
    expect(msg.type).toBe(MessageType.THINKING);
    expect(msg.content).toBe('Reasoning step');
    expect(msg.thinking).toBe('Reasoning step');
    expect(msg.usage).toBeNull();
  });
});

describe('makeToolCallMessage', () => {
  it('builds a TOOL_CALL with function payload and name', () => {
    const msg = makeToolCallMessage('tc-1', 'read_file', '{"path":"a.ts"}');
    expect(msg.role).toBe(MessageRole.ASSISTANT);
    expect(msg.type).toBe(MessageType.TOOL_CALL);
    expect(msg.content).toBe('');
    expect(msg.tool_call_id).toBe('tc-1');
    expect(msg.name).toBe('read_file');
    expect(msg.tool_calls).toEqual([
      {
        id: 'tc-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
      },
    ]);
  });

  it('defaults empty args to {}', () => {
    const msg = makeToolCallMessage('tc-2', 'grep', '');
    expect(msg.tool_calls![0].function.arguments).toBe('{}');
  });
});

describe('makeToolResultMessage', () => {
  it('builds a successful TOOL_RESULT without Error: prefix', () => {
    const msg = makeToolResultMessage('tc-1', 'read_file', 'file contents', false);
    expect(msg.role).toBe(MessageRole.TOOL);
    expect(msg.type).toBe(MessageType.TOOL_RESULT);
    expect(msg.content).toBe('file contents');
    expect(msg.tool_call_id).toBe('tc-1');
    expect(msg.name).toBe('read_file');
    expect(msg.tool_calls).toBeNull();
  });

  it('prefixes Error: when isError and content lacks the prefix', () => {
    const msg = makeToolResultMessage('tc-1', 'read_file', 'not found', true);
    expect(msg.content).toBe('Error: not found');
  });

  it('does not double-prefix content that already starts with Error:', () => {
    const msg = makeToolResultMessage(
      'tc-1',
      'read_file',
      'Error: already formatted',
      true,
    );
    expect(msg.content).toBe('Error: already formatted');
  });

  it('prefixes empty error content so UI classifiers still mark failure', () => {
    const msg = makeToolResultMessage('tc-1', 'read_file', '', true);
    expect(msg.content).toBe('Error: ');
    expect(msg.content.startsWith('Error:')).toBe(true);
  });

  it('allows null tool name (legacy tool-dispatch style)', () => {
    const msg = makeToolResultMessage('tc-1', null, 'ok', false);
    expect(msg.name).toBeNull();
  });

  it('does not prefix success content that happens to mention Error:', () => {
    // Only isError triggers prefixing; success content is left as-is.
    const msg = makeToolResultMessage(
      'tc-1',
      'echo',
      'Error: is just text here',
      false,
    );
    expect(msg.content).toBe('Error: is just text here');
  });
});
