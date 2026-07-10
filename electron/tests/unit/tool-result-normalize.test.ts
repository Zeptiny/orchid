/**
 * Tests for normalizeToolHandlerResult / parseToolExecuteOutput.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeToolHandlerResult,
  parseToolExecuteOutput,
} from '../../src/main/tools/result';

describe('normalizeToolHandlerResult', () => {
  it('treats plain strings as success', () => {
    expect(normalizeToolHandlerResult('hello')).toEqual({
      content: 'hello',
      isError: false,
    });
  });

  it('preserves display+content JSON and explicit isError', () => {
    const r = normalizeToolHandlerResult({
      display: 'Failed',
      content: 'boom',
      isError: true,
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content)).toEqual({ display: 'Failed', content: 'boom' });
  });

  it('does not infer failure from content text', () => {
    const r = normalizeToolHandlerResult({
      display: 'ok',
      content: 'Error: is just text in a successful payload',
    });
    expect(r.isError).toBe(false);
  });

  it('accepts is_error alias', () => {
    const r = normalizeToolHandlerResult({ content: 'x', is_error: true });
    expect(r).toEqual({ content: 'x', isError: true });
  });
});

describe('parseToolExecuteOutput', () => {
  it('reads structured AI SDK execute payload', () => {
    expect(parseToolExecuteOutput({ content: 'out', isError: true })).toEqual({
      content: 'out',
      isError: true,
    });
  });

  it('treats plain string as success (no content sniffing)', () => {
    expect(parseToolExecuteOutput('Error: looks like an error')).toEqual({
      content: 'Error: looks like an error',
      isError: false,
    });
  });
});

import {
  messageToStorageDict,
  messageFromStorageDict,
  MessageRole,
  MessageType,
} from '../../src/shared/types/message';
import { makeToolResultMessage } from '../../src/main/llm/message-factories';

describe('Message is_error persistence', () => {
  it('round-trips is_error through storage dict', () => {
    const msg = makeToolResultMessage('tc-1', 'execute_command', 'STDOUT:\nok', true);
    const dict = messageToStorageDict(msg);
    expect(dict.is_error).toBe(true);
    const restored = messageFromStorageDict(dict);
    expect(restored.is_error).toBe(true);
    expect(restored.content).toBe('STDOUT:\nok');
  });

  it('defaults missing is_error to false on restore', () => {
    const restored = messageFromStorageDict({
      role: MessageRole.TOOL,
      content: 'Error: looks like failure but has no flag',
      type: MessageType.TOOL_RESULT,
      tool_call_id: 'tc-legacy',
    });
    expect(restored.is_error).toBe(false);
  });
});
