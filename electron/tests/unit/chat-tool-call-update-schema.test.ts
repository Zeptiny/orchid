/**
 * Wire contract for tool_call_update lifecycle streaming (#compaction live tail).
 *
 * The 'generating' variant carries optional live content (the compactor's
 * accumulated output); 'running' stays content-free; terminal variants still
 * require exact content + canonical toolResult with matching status.
 */
import { describe, expect, it } from 'vitest';
import { chatToolCallUpdateEventSchema } from '../../src/shared/types/ipc-schemas';

const identity = { sessionId: 'session-1', turnId: 'turn-1', sequence: 2 };

const terminalResult = {
  schemaVersion: 1,
  family: 'generic',
  status: 'complete',
  completeness: 'complete',
  data: { value: '', origin: { kind: 'built-in', name: 'compaction' } },
};

describe('chatToolCallUpdateEventSchema', () => {
  it('accepts a generating update with live streaming content', () => {
    const parsed = chatToolCallUpdateEventSchema.safeParse({
      ...identity,
      type: 'tool_call_update',
      toolCallId: 'compaction-session-1',
      toolName: 'compaction',
      status: 'generating',
      content: '## Handoff\nEarlier work',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a generating update without content', () => {
    const parsed = chatToolCallUpdateEventSchema.safeParse({
      ...identity,
      type: 'tool_call_update',
      toolCallId: 'tool-1',
      toolName: 'grep',
      status: 'generating',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a generating update carrying a terminal toolResult', () => {
    const parsed = chatToolCallUpdateEventSchema.safeParse({
      ...identity,
      type: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'generating',
      content: 'partial',
      toolResult: terminalResult,
    });
    expect(parsed.success).toBe(false);
  });

  it('still rejects a running update with content', () => {
    const parsed = chatToolCallUpdateEventSchema.safeParse({
      ...identity,
      type: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'running',
      content: 'partial',
    });
    expect(parsed.success).toBe(false);
  });

  it('still requires matching canonical facts on terminal updates', () => {
    const mismatched = { ...terminalResult, status: 'error' as const };
    const parsed = chatToolCallUpdateEventSchema.safeParse({
      ...identity,
      type: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'complete',
      content: 'ok',
      toolResult: mismatched,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a terminal update whose outer status and toolResult.status both read complete', () => {
    const parsed = chatToolCallUpdateEventSchema.safeParse({
      ...identity,
      type: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'complete',
      content: 'ok',
      toolResult: terminalResult,
    });
    expect(parsed.success).toBe(true);
  });
});
