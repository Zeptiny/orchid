import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/shared/types/agent';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import type { ProjectRuntime } from '../../src/main/project/runtime';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(() => ({ default_project_dir: null })),
  getSessionManager: vi.fn(() => ({
    getSession: vi.fn(() => ({ cwd: null })),
    getActive: vi.fn(() => ({ cwd: null })),
  })),
  runtimeRegistry: { get: vi.fn() },
  hydrateProjectRuntime: vi.fn(async <T>(runtime: T) => runtime),
}));

vi.mock('../../src/main/config/loader', () => ({
  getConfig: mocks.getConfig,
}));

vi.mock('../../src/main/ipc/session', () => ({
  getSessionManager: mocks.getSessionManager,
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => mocks.runtimeRegistry,
  hydrateProjectRuntime: mocks.hydrateProjectRuntime,
}));

import { createSubagentStreamRunner } from '../../src/main/agents/subagent-runner';

const agent: Agent = {
  name: 'worker',
  type: 'subagent',
  tier: 'bloom',
  description: 'Test worker',
  system_prompt: 'Test prompt',
  allowed_tools: [],
  allowed_skills: [],
};

const selection = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelId: 'vendor/path/model',
};

function runtime(overrides: Partial<Record<string, unknown>> = {}): ProjectRuntime {
  return {
    projectDir: '/tmp/project',
    config: {
      default_model: null,
      tier_models: { bloom: null },
      ...overrides,
    },
    agents: new Map(),
    skills: new Map(),
    personalities: new Map(),
  } as unknown as ProjectRuntime;
}

async function collect(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('createSubagentStreamRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({ default_project_dir: null });
  });

  it('rejects a missing parent session before resolving a runtime', async () => {
    const events = await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-1',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    expect(events).toEqual([{
      type: 'error',
      title: 'Missing session',
      detail: expect.stringContaining('explicit parent session id'),
    }]);
    expect(mocks.hydrateProjectRuntime).not.toHaveBeenCalled();
  });

  it('rejects a subagent with no frozen or parent workspace', async () => {
    const events = await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-2',
      sessionId: 'session-2',
    }));

    expect(events).toEqual([{
      type: 'error',
      title: 'No workspace',
      detail: expect.stringContaining('project working directory'),
    }]);
    expect(mocks.hydrateProjectRuntime).not.toHaveBeenCalled();
  });

  it('requires a typed selection before attempting driver execution', async () => {
    const events = await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection: null,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-3',
      sessionId: 'session-3',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    expect(events).toEqual([{
      type: 'error',
      title: 'Provider connection required',
      detail: expect.stringContaining('Connect a provider'),
    }]);
  });

  it('preserves a slash-containing typed selection and fails closed without a driver', async () => {
    const events = await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-4',
      sessionId: 'session-4',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    expect(events).toEqual([{
      type: 'error',
      title: 'Provider driver unavailable',
      detail: expect.stringContaining('not ready for execution'),
    }]);
    expect(mocks.runtimeRegistry.get).not.toHaveBeenCalled();
  });
});
