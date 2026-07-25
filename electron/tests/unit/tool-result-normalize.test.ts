/** Canonical tool-result finalization tests. */
import { describe, it, expect, vi } from 'vitest';
import {
  finalizeToolExecutionResult,
  parseToolExecutionResult,
} from '../../src/main/tools/result';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

describe('canonical tool-result parsing', () => {
  it('accepts only the canonical execution wrapper', () => {
    const canonical = createCanonicalToolResult('generic', {
      status: 'complete',
      data: { value: 'hello' },
    });
    const parsed = parseToolExecutionResult({
      canonical,
      agentProjection: { content: 'hello', completeness: 'complete' },
    });
    expect(parsed.canonical).toEqual(canonical);
    expect(() => parseToolExecutionResult({ content: 'hello', isError: false })).toThrow();
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
