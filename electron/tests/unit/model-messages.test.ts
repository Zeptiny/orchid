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

  it('skips tool calls whose persisted arguments are invalid JSON', () => {
    expect(toModelMessages([
      assistant({
        content: 'Still answer normally.',
        tool_calls: [{
          id: 'call-invalid',
          type: 'function',
          function: { name: 'read', arguments: '{not json}' },
        }],
      }),
    ])).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Still answer normally.' }],
      },
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

  it('skips system messages because streamText receives system separately', () => {
    expect(toModelMessages([
      { role: 'system', content: 'Ignored here.' },
      { role: 'user', content: 'Kept.' },
    ])).toEqual([{ role: 'user', content: 'Kept.' }]);
  });
});
