/**
 * Unit tests for shared Message factories (message-factories.ts).
 *
 * Ensures a single shape for conversation history construction across chat
 * IPC, subagent manager, and tool-dispatch — including explicit is_error.
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
import {
  createCanonicalToolResult,
  type CanonicalToolResult,
} from '../../src/shared/types/tool-result';

function canonicalResult(
  status: 'complete' | 'error' | 'cancelled',
  content: string,
): CanonicalToolResult {
  return status === 'error'
    ? createCanonicalToolResult('generic', {
        status,
        data: { value: content },
        error: { code: 'test_error', message: content },
      })
    : createCanonicalToolResult('generic', {
        status,
        data: { value: content },
      });
}

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
    expect(msg.is_error).toBe(false);
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
    expect(msg.is_error).toBe(false);
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
    expect(msg.is_error).toBe(false);
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
  it('builds a successful TOOL_RESULT with is_error false and unchanged content', () => {
    const canonical = canonicalResult('complete', 'file contents');
    const msg = makeToolResultMessage('tc-1', 'read_file', 'file contents', canonical);
    expect(msg.role).toBe(MessageRole.TOOL);
    expect(msg.type).toBe(MessageType.TOOL_RESULT);
    expect(msg.content).toBe('file contents');
    expect(msg.tool_call_id).toBe('tc-1');
    expect(msg.name).toBe('read_file');
    expect(msg.tool_calls).toBeNull();
    expect(msg.is_error).toBe(false);
    expect(msg.tool_result).toEqual(canonical);
  });

  it('stores is_error true without rewriting content', () => {
    const msg = makeToolResultMessage(
      'tc-1',
      'read_file',
      'not found',
      canonicalResult('error', 'not found'),
    );
    expect(msg.content).toBe('not found');
    expect(msg.is_error).toBe(true);
  });

  it('does not add or strip Error: prefix based on isError', () => {
    const already = makeToolResultMessage(
      'tc-1',
      'read_file',
      'Error: already formatted',
      canonicalResult('error', 'Error: already formatted'),
    );
    expect(already.content).toBe('Error: already formatted');
    expect(already.is_error).toBe(true);

    const successLookingLikeError = makeToolResultMessage(
      'tc-1',
      'echo',
      'Error: is just text here',
      canonicalResult('complete', 'Error: is just text here'),
    );
    expect(successLookingLikeError.content).toBe('Error: is just text here');
    expect(successLookingLikeError.is_error).toBe(false);
  });

  it('allows empty error content with is_error true', () => {
    const msg = makeToolResultMessage(
      'tc-1',
      'read_file',
      '',
      canonicalResult('error', ''),
    );
    expect(msg.content).toBe('');
    expect(msg.is_error).toBe(true);
  });

  it('allows null tool name (legacy tool-dispatch style)', () => {
    const msg = makeToolResultMessage(
      'tc-1',
      null,
      'ok',
      canonicalResult('complete', 'ok'),
    );
    expect(msg.name).toBeNull();
    expect(msg.is_error).toBe(false);
  });

  it('keeps cancelled distinct from failed without inspecting projection text', () => {
    const cancelled = canonicalResult('cancelled', 'same terminal text');
    const failed = canonicalResult('error', 'same terminal text');
    const cancelledMessage = makeToolResultMessage(
      'tc-cancelled',
      'read_file',
      'same terminal text',
      cancelled,
    );
    const failedMessage = makeToolResultMessage(
      'tc-failed',
      'read_file',
      'same terminal text',
      failed,
    );

    expect(cancelledMessage.tool_result?.status).toBe('cancelled');
    expect(cancelledMessage.is_error).toBe(false);
    expect(failedMessage.tool_result?.status).toBe('error');
    expect(failedMessage.is_error).toBe(true);
  });
});
