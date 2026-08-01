import { describe, expect, it, vi } from 'vitest';

import { AgentTier, AgentType, type Agent } from '../../src/shared/types/agent';
import { SubagentManager } from '../../src/main/agents/manager';
import { createBuiltinToolRegistry } from '../../src/main/tools';
import { questionStore } from '../../src/main/tools/ask-question';

const worker: Agent = {
  name: 'question-worker',
  type: AgentType.SUBAGENT,
  tier: AgentTier.BLOOM,
  description: 'Asks the parent for clarification',
  allowed_tools: ['ask_question'],
  allowed_skills: [],
};

const questions = [
  {
    type: 'single' as const,
    title: 'Which path?',
    options: [{ label: 'A' }, { label: 'B' }],
  },
];

describe('subagent ask_question production registry routing', () => {
  it('keeps main-agent questions on the renderer-backed question store', async () => {
    const registry = createBuiltinToolRegistry({ subagentManager: new SubagentManager() });
    const askQuestion = registry.get('ask_question')!;
    const rendererEvent = vi.fn((payload: { toolCallId: string }) => {
      questionStore.cancel(payload.toolCallId);
    });
    questionStore.on('question-asked', rendererEvent);

    try {
      const result = await askQuestion.handler(
        { questions },
        {
          cwd: '/tmp/project',
          sessionId: 'session-main',
          agentScopeId: 'main',
        },
      );

      expect(rendererEvent).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-main',
        questions,
      }));
      expect(result.status).toBe('cancelled');
    } finally {
      questionStore.off('question-asked', rendererEvent);
    }
  });

  it.each([
    {
      name: 'answered',
      answerInput: {
        answers: [{ selected: ['A'], text: null, skipped: false }],
      },
      expectedAskValue: {
        questions,
        answers: [{ selected: ['A'], text: null, skipped: false }],
      },
    },
    {
      name: 'declined',
      answerInput: { decline: true },
      expectedAskValue: { status: 'declined' },
    },
  ])('routes a $name child question through the shared manager without a renderer event', async ({
    answerInput,
    expectedAskValue,
  }) => {
    const manager = new SubagentManager();
    const registry = createBuiltinToolRegistry({ subagentManager: manager });
    const record = manager.spawn('question worker', 'ask the parent', worker, {
      sessionId: 'session-owner',
    });
    manager.markRunning(record.id);

    const askQuestion = registry.get('ask_question')!;
    const waitForSubagent = registry.get('wait_for_subagent')!;
    const answerSubagent = registry.get('answer_subagent')!;
    const rendererEvent = vi.fn((payload: { toolCallId: string }) => {
      questionStore.cancel(payload.toolCallId);
    });
    questionStore.on('question-asked', rendererEvent);

    const originalWait = manager.wait.bind(manager);
    vi.spyOn(manager, 'wait').mockImplementation((ids, options) =>
      originalWait(ids, { ...options, timeoutMs: 30 }),
    );

    try {
      const askPromise = askQuestion.handler(
        { questions },
        {
          cwd: '/tmp/project',
          sessionId: 'session-owner',
          agentScopeId: record.id,
        },
      );
      const waitResult = await waitForSubagent.handler(
        { subagent_ids: [record.id] },
        {
          cwd: '/tmp/project',
          sessionId: 'session-owner',
          agentScopeId: 'main',
        },
      );
      const pending = manager.getPendingQuestion(record.id);
      expect(pending).not.toBeNull();
      const answerResult = await answerSubagent.handler(
        {
          subagent_id: record.id,
          tool_call_id: pending!.toolCallId,
          ...answerInput,
        },
        {
          cwd: '/tmp/project',
          sessionId: 'session-owner',
          agentScopeId: 'main',
        },
      );
      const askResult = await askPromise;

      expect(rendererEvent).not.toHaveBeenCalled();
      expect(waitResult.status).toBe('complete');
      expect(String(waitResult.data.value)).toContain('question_pending');
      expect(String(waitResult.data.value)).toContain(
        `tool_call_id="${pending!.toolCallId}"`,
      );
      expect(answerResult.status).toBe('complete');
      expect(askResult.status).toBe('complete');
      expect(askResult.data.value).toEqual(expectedAskValue);
    } finally {
      questionStore.off('question-asked', rendererEvent);
      manager.cancelOne(record.id);
    }
  });
});
