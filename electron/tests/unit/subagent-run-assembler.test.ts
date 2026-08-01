import { describe, expect, it } from 'vitest';
import { MessageType, type Usage } from '../../src/shared/types/message';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';
import {
  SubagentRunAssembler,
  type SubagentRunFinalization,
} from '../../src/main/agents/subagent-run-assembler';
import type { StreamEvent } from '../../src/main/llm/orchestrator';

const usage = (prompt_tokens: number, completion_tokens: number): Usage => ({
  prompt_tokens,
  completion_tokens,
  total_tokens: prompt_tokens + completion_tokens,
  cached_tokens: 0,
});

function toolResult(toolCallId: string, content: string): Extract<StreamEvent, { type: 'tool_result' }> {
  return {
    type: 'tool_result',
    toolCallId,
    content,
    execution: {
      canonical: createCanonicalToolResult('generic', {
        status: 'complete',
        data: { content },
      }),
      agentProjection: { content, completeness: 'complete' },
    },
  };
}

function assembler(): SubagentRunAssembler {
  let id = 0;
  return new SubagentRunAssembler([], {
    newId: () => `segment-${++id}`,
    now: () => '2026-08-01T00:00:00.000Z',
  });
}

function messages(finalization: SubagentRunFinalization) {
  return finalization.messages.map((message) => ({
    type: message.type,
    content: message.content,
    toolCallId: message.tool_call_id,
    name: message.name,
    id: message.id,
  }));
}

describe('SubagentRunAssembler', () => {
  it('preserves interleaved text, thinking, and paired tools in durable order', () => {
    const run = assembler();

    run.accept({ type: 'content', text: 'Before tool. ' });
    run.accept({ type: 'thinking', text: 'Need to inspect.' });
    run.accept({ type: 'tool_call_start', toolCallId: 'tool-1', toolName: 'grep' });
    run.accept({ type: 'tool_call_delta', toolCallId: 'tool-1', argsDelta: '{"pattern":' });
    run.accept({ type: 'tool_call', toolCallId: 'tool-1', toolName: 'grep', args: '{"pattern":"todo"}' });
    run.accept(toolResult('tool-1', 'one match'));
    run.accept({ type: 'content', text: 'Found it.' });

    const finalization = run.complete();

    expect(messages(finalization)).toEqual([
      { type: MessageType.TEXT, content: 'Before tool. ', toolCallId: null, name: null, id: 'segment-1' },
      { type: MessageType.THINKING, content: 'Need to inspect.', toolCallId: null, name: null, id: 'segment-2' },
      { type: MessageType.TOOL_CALL, content: '', toolCallId: 'tool-1', name: 'grep', id: 'segment-3' },
      { type: MessageType.TOOL_RESULT, content: 'one match', toolCallId: 'tool-1', name: 'grep', id: 'tool-1:result' },
      { type: MessageType.TEXT, content: 'Found it.', toolCallId: null, name: null, id: 'segment-4' },
    ]);
    expect(finalization.result).toBe('Before tool. Found it.');
  });

  it('preserves content between overlapping tool starts when the earlier call materializes', () => {
    const run = assembler();

    const [startA] = run.accept({ type: 'tool_call_start', toolCallId: 'tool-a', toolName: 'read' });
    const [content] = run.accept({ type: 'content', text: 'Between tools.' });
    const [startB] = run.accept({ type: 'tool_call_start', toolCallId: 'tool-b', toolName: 'grep' });
    run.accept({ type: 'tool_call', toolCallId: 'tool-a', toolName: 'read', args: '{}' });

    const finalization = run.complete();

    expect([startA, content, startB].map((effect) => 'segmentId' in effect ? effect.segmentId : null))
      .toEqual(['segment-1', 'segment-2', 'segment-3']);
    expect(messages(finalization)).toEqual([
      { type: MessageType.TOOL_CALL, content: '', toolCallId: 'tool-a', name: 'read', id: 'segment-1' },
      { type: MessageType.TEXT, content: 'Between tools.', toolCallId: null, name: null, id: 'segment-2' },
    ]);
  });

  it('uses the latest text-producing step as the final result', () => {
    const run = assembler();

    run.accept({ type: 'content', text: 'Draft answer.' });
    run.accept({ type: 'step_finish', stepIndex: 0, finishReason: 'tool-calls' });
    run.accept({ type: 'content', text: 'Final answer.' });
    run.accept({ type: 'step_finish', stepIndex: 1, finishReason: 'tool-calls' });
    run.accept({ type: 'tool_call', toolCallId: 'tool-2', toolName: 'read', args: '{}' });
    run.accept(toolResult('tool-2', 'read complete'));
    run.accept({ type: 'step_finish', stepIndex: 2, finishReason: 'stop' });

    expect(run.complete().result).toBe('Final answer.');
  });

  it('finalizes interrupted and failed streams with their partial ordered transcript and usage', () => {
    const interrupted = assembler();
    interrupted.accept({ type: 'thinking', text: 'Reasoning.' });
    interrupted.accept({ type: 'content', text: 'Partial answer.' });
    interrupted.accept({ type: 'usage', usage: usage(3, 2) });

    const interruptedFinalization = interrupted.interrupt();

    expect(messages(interruptedFinalization)).toEqual([
      { type: MessageType.THINKING, content: 'Reasoning.', toolCallId: null, name: null, id: 'segment-1' },
      { type: MessageType.TEXT, content: 'Partial answer.', toolCallId: null, name: null, id: 'segment-2' },
    ]);
    expect(interruptedFinalization.result).toBe('Partial answer.');
    expect(interruptedFinalization.usage).toEqual(usage(3, 2));

    const failed = assembler();
    failed.accept({ type: 'content', text: 'Before failure.' });
    failed.accept({ type: 'thinking', text: 'Still thinking.' });
    failed.accept({ type: 'usage', usage: usage(5, 7) });

    const failedFinalization = failed.fail('provider failed');

    expect(messages(failedFinalization)).toEqual([
      { type: MessageType.TEXT, content: 'Before failure.', toolCallId: null, name: null, id: 'segment-1' },
      { type: MessageType.THINKING, content: 'Still thinking.', toolCallId: null, name: null, id: 'segment-2' },
    ]);
    expect(failedFinalization.error).toBe('provider failed');
    expect(failedFinalization.usage).toEqual(usage(5, 7));
  });
});
