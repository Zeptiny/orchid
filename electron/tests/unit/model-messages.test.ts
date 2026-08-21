import { describe, expect, it } from 'vitest';
import { toModelMessages } from '../../src/main/llm/model-messages';
import type { ApiMessage } from '../../src/shared/types/message';

function assistant(overrides: Partial<ApiMessage> = {}): ApiMessage {
  return { role: 'assistant', content: '', ...overrides };
}

describe('toModelMessages', () => {
  it('preserves assistant text as the compact AI SDK string form', () => {
    expect(toModelMessages([assistant({ content: 'Hello' })])).toEqual([
      { role: 'assistant', content: 'Hello' },
    ]);
  });

  it('preserves assistant reasoning, text, and valid tool calls', () => {
    expect(toModelMessages([
      assistant({
        content: [
          { type: 'reasoning', text: 'Consider the workspace.' },
          { type: 'text', text: 'I will inspect it.' },
        ],
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'read', arguments: '{"path":"README.md"}' },
        }],
      }),
    ])).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Consider the workspace.' },
          { type: 'text', text: 'I will inspect it.' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'read',
            input: { path: 'README.md' },
          },
        ],
      },
    ]);
  });

  it('compacts assistant content when no valid tool calls remain', () => {
    expect(toModelMessages([
      assistant({ content: 'Empty calls.', tool_calls: [] }),
      assistant({
        content: 'Still answer normally.',
        tool_calls: [{
          id: 'call-invalid',
          type: 'function',
          function: { name: 'read', arguments: '{not json}' },
        }],
      }),
      assistant({
        tool_calls: [{
          id: 'call-invalid-only',
          type: 'function',
          function: { name: 'read', arguments: '{not json}' },
        }],
      }),
    ])).toEqual([
      { role: 'assistant', content: 'Empty calls.' },
      { role: 'assistant', content: 'Still answer normally.' },
      { role: 'assistant', content: '' },
    ]);
  });

  it('converts tool results and user content to text-only AI SDK messages', () => {
    expect(toModelMessages([
      {
        role: 'tool',
        content: [
          { type: 'text', text: 'first' },
          { type: 'reasoning', text: 'not replayed' },
          { type: 'text', text: ' second' },
        ],
        tool_call_id: 'call-1',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please ' },
          { type: 'reasoning', text: 'not replayed' },
          { type: 'text', text: 'continue.' },
        ],
      },
    ])).toEqual([
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'unknown',
          output: { type: 'text', value: 'first second' },
        }],
      },
      { role: 'user', content: 'Please continue.' },
    ]);
  });

  it('skips persisted tool results without a tool call ID', () => {
    expect(toModelMessages([
      { role: 'tool', content: 'orphaned result' },
      { role: 'user', content: 'Continue.' },
    ])).toEqual([{ role: 'user', content: 'Continue.' }]);
  });

  it('skips system messages because streamText receives system separately', () => {
    expect(toModelMessages([
      { role: 'system', content: 'Ignored here.' },
      { role: 'user', content: 'Kept.' },
    ])).toEqual([{ role: 'user', content: 'Kept.' }]);
  });

  it('carries the compaction summary marker onto assistant messages (R19)', () => {
    const marker = {
      rangeStart: 'start-id',
      rangeEnd: 'end-id',
      mode: 'simple' as const,
      summarizedCount: 12,
    };
    const messages = toModelMessages([
      assistant({ content: '# Handoff summary', compacted: marker }),
      assistant({ content: 'plain reply' }),
    ]) as Array<{ role: string; content: unknown; compacted?: unknown }>;

    expect(messages).toHaveLength(2);
    expect(messages[0]?.compacted).toEqual(marker);
    expect(messages[1]?.compacted).toBeUndefined();
  });
});
