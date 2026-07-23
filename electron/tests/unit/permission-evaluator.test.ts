import { describe, expect, it, vi } from 'vitest';

import {
  buildEvaluatorPrompt,
  evaluateToolCall,
  parseEvaluatorResponse,
} from '../../src/main/permissions/evaluator';

const baseContext = {
  toolName: 'execute_command',
  riskClass: 'execution',
  args: { command: 'npm test' },
  cwd: '/tmp/project',
  triggeringMessage: 'Run the focused tests',
  recentToolCalls: [
    { name: 'read-old', argsSummary: '{"path":"old"}' },
    { name: 'read-new', argsSummary: '{"path":"new"}' },
  ],
};

describe('permission evaluator', () => {
  it('uses the newest configured history entries and handles a zero limit', () => {
    const newest = buildEvaluatorPrompt(baseContext, { permission_history_size: 1 });
    expect(newest).not.toContain('read-old');
    expect(newest).toContain('read-new');

    const empty = buildEvaluatorPrompt(baseContext, { permission_history_size: 0 });
    expect(empty).not.toContain('read-old');
    expect(empty).not.toContain('read-new');
    expect(empty).toContain('- (none)');
  });

  it('preserves explicit evaluator denial and its reason', () => {
    expect(parseEvaluatorResponse('{"decision":"deny","reason":"outside task"}')).toEqual({
      decision: 'denied',
      reason: 'outside task',
    });
  });

  it('returns fallback-to-ask for malformed output and invocation failure', async () => {
    expect(parseEvaluatorResponse('not json')).toEqual({
      decision: 'fallback-to-ask',
      reason: 'evaluator response unparseable',
    });

    await expect(evaluateToolCall(
      baseContext,
      { permission_history_size: 2 },
      vi.fn().mockRejectedValue(new Error('provider unavailable')),
      'Evaluate safely',
    )).resolves.toEqual({
      decision: 'fallback-to-ask',
      reason: 'evaluator invocation failed',
    });
  });

  it('falls back without invoking the evaluator when complete arguments exceed its budget', async () => {
    const generateText = vi.fn().mockResolvedValue('{"decision":"approve"}');

    await expect(evaluateToolCall(
      {
        ...baseContext,
        args: { command: `${'x'.repeat(2100)} && rm -rf /` },
      },
      { permission_history_size: 2 },
      generateText,
      'Evaluate safely',
    )).resolves.toEqual({
      decision: 'fallback-to-ask',
      reason: 'evaluator arguments exceed the complete-context budget',
    });
    expect(generateText).not.toHaveBeenCalled();
  });
});
