/**
 * Tool IPC handler tests — tool:execute allowlist, zod, workspace binding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { RENDERER_ALLOWED_TOOLS } from '../../src/main/ipc/payload-schemas';
import type { ToolExecutionResult } from '../../src/shared/types/tool-result';
import { genericToolResultDataSchema } from '../../src/shared/types/tool-result';
import { executeToolCall } from '../../src/main/llm/tool-dispatch';
import { sessionPermissionOverrides } from '../../src/main/permissions/session-overrides';
import type { ToolRegistry } from '../../src/main/tools/registry';

const PROJECT_DIR = '/tmp/orchid-tool-ipc-project';
const SESSION_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const handler = vi.fn(async () => ({
    status: 'complete' as const,
    data: { value: 'ok', origin: { kind: 'built-in' as const, name: 'test' } },
  }));
  const validate = vi.fn((name: string, args: unknown) => ({
    ok: true as const,
    data: args,
  }));
  const get = vi.fn((name: string) => {
    if (name === 'missing-tool') return undefined;
    return {
      handler,
      definition: {
        name,
        riskClass: 'read-only',
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
      },
    };
  });

  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    toolRegistry: {
      get,
      validate,
      listAll: vi.fn(() => []),
      getToolExecutionResultSchema: vi.fn(() => ({ parse: (value: unknown) => value })),
      resolveAgentProjector: vi.fn(() => ({
        source: 'generic',
        projector: (canonical: { data: { value: unknown } }) => ({
          content: String(canonical.data.value),
          completeness: 'complete',
        }),
      })),
    },
    handler,
    validate,
    get,
    resolveBoundProjectPath: vi.fn((): string | null => PROJECT_DIR),
    getActive: vi.fn(() => ({ id: SESSION_UUID })),
    getRuntime: vi.fn(() => ({ projectDir: PROJECT_DIR, config: {} })),
  };
});

vi.mock('electron', () => ({ ipcMain: mocks.ipcMain }));

vi.mock('../../src/main/tools', () => ({
  toolRegistry: mocks.toolRegistry,
}));

vi.mock('../../src/main/ipc/session', () => ({
  resolveBoundProjectPath: mocks.resolveBoundProjectPath,
  getSessionManager: () => ({ getActive: mocks.getActive }),
}));

// The trust gate is fail-closed for the mocked (non-existent) project dir,
// so this fixture resolves as trusted to keep the suite on its own seams.
vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: () => 'trusted',
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({ get: mocks.getRuntime }),
}));

let toolIpc: typeof import('../../src/main/ipc/tool');

beforeEach(async () => {
  mocks.handlers.clear();
  mocks.handler.mockClear();
  mocks.handler.mockResolvedValue({
    status: 'complete',
    data: { value: 'ok', origin: { kind: 'built-in', name: 'test' } },
  });
  mocks.validate.mockClear();
  mocks.validate.mockImplementation((name: string, args: unknown) => ({
    ok: true as const,
    data: args,
  }));
  mocks.get.mockClear();
  mocks.get.mockImplementation((name: string) => {
    if (name === 'missing-tool') return undefined;
    return {
      handler: mocks.handler,
      definition: {
        name,
        riskClass: 'read-only',
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
      },
    };
  });
  mocks.resolveBoundProjectPath.mockReset();
  mocks.resolveBoundProjectPath.mockReturnValue(PROJECT_DIR);
  mocks.getActive.mockReset();
  mocks.getActive.mockReturnValue({ id: SESSION_UUID });
  mocks.getRuntime.mockClear();
  sessionPermissionOverrides.set(SESSION_UUID, 'allow');
  toolIpc = await import('../../src/main/ipc/tool');
  toolIpc.registerToolIPC();
});

afterEach(() => {
  sessionPermissionOverrides.delete(SESSION_UUID);
  toolIpc.unregisterToolIPC();
});

function getHandler() {
  const handler = mocks.handlers.get(IPC_CHANNELS.TOOL_EXECUTE);
  if (!handler) throw new Error('tool:execute handler not registered');
  return handler;
}

function event(windowId = 7) {
  return { sender: { id: windowId } };
}

async function execute(payload: unknown, windowId = 7) {
  return getHandler()(event(windowId), payload);
}

describe('tool:execute zod validation', () => {
  it('rejects empty tool name', async () => {
    await expect(execute({ name: '', args: {} })).rejects.toThrow(
      /Invalid tool:execute payload/i,
    );
  });

  it('rejects missing name', async () => {
    await expect(execute({ args: {} })).rejects.toThrow(/Invalid tool:execute payload/i);
  });

  it('rejects non-object payload', async () => {
    await expect(execute(null)).rejects.toThrow(/Invalid tool:execute payload/i);
  });
});

describe('tool:execute allowlist', () => {
  it('blocks write and other non-allowlisted tools', async () => {
    for (const name of ['write', 'edit', 'execute_command', 'web_fetch', 'delegate']) {
      const result = await execute({ name, args: {} }) as ToolExecutionResult;
      expect(result.canonical.status).toBe('error');
      expect(result.canonical.error?.message).toMatch(/not allowed via IPC/i);
      expect(mocks.handler).not.toHaveBeenCalled();
    }
  });

  it('allows every RENDERER_ALLOWED_TOOLS entry through the registry path', async () => {
    for (const name of RENDERER_ALLOWED_TOOLS) {
      mocks.handler.mockClear();
      const result = await execute({ name, args: { path: 'x' } }) as ToolExecutionResult;
      expect(result.canonical.status).toBe('complete');
      expect(result.agentProjection.content).toBe('ok');
      expect(mocks.handler).toHaveBeenCalledTimes(1);
    }
  });
});

describe('tool:execute workspace ownership', () => {
  it('returns error when no project folder is bound', async () => {
    mocks.resolveBoundProjectPath.mockReturnValue(null);

    const result = await execute({ name: 'read', args: { path: 'a.ts' } }) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.canonical.error?.message).toMatch(/No project folder selected/i);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('passes cwd and sessionId from the sender window into the handler', async () => {
    await execute({ name: 'glob', args: { pattern: '**/*' } }, 42);

    expect(mocks.resolveBoundProjectPath).toHaveBeenCalledWith('42');
    expect(mocks.handler).toHaveBeenCalledWith(
      { pattern: '**/*' },
      expect.objectContaining({
        cwd: PROJECT_DIR,
        sessionId: SESSION_UUID,
        agentScopeId: 'main',
      }),
    );
  });
});

describe('tool:execute registry validation', () => {
  it('matches canonical agent dispatch for the same registered handler outcome', async () => {
    const viaIpc = await execute({ name: 'read', args: { path: 'x' } }) as ToolExecutionResult;
    const viaAgent = await executeToolCall(
      {
        id: 'direct-equivalence',
        name: 'read',
        args: { path: 'x' },
      },
      mocks.toolRegistry as unknown as ToolRegistry,
      { cwd: PROJECT_DIR, sessionId: SESSION_UUID, agentScopeId: 'main' },
    );

    expect(viaIpc).toEqual(viaAgent);
  });

  it('returns not-found when allowlisted name is absent from registry', async () => {
    mocks.get.mockReturnValueOnce(undefined);

    const result = await execute({ name: 'read', args: {} }) as ToolExecutionResult;
    expect(result.canonical.status).toBe('error');
    expect(result.canonical.error?.message).toMatch(/not found in registry/i);
  });

  it('returns validation error without invoking handler', async () => {
    mocks.validate.mockReturnValueOnce({
      ok: false as const,
      error: 'path is required',
    });

    const result = await execute({ name: 'read', args: {} }) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.canonical.error?.message).toBe('path is required');
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('surfaces handler throws as isError results', async () => {
    mocks.handler.mockRejectedValueOnce(new Error('disk full'));

    const result = await execute({ name: 'read', args: { path: 'x' } }) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.canonical.error?.code).toBe('handler_exception');
    expect(result.canonical.error?.message).not.toContain('disk full');
  });
});
