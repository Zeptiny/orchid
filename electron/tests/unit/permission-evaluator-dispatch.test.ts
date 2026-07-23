import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  providerRuntime: {
    resolveExecution: vi.fn(async () => ({ modelInstance: { provider: 'test' } })),
  },
}));

vi.mock('../../src/main/providers', () => ({
  getProviderRuntime: () => mocks.providerRuntime,
}));

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: vi.fn(async () => ({
    generateText: mocks.generateText,
    wrapLanguageModel: ({ model }: { model: unknown }) => model,
  })),
}));

import { defaults } from '../../src/main/config/schema';
import { sessionPermissionOverrides } from '../../src/main/ipc/permission';
import { executeToolCall } from '../../src/main/llm/tool-dispatch';
import { approvalStore } from '../../src/main/permissions/approval-store';
import type { ProjectRuntime } from '../../src/main/project/runtime';
import { ToolRegistry } from '../../src/main/tools/registry';
import type { Agent } from '../../src/shared/types/agent';
import { genericToolResultDataSchema } from '../../src/shared/types/tool-result';

const sessionId = 'permission-evaluator-session';
const selection = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelId: 'test/model',
};
const evaluatorAgent: Agent = {
  name: 'permission-evaluator',
  type: 'internal',
  tier: 'seed',
  description: 'Evaluate permission calls',
  system_prompt: 'Return JSON',
  allowed_tools: [],
  allowed_skills: [],
};

function runtime(): ProjectRuntime {
  return {
    projectDir: '/tmp/orchid-permission-evaluator',
    config: {
      ...defaults(),
      tier_models: { seed: selection },
      permission_history_size: 2,
    },
    agents: new Map([[evaluatorAgent.name, evaluatorAgent]]),
    skills: new Map(),
    personalities: new Map(),
  };
}

describe('decide-for-me evaluator dispatch', () => {
  let registry: ToolRegistry;
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionPermissionOverrides.set(sessionId, 'decide-for-me');
    registry = new ToolRegistry();
    handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'done' },
    }));
    registry.register(
      {
        name: 'web_fetch',
        description: 'Fetch a URL',
        inputSchema: z.object({ url: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'network',
        riskClass: 'network',
      },
      handler,
    );
  });

  afterEach(() => {
    sessionPermissionOverrides.delete(sessionId);
    approvalStore.cleanupAll();
    vi.restoreAllMocks();
  });

  it('executes after an explicit evaluator approval without human approval', async () => {
    mocks.generateText.mockResolvedValue({
      text: '{"decision":"approve","reason":"matches the request"}',
    });
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'denied' });

    const result = await executeToolCall(
      { id: 'explicit-allow', name: 'web_fetch', args: { url: 'https://example.test' } },
      registry,
      {
        cwd: '/tmp/orchid-permission-evaluator',
        sessionId,
        projectRuntime: runtime(),
        triggeringMessage: 'Fetch the page',
      },
    );

    expect(result.canonical.status).toBe('complete');
    expect(approval).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('keeps an explicit evaluator denial final and includes its reason', async () => {
    mocks.generateText.mockResolvedValue({
      text: '{"decision":"deny","reason":"not requested"}',
    });
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'approved' });

    const result = await executeToolCall(
      { id: 'explicit-deny', name: 'web_fetch', args: { url: 'https://example.test' } },
      registry,
      {
        cwd: '/tmp/orchid-permission-evaluator',
        sessionId,
        projectRuntime: runtime(),
        triggeringMessage: 'Do something else',
      },
    );

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('not requested');
    expect(approval).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed output', () => mocks.generateText.mockResolvedValue({ text: 'not json' })],
    ['provider invocation failure', () => mocks.generateText.mockRejectedValue(new Error('timeout'))],
    ['provider resolution failure', () => mocks.providerRuntime.resolveExecution.mockRejectedValueOnce(new Error('offline'))],
  ])('falls back to human approval on %s', async (_label, arrange) => {
    arrange();
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'approved' });

    const result = await executeToolCall(
      { id: 'fallback', name: 'web_fetch', args: { url: 'https://example.test' } },
      registry,
      {
        cwd: '/tmp/orchid-permission-evaluator',
        sessionId,
        projectRuntime: runtime(),
        triggeringMessage: 'Fetch the page',
      },
    );

    expect(result.canonical.status).toBe('complete');
    expect(approval).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('routes oversized arguments with a dangerous suffix to human approval without invoking the evaluator', async () => {
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'approved' });
    const url = `https://example.test/${'a'.repeat(2100)}?action=delete-all-data`;

    const result = await executeToolCall(
      { id: 'oversized-args', name: 'web_fetch', args: { url } },
      registry,
      {
        cwd: '/tmp/orchid-permission-evaluator',
        sessionId,
        projectRuntime: runtime(),
        triggeringMessage: 'Fetch the page',
      },
    );

    expect(result.canonical.status).toBe('complete');
    expect(mocks.providerRuntime.resolveExecution).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(approval).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('propagates parent cancellation through the evaluator without opening approval or executing', async () => {
    const controller = new AbortController();
    mocks.generateText.mockImplementation(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      });
    });
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'approved' });

    const pending = executeToolCall(
      { id: 'cancelled-evaluator', name: 'web_fetch', args: { url: 'https://example.test' } },
      registry,
      {
        cwd: '/tmp/orchid-permission-evaluator',
        sessionId,
        projectRuntime: runtime(),
        triggeringMessage: 'Fetch the page',
        abortSignal: controller.signal,
      },
    );
    await vi.waitFor(() => expect(mocks.generateText).toHaveBeenCalledOnce());
    controller.abort();

    const result = await pending;
    expect(result.canonical.status).toBe('cancelled');
    expect(result.agentProjection.content).toContain('cancelled');
    expect(approval).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rechecks parent cancellation after an evaluator approval before history and handler execution', async () => {
    const controller = new AbortController();
    mocks.generateText.mockImplementation(async () => {
      controller.abort();
      return { text: '{"decision":"approve"}' };
    });
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'approved' });

    const result = await executeToolCall(
      { id: 'cancelled-after-decision', name: 'web_fetch', args: { url: 'https://example.test' } },
      registry,
      {
        cwd: '/tmp/orchid-permission-evaluator',
        sessionId,
        projectRuntime: runtime(),
        triggeringMessage: 'Fetch the page',
        abortSignal: controller.signal,
      },
    );

    expect(result.canonical.status).toBe('cancelled');
    expect(approval).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
