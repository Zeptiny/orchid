import { describe, expect, it } from 'vitest';
import type { ModelMessage, Tool } from 'ai';
import { z } from 'zod';
import { buildContextSnapshot } from '../../src/main/llm/context-snapshot';

describe('context snapshot', () => {
  it('allocates the latest input across every real context source', () => {
    const tools: Record<string, Tool> = {
      read: {
        description: 'Read a file from disk',
        inputSchema: z.object({ path: z.string() }),
      },
    };
    const messages = [
      { role: 'user', content: 'Open the file' },
      { role: 'assistant', content: 'I will inspect it.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'read',
            input: { path: 'README.md' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'text', value: 'file contents' },
          },
        ],
      },
    ] as ModelMessage[];

    const snapshot = buildContextSnapshot({
      systemPrompt: 'System instructions',
      tools,
      messages,
      inputTokens: 1_000,
      outputTokens: 100,
    });

    expect(snapshot.input_tokens).toBe(1_000);
    expect(snapshot.output_tokens).toBe(100);
    expect(snapshot.used_tokens).toBe(1_100);
    expect(snapshot.system_tokens).toBeGreaterThan(0);
    expect(snapshot.tools_tokens).toBeGreaterThan(0);
    expect(snapshot.tool_use_tokens).toBeGreaterThan(0);
    expect(snapshot.user_tokens).toBeGreaterThan(0);
    expect(snapshot.assistant_tokens).toBeGreaterThanOrEqual(100);
    expect(
      snapshot.system_tokens +
        snapshot.tools_tokens +
        snapshot.tool_use_tokens +
        snapshot.user_tokens +
        snapshot.assistant_tokens,
    ).toBe(snapshot.used_tokens);
  });
});
