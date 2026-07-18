/**
 * Tests for normalizeToolHandlerResult / parseToolExecuteOutput.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  finalizeToolExecutionResult,
  normalizeToolHandlerResult,
  parseToolExecuteOutput,
} from '../../src/main/tools/result';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

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

describe('finalizeToolExecutionResult', () => {
  it('falls back to the generic projector without changing canonical facts', () => {
    const canonical = createCanonicalToolResult('generic', {
      status: 'complete',
      data: { value: { sentinel: 'CANONICAL_ONLY_SENTINEL' } },
    });

    const execution = finalizeToolExecutionResult({
      canonical,
      toolName: 'unstable',
      projector: () => {
        throw new TypeError('projection failed');
      },
    });

    expect(execution.canonical).toBe(canonical);
    expect(execution.canonical.status).toBe('complete');
    expect(execution.agentProjection.content).toContain('CANONICAL_ONLY_SENTINEL');
  });

  it('logs only metadata when a projector exposes content in its failure', () => {
    const logger = vi.fn();
    const canonical = createCanonicalToolResult('generic', {
      status: 'complete',
      data: { value: 'CANONICAL_ONLY_SENTINEL' },
    });

    finalizeToolExecutionResult({
      canonical,
      toolName: 'unstable',
      toolCallId: 'call-1',
      projector: () => {
        throw new Error('CANONICAL_ONLY_SENTINEL');
      },
      fallbackLogger: logger,
    });

    expect(logger).toHaveBeenCalledOnce();
    const diagnostic = logger.mock.calls[0]?.[0];
    expect(diagnostic).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'unstable',
      family: 'generic',
      status: 'complete',
      stage: 'projection',
      exceptionClass: 'Error',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('CANONICAL_ONLY_SENTINEL');
  });

  it('rejects a custom partial projection without recovery guidance', () => {
    const canonical = createCanonicalToolResult('generic', {
      status: 'complete',
      data: { value: ['one', 'two'] },
    });

    expect(() => finalizeToolExecutionResult({
      canonical,
      toolName: 'broken-partial',
      projector: () => ({ content: 'one', completeness: 'partial' }),
      fallbackOnProjectorError: false,
    })).toThrow(/retrieval/i);
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
