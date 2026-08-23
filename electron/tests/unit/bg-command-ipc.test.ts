/**
 * User control and live snapshot IPC surface (U3).
 *
 * Drives the real `registerChatIPC` handlers against a real
 * `BackgroundProcessStore` (via `setBackgroundStore`) and a real
 * `ForegroundLiveRegistry` (via `setForegroundLiveRegistry`), preferring real
 * spawned child processes and PTYs over mocks. Electron is mocked the same
 * way as `chat-ipc.test.ts`: ipcMain handlers land in a map keyed by channel
 * and `BrowserWindow.getAllWindows` returns controllable fake windows, so the
 * `bgcmd:changed` broadcast can be asserted at the webContents.send seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import {
  BackgroundProcessStore,
  setBackgroundStore,
} from '../../src/main/tools/process/background-store';
import {
  ForegroundLiveRegistry,
  setForegroundLiveRegistry,
} from '../../src/main/tools/process/foreground-live';
import {
  executeSendInput as executeSendInputRaw,
  SEND_INPUT_MAX_TEXT_LENGTH,
  sendInputSchema,
  sendInputToolDefinition,
} from '../../src/main/tools/process/send-input';
import { finalizeToolExecutionResult } from '../../src/main/tools/result';
import {
  createCanonicalToolResult,
  type GenericToolResultData,
  type ToolHandlerOutcome,
} from '../../src/shared/types/tool-result';
import { defaults } from '../../src/main/config';
import {
  disposeIndexRefreshCoordinator,
  _setIndexRefreshCoordinatorForTests,
} from '../../src/main/indexing/refresh-coordinator';
import type {
  BgCommandListResult,
  BgCommandReleaseInputResult,
  BgCommandSendInputResult,
  BgCommandSnapshotResult,
  BgCommandTerminateResult,
} from '../../src/shared/types/ipc';

/**
 * Agent-side `send_input` result with the same canonical + projection shape
 * the tool dispatch layer produces (the `search-process-tools.test.ts` seam).
 */
async function agentSendInput(...args: Parameters<typeof executeSendInputRaw>) {
  const outcome = await executeSendInputRaw(...args);
  return finalizeToolExecutionResult({
    canonical: createCanonicalToolResult(
      'generic',
      outcome as ToolHandlerOutcome<GenericToolResultData>,
    ),
    toolName: sendInputToolDefinition.name,
    outputDataSchema: sendInputToolDefinition.outputDataSchema,
    expectedFamily: sendInputToolDefinition.resultFamily,
  });
}

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const WINDOW_SENDER_ID = 42;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const windows: Array<{
    isDestroyed: () => boolean;
    webContents: { id: number; send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean };
  }> = [];
  const activeSessionsByWindow = new Map<string, { id: string } | null>();
  const subagentStatesBySession = new Map<string, Array<Record<string, unknown>>>();

  const sessionManager = {
    getActive: vi.fn((windowId?: string) =>
      windowId === undefined ? null : activeSessionsByWindow.get(windowId) ?? null,
    ),
    _setActiveForWindow(windowId: string, session: { id: string } | null) {
      activeSessionsByWindow.set(windowId, session);
    },
    _reset() {
      activeSessionsByWindow.clear();
      sessionManager.getActive.mockClear();
    },
  };

  const subagentManager = {
    cancelRunning: vi.fn(() => []),
    getStates: vi.fn((sessionId?: string | null) =>
      subagentStatesBySession.get(sessionId ?? '') ?? [],
    ),
    _setStates(sessionId: string, states: Array<Record<string, unknown>>) {
      subagentStatesBySession.set(sessionId, states);
    },
    _reset() {
      subagentStatesBySession.clear();
      subagentManager.getStates.mockClear();
      subagentManager.cancelRunning.mockClear();
    },
  };

  const toolRegistry = {
    filter: vi.fn(() => []),
    get: vi.fn(() => null),
    validate: vi.fn(() => ({ ok: true as const, data: {} })),
  };

  return {
    handlers,
    windows,
    sessionManager,
    subagentManager,
    toolRegistry,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    streamChat: vi.fn(async function* () {}),
    providerRuntime: {
      resolveLanguageModel: vi.fn(),
      resolveExecution: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: {
    getAllWindows: vi.fn(() => mocks.windows),
  },
  webContents: {
    fromId: vi.fn(() => null),
    getAllWebContents: vi.fn(() => []),
  },
}));

vi.mock('../../src/main/config/loader', () => ({
  HOME_PERSONALITIES_DIR: '/tmp/orchid-test-personalities',
  getTierModelSelection: (
    config: { default_model: unknown; tier_models: Record<string, unknown> },
    tier: string,
  ) => config.tier_models[tier] ?? config.default_model,
  getConfig: vi.fn(() => ({
    default_model: null,
    tier_models: { bloom: null },
    command_timeout: 30,
    llm_stream_idle_timeout: 60,
    llm_stream_retries: 0,
    max_background_processes: 64,
  })),
}));

vi.mock('../../src/main/tools', () => ({
  toolRegistry: mocks.toolRegistry,
  createBuiltinToolRegistry: vi.fn(() => mocks.toolRegistry),
  getBuiltinToolRegistryForRuntime: vi.fn(() => mocks.toolRegistry),
  getSubagentManager: vi.fn(() => mocks.subagentManager),
}));

vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: mocks.streamChat,
}));

vi.mock('../../src/main/llm/middleware', () => ({
  createMiddlewareStack: vi.fn(() => []),
}));

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: vi.fn(async () => ({})),
}));

vi.mock('../../src/main/providers', () => ({
  getProviderRuntime: () => mocks.providerRuntime,
}));

vi.mock('../../src/main/providers/accounting/store', () => ({
  getProviderAccountingStore: () => ({}),
}));

vi.mock('../../src/main/llm/build-prompt-context', () => ({
  buildSystemPromptContext: vi.fn(async () => ({})),
}));

vi.mock('../../src/main/mcp/project-registry', () => ({
  acquireProjectMCPManager: vi.fn(() => ({})),
  releaseProjectMCPManager: vi.fn(),
}));

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => mocks.sessionManager,
  resolveWindowWorkspace: vi.fn(),
}));

vi.mock('../../src/main/session/draft-reasoning', () => ({
  takeDraftReasoningOverride: vi.fn(),
}));

vi.mock('../../src/main/permissions/session-overrides', () => ({
  takeDraftPermissionOverride: vi.fn(),
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({ get: vi.fn() }),
}));

vi.mock('../../src/main/ipc/session-activity', () => ({
  publishSessionActivity: vi.fn(),
  completeSessionActivity: vi.fn(),
}));

vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: () => 'trusted',
}));

vi.mock('../../src/main/project/workspace', () => ({
  resolveWorkspace: vi.fn(),
  isWorkspaceBound: vi.fn(() => true),
  clearDraftCwd: vi.fn(),
  setDraftCwd: vi.fn(),
  getDraftCwd: vi.fn(() => null),
  clearAllDraftCwds: vi.fn(),
  updateStickyDefaultProjectDir: vi.fn(),
  requireValidProjectDirectory: vi.fn((dir: string) => dir),
  resolveWorkspaceFromParts: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

let chatIpc: typeof import('../../src/main/ipc/chat');
let store: BackgroundProcessStore;
let registry: ForegroundLiveRegistry;

function makeWindow(): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  mocks.windows.push({
    isDestroyed: () => false,
    webContents: { id: mocks.windows.length + 1, send, isDestroyed: () => false },
  });
  return send;
}

async function invokeChannel<T = unknown>(channel: string, payload: unknown): Promise<T> {
  const handler = mocks.handlers.get(channel);
  expect(handler, `handler registered for ${channel}`).toBeDefined();
  return (await handler!({ sender: { id: WINDOW_SENDER_ID } }, payload)) as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCondition(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error('Timed out waiting for condition');
}

async function waitForExit(procId: number, timeoutMs = 4000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = store.get(procId);
    if (!entry) return null;
    if (entry.exitCode !== null) return entry.exitCode;
    await sleep(20);
  }
  return store.get(procId)?.exitCode ?? null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.windows.length = 0;
  mocks.sessionManager._reset();
  mocks.subagentManager._reset();
  // Background spawns in this suite exit (naturally or via store.clear()) and
  // the store's exit path marks process.cwd() dirty in the index-refresh
  // coordinator. Pin the debounce high so no real flush can fire mid-test.
  _setIndexRefreshCoordinatorForTests({
    configLoader: () => ({
      ...defaults(),
      index_refresh: { ...defaults().index_refresh, debounce_ms: 60_000 },
    }),
  });
  store = new BackgroundProcessStore();
  setBackgroundStore(store);
  registry = new ForegroundLiveRegistry();
  setForegroundLiveRegistry(registry);
  chatIpc = await import('../../src/main/ipc/chat');
  chatIpc.registerChatIPC();
});

afterEach(() => {
  chatIpc.unregisterChatIPC();
  store.clear();
  registry.clear();
  disposeIndexRefreshCoordinator();
});

// ── Snapshot target discrimination ───────────────────────────────────────────

describe('bgcmd:snapshot target discrimination', () => {
  it('rejects a payload with neither commandId nor toolCallId', async () => {
    await expect(
      invokeChannel(IPC_CHANNELS.BG_CMD_SNAPSHOT, { sessionId: SESSION_A }),
    ).rejects.toThrow(/exactly one of commandId or toolCallId/i);
  });

  it('rejects a payload with both commandId and toolCallId', async () => {
    await expect(
      invokeChannel(IPC_CHANNELS.BG_CMD_SNAPSHOT, {
        commandId: 1,
        toolCallId: 'call-1',
        sessionId: SESSION_A,
      }),
    ).rejects.toThrow(/exactly one of commandId or toolCallId/i);
  });

  it('rejects a non-positive commandId', async () => {
    await expect(
      invokeChannel(IPC_CHANNELS.BG_CMD_SNAPSHOT, { commandId: 0, sessionId: SESSION_A }),
    ).rejects.toThrow(/Invalid bgcmd:snapshot payload/i);
  });

  it('rejects an empty toolCallId', async () => {
    await expect(
      invokeChannel(IPC_CHANNELS.BG_CMD_SNAPSHOT, { toolCallId: '', sessionId: SESSION_A }),
    ).rejects.toThrow(/Invalid bgcmd:snapshot payload/i);
  });

  it('accepts a commandId-only target', async () => {
    const result = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { commandId: 999, sessionId: SESSION_A },
    );
    expect(result).toEqual({ found: false });
  });

  it('accepts a toolCallId-only target', async () => {
    const result = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { toolCallId: 'call-unknown', sessionId: SESSION_A },
    );
    expect(result).toEqual({ found: false });
  });
});

// ── Snapshot by commandId ────────────────────────────────────────────────────

describe('bgcmd:snapshot by commandId', () => {
  it('returns enriched metadata for a visible background command', async () => {
    const procId = await store.spawn('echo hello; sleep 30', {
      sessionId: SESSION_A,
      agentScopeId: 'main',
      description: 'greeter',
    });
    await waitForCondition(() => (store.snapshot(procId)?.tail ?? '').includes('hello'));

    const result = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { commandId: procId, sessionId: SESSION_A },
    );

    expect(result).toMatchObject({
      found: true,
      tail: expect.stringContaining('hello'),
      exitCode: null,
      running: true,
      interactive: false,
      owner: 'AGENT',
      command: 'echo hello; sleep 30',
      description: 'greeter',
      agentScopeId: 'main',
      // Restart-stable spawn identity comes from the store entry.
      createdAt: store.get(procId)!.createdAt,
    });
  });

  it('falls back to the calling window active session when sessionId is omitted', async () => {
    mocks.sessionManager._setActiveForWindow(String(WINDOW_SENDER_ID), { id: SESSION_A });
    const procId = await store.spawn('echo window-scoped; sleep 30', { sessionId: SESSION_A });
    await waitForCondition(() => (store.snapshot(procId)?.tail ?? '').includes('window-scoped'));

    const result = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { commandId: procId },
    );

    expect(result).toMatchObject({ found: true, running: true });
  });

  it('denies cross-session snapshots in both directions', async () => {
    const procId = await store.spawn('sleep 30', { sessionId: SESSION_A });

    const fromOtherSession = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { commandId: procId, sessionId: SESSION_B },
    );
    expect(fromOtherSession).toEqual({ found: false });

    const unknownId = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { commandId: 99999, sessionId: SESSION_A },
    );
    expect(unknownId).toEqual({ found: false });
  });

  it('returns found:false when no session can be resolved', async () => {
    const procId = await store.spawn('sleep 30', { sessionId: SESSION_A });

    const result = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { commandId: procId },
    );
    expect(result).toEqual({ found: false });
  });
});

// ── Snapshot by toolCallId ───────────────────────────────────────────────────

describe('bgcmd:snapshot by toolCallId', () => {
  it('returns foreground metadata from the live registry', () => {
    registry.register('call-fg-1', {
      command: 'ls -la',
      sessionId: SESSION_A,
      agentScopeId: 'sub-1',
    });
    registry.append('call-fg-1', Buffer.from('output line\n'));

    return invokeChannel<BgCommandSnapshotResult>(IPC_CHANNELS.BG_CMD_SNAPSHOT, {
      toolCallId: 'call-fg-1',
      sessionId: SESSION_A,
    }).then((result) => {
      expect(result).toMatchObject({
        found: true,
        tail: 'output line\n',
        exitCode: null,
        running: true,
        interactive: false,
        owner: 'AGENT',
        command: 'ls -la',
        description: 'ls -la',
        agentScopeId: 'sub-1',
        // Foreground mirrors report their startedAt as the spawn identity.
        createdAt: registry.get('call-fg-1')!.startedAt,
      });
    });
  });

  it('reports finalized foreground entries with their exit code', async () => {
    registry.register('call-fg-done', {
      command: 'make test',
      sessionId: SESSION_A,
      agentScopeId: 'main',
    });
    registry.append('call-fg-done', Buffer.from('all green\n'));
    registry.finalize('call-fg-done', 0);

    const result = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { toolCallId: 'call-fg-done', sessionId: SESSION_A },
    );
    expect(result).toMatchObject({ found: true, running: false, exitCode: 0 });
  });

  it('denies cross-session and unbound foreground snapshots', async () => {
    registry.register('call-fg-2', {
      command: 'ls',
      sessionId: SESSION_A,
      agentScopeId: 'main',
    });
    registry.register('call-fg-unbound', {
      command: 'ls',
      sessionId: null,
      agentScopeId: 'main',
    });

    const crossSession = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { toolCallId: 'call-fg-2', sessionId: SESSION_B },
    );
    expect(crossSession).toEqual({ found: false });

    const unbound = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { toolCallId: 'call-fg-unbound', sessionId: SESSION_A },
    );
    expect(unbound).toEqual({ found: false });

    const unknown = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { toolCallId: 'call-never-registered', sessionId: SESSION_A },
    );
    expect(unknown).toEqual({ found: false });
  });
});

// ── Snapshot includeTail flag ───────────────────────────────────────────────

describe('bgcmd:snapshot includeTail', () => {
  it('returns tail === "" without touching the buffer when includeTail is false (background)', async () => {
    const procId = await store.spawn('echo hello-tail; sleep 30', { sessionId: SESSION_A });
    await waitForCondition(() => (store.snapshot(procId)?.tail ?? '').includes('hello-tail'));

    const result = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { commandId: procId, sessionId: SESSION_A, includeTail: false },
    );

    expect(result).toMatchObject({ found: true, tail: '' });
    // Still returns metadata; tail-less response passes the existing result schema
    expect(result).toMatchObject({ running: true, exitCode: null });
    const found = result as Extract<BgCommandSnapshotResult, { found: true }>;
    // Validate tail-less response against the existing schema (empty string is valid)
    const { bgCommandSnapshotResultSchema } = await import('../../src/shared/types/ipc-schemas');
    expect(bgCommandSnapshotResultSchema.safeParse(result).success).toBe(true);
    // Buffer still has content — a normal snapshot would have returned it
    expect(store.snapshot(procId)?.tail).toContain('hello-tail');
    expect(found.tail).toBe('');
  });

  it('returns tail === "" without touching the buffer when includeTail is false (foreground)', async () => {
    registry.register('call-fg-tail', {
      command: 'foreground-cmd',
      sessionId: SESSION_A,
      agentScopeId: 'main',
    });
    registry.append('call-fg-tail', Buffer.from('foreground-output\n'));

    const result = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { toolCallId: 'call-fg-tail', sessionId: SESSION_A, includeTail: false },
    );

    expect(result).toMatchObject({ found: true, tail: '' });
    const { bgCommandSnapshotResultSchema } = await import('../../src/shared/types/ipc-schemas');
    expect(bgCommandSnapshotResultSchema.safeParse(result).success).toBe(true);
    // Buffer has content but tail-less snapshot hides it
    expect(registry.snapshot('call-fg-tail')?.tail).toContain('foreground-output');
  });

  it('materializes tail when includeTail is true or omitted', async () => {
    const procId = await store.spawn('echo materialize; sleep 30', { sessionId: SESSION_A });
    await waitForCondition(() => (store.snapshot(procId)?.tail ?? '').includes('materialize'));

    const withTrue = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { commandId: procId, sessionId: SESSION_A, includeTail: true },
    );
    expect((withTrue as Extract<BgCommandSnapshotResult, { found: true }>).tail).toContain('materialize');

    const omitted = await invokeChannel<BgCommandSnapshotResult>(
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      { commandId: procId, sessionId: SESSION_A },
    );
    expect((omitted as Extract<BgCommandSnapshotResult, { found: true }>).tail).toContain('materialize');
  });
});

// ── Fleet list ───────────────────────────────────────────────────────────────

describe('bgcmd:list', () => {
  it('lists the session fleet across scopes, running-first and newest-first', async () => {
    mocks.subagentManager._setStates(SESSION_A, [
      { id: 'sub-x', name: 'explorer', type: 'subagent', task: 'look around', state: 'running', elapsed: 12 },
    ]);

    const mainId = await store.spawn('sleep 30', {
      sessionId: SESSION_A,
      agentScopeId: 'main',
      description: 'main sleeper',
    });
    await sleep(10);
    const subId = await store.spawn('sleep 30', {
      sessionId: SESSION_A,
      agentScopeId: 'sub-x',
      description: 'sub sleeper',
    });
    await sleep(10);
    const exitedId = await store.spawn('echo done; exit 0', {
      sessionId: SESSION_A,
      agentScopeId: 'ghost-scope',
      description: 'exited',
    });
    await waitForCondition(() => store.get(exitedId)?.exitCode !== null);
    // Other-session entry must never appear.
    await store.spawn('sleep 30', { sessionId: SESSION_B });

    const items = await invokeChannel<BgCommandListResult>(
      IPC_CHANNELS.BG_CMD_LIST,
      { sessionId: SESSION_A },
    );

    expect(items.map((item) => item.id)).toEqual([subId, mainId, exitedId]);
    expect(items[0]).toMatchObject({
      id: subId,
      command: 'sleep 30',
      description: 'sub sleeper',
      interactive: false,
      owner: 'AGENT',
      agentScopeId: 'sub-x',
      scopeName: 'explorer',
      running: true,
      exitCode: null,
    });
    expect(items[0].createdAt).toBeTypeOf('number');
    expect(items[0].lastOutputAt).toBeTypeOf('number');
    expect(items[1]).toMatchObject({ agentScopeId: 'main', scopeName: 'main', running: true });
    // Unknown scope ids fall back to the raw scope id.
    expect(items[2]).toMatchObject({
      agentScopeId: 'ghost-scope',
      scopeName: 'ghost-scope',
      running: false,
      exitCode: 0,
    });
  });

  it('resolves the session from the active window and returns [] without one', async () => {
    await store.spawn('sleep 30', { sessionId: SESSION_A });

    mocks.sessionManager._setActiveForWindow(String(WINDOW_SENDER_ID), { id: SESSION_A });
    const withActive = await invokeChannel<BgCommandListResult>(IPC_CHANNELS.BG_CMD_LIST, {});
    expect(withActive).toHaveLength(1);

    mocks.sessionManager._setActiveForWindow(String(WINDOW_SENDER_ID), null);
    const withoutSession = await invokeChannel<BgCommandListResult>(IPC_CHANNELS.BG_CMD_LIST, {});
    expect(withoutSession).toEqual([]);
  });
});

// ── User send_input + ownership ──────────────────────────────────────────────

describe('bgcmd:send_input', () => {
  it('rejects non-interactive, exited, and cross-session commands', async () => {
    const plainId = await store.spawn('sleep 30', { sessionId: SESSION_A });
    const exitedId = await store.spawn('exit 3', { sessionId: SESSION_A, interactive: true });
    await waitForCondition(() => store.get(exitedId)?.exitCode !== null);
    const foreignId = await store.spawn('cat', { sessionId: SESSION_B, interactive: true });

    const notInteractive = await invokeChannel<BgCommandSendInputResult>(
      IPC_CHANNELS.BG_CMD_SEND_INPUT,
      { commandId: plainId, text: 'hi\n', sessionId: SESSION_A },
    );
    expect(notInteractive).toEqual({ ok: false, reason: 'not_interactive' });

    const exited = await invokeChannel<BgCommandSendInputResult>(
      IPC_CHANNELS.BG_CMD_SEND_INPUT,
      { commandId: exitedId, text: 'hi\n', sessionId: SESSION_A },
    );
    expect(exited).toEqual({ ok: false, reason: 'exited' });

    const crossSession = await invokeChannel<BgCommandSendInputResult>(
      IPC_CHANNELS.BG_CMD_SEND_INPUT,
      { commandId: foreignId, text: 'hi\n', sessionId: SESSION_A },
    );
    expect(crossSession).toEqual({ ok: false, reason: 'not_found' });

    const unknown = await invokeChannel<BgCommandSendInputResult>(
      IPC_CHANNELS.BG_CMD_SEND_INPUT,
      { commandId: 99999, text: 'hi\n', sessionId: SESSION_A },
    );
    expect(unknown).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports write_failed when the PTY write throws', async () => {
    // Controlled seam: a fake interactive entry whose write throws (the only
    // way to reach write_failed without breaking a real PTY mid-test).
    (store as unknown as { _entries: Map<number, unknown> })._entries.set(9000, {
      id: 9000,
      command: 'fake-interactive',
      process: { write: () => { throw new Error('pipe broken'); } },
      buffer: { getTail: () => '' },
      owner: 'AGENT',
      lastOutputAt: Date.now(),
      lastUserInputAt: Date.now(),
      exitCode: null,
      createdAt: Date.now(),
      interactive: true,
      sessionId: SESSION_A,
      agentScopeId: 'main',
      description: '',
    });

    const result = await invokeChannel<BgCommandSendInputResult>(
      IPC_CHANNELS.BG_CMD_SEND_INPUT,
      { commandId: 9000, text: 'hi\n', sessionId: SESSION_A },
    );
    expect(result).toEqual({ ok: false, reason: 'write_failed' });
    expect(store.get(9000)?.owner).toBe('AGENT');
  });
  it('user send_input does not leave USER ownership on write failure', async () => {
    (store as unknown as { _entries: Map<number, unknown> })._entries.set(9001, {
      id: 9001,
      command: 'fake-interactive-2',
      process: { write: () => { throw new Error('pipe broken'); } },
      buffer: { getTail: () => '' },
      owner: 'AGENT',
      lastOutputAt: Date.now(),
      lastUserInputAt: 12345,
      exitCode: null,
      createdAt: Date.now(),
      interactive: true,
      sessionId: SESSION_A,
      agentScopeId: 'main',
      description: '',
    });

    const beforeAt = 12345;
    const result = await invokeChannel<BgCommandSendInputResult>(
      IPC_CHANNELS.BG_CMD_SEND_INPUT,
      { commandId: 9001, text: 'hi\n', sessionId: SESSION_A },
    );
    expect(result).toEqual({ ok: false, reason: 'write_failed' });
    const entry = store.get(9001)!;
    expect(entry.owner).toBe('AGENT');
    expect(entry.lastUserInputAt).toBe(beforeAt);
  });


  it('sends input to a running PTY, takes USER ownership, and blocks agent input', async () => {
    const procId = await store.spawn('cat', {
      sessionId: SESSION_A,
      agentScopeId: 'sub-x',
      interactive: true,
      description: 'echo bot',
    });
    await waitForCondition(() => {
      const entry = store.get(procId);
      return entry !== undefined && entry.interactive && entry.exitCode === null;
    });

    const result = await invokeChannel<BgCommandSendInputResult>(
      IPC_CHANNELS.BG_CMD_SEND_INPUT,
      { commandId: procId, text: 'ping\n', sessionId: SESSION_A },
    );
    expect(result).toEqual({ ok: true });

    const entry = store.get(procId)!;
    expect(entry.owner).toBe('USER');
    expect(entry.lastUserInputAt).toBeGreaterThanOrEqual(entry.createdAt);
    // The text actually reached the PTY.
    await waitForCondition(() => (store.snapshot(procId)?.tail ?? '').includes('ping'));

    // Session privilege reached a subagent scope; the agent-side tool is still
    // scope-gated and additionally rejects while the user owns the input.
    const agentBlocked = await agentSendInput(procId, 'agent line\n', SESSION_A, 'sub-x');
    expect(agentBlocked.canonical.status).toBe('error');
    expect(agentBlocked.agentProjection.content).toContain('control: USER');

    // release_input restores agent access.
    const released = await invokeChannel<BgCommandReleaseInputResult>(
      IPC_CHANNELS.BG_CMD_RELEASE_INPUT,
      { commandId: procId, sessionId: SESSION_A },
    );
    expect(released).toEqual({ ok: true });
    expect(store.get(procId)!.owner).toBe('AGENT');

    const agentUnblocked = await agentSendInput(procId, 'agent line\n', SESSION_A, 'sub-x');
    expect(agentUnblocked.canonical.status).toBe('complete');
  });

  it('rejects an oversized text payload at the IPC boundary', async () => {
    const oversized = 'x'.repeat(SEND_INPUT_MAX_TEXT_LENGTH + 1);
    await expect(
      invokeChannel(
        IPC_CHANNELS.BG_CMD_SEND_INPUT,
        { commandId: 1, text: oversized, sessionId: SESSION_A },
      ),
    ).rejects.toThrow(/Invalid bgcmd:send_input payload/i);
  });

  it('accepts text exactly at the cap and continues to normal processing', async () => {
    const atCap = 'x'.repeat(SEND_INPUT_MAX_TEXT_LENGTH);
    const result = await invokeChannel<BgCommandSendInputResult>(
      IPC_CHANNELS.BG_CMD_SEND_INPUT,
      { commandId: 99999, text: atCap, sessionId: SESSION_A },
    );
    // Schema passed; the unknown command then fails normal processing.
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('agent send_input schema rejects oversized text (parity with the IPC cap)', () => {
    const oversized = 'x'.repeat(SEND_INPUT_MAX_TEXT_LENGTH + 1);
    expect(sendInputSchema.safeParse({ id: 1, text: oversized }).success).toBe(false);
    expect(sendInputSchema.safeParse({ id: 1, text: 'ok\n' }).success).toBe(true);
  });
});

// ── release_input edge cases ─────────────────────────────────────────────────

describe('bgcmd:release_input', () => {
  it('returns ok:false for cross-session and unknown commands', async () => {
    const procId = await store.spawn('sleep 30', { sessionId: SESSION_A });

    const crossSession = await invokeChannel<BgCommandReleaseInputResult>(
      IPC_CHANNELS.BG_CMD_RELEASE_INPUT,
      { commandId: procId, sessionId: SESSION_B },
    );
    expect(crossSession).toEqual({ ok: false });

    const unknown = await invokeChannel<BgCommandReleaseInputResult>(
      IPC_CHANNELS.BG_CMD_RELEASE_INPUT,
      { commandId: 99999, sessionId: SESSION_A },
    );
    expect(unknown).toEqual({ ok: false });
  });
});

// ── User terminate ───────────────────────────────────────────────────────────

describe('bgcmd:terminate', () => {
  it('terminates a subagent-scoped command via session privilege', async () => {
    const procId = await store.spawn('sleep 30', {
      sessionId: SESSION_A,
      agentScopeId: 'sub-x',
    });
    expect(store.get(procId)!.exitCode).toBeNull();

    const result = await invokeChannel<BgCommandTerminateResult>(
      IPC_CHANNELS.BG_CMD_TERMINATE,
      { commandId: procId, sessionId: SESSION_A },
    );
    expect(result).toEqual({ ok: true });
    expect(await waitForExit(procId)).not.toBeNull();
  });

  it('denies cross-session and unknown terminate without killing the command', async () => {
    const procId = await store.spawn('sleep 30', { sessionId: SESSION_A });

    const crossSession = await invokeChannel<BgCommandTerminateResult>(
      IPC_CHANNELS.BG_CMD_TERMINATE,
      { commandId: procId, sessionId: SESSION_B },
    );
    expect(crossSession).toEqual({ ok: false, reason: 'not_found' });

    const unknown = await invokeChannel<BgCommandTerminateResult>(
      IPC_CHANNELS.BG_CMD_TERMINATE,
      { commandId: 99999, sessionId: SESSION_A },
    );
    expect(unknown).toEqual({ ok: false, reason: 'not_found' });

    expect(store.get(procId)!.exitCode).toBeNull();
  });
});

// ── bgcmd:changed broadcast ──────────────────────────────────────────────────

describe('bgcmd:changed', () => {
  it('broadcasts the owning sessionId on background process changes', async () => {
    const send = makeWindow();
    // Broadcast is now filtered to windows whose active session matches.
    mocks.sessionManager._setActiveForWindow(String(mocks.windows[0].webContents.id), { id: SESSION_A });

    await store.spawn('sleep 30', { sessionId: SESSION_A });

    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.BG_CMD_CHANGED, { sessionId: SESSION_A });
  });

  it('does not broadcast for unbound (null-session) processes', async () => {
    const send = makeWindow();

    await store.spawn('sleep 30', { sessionId: null });

    expect(send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.BG_CMD_CHANGED,
      expect.anything(),
    );
  });


  it('does not broadcast to windows whose active session does not match', async () => {
    const sendForB = makeWindow();
    // Window 1 is active on SESSION_B, so a SESSION_A spawn must not reach it.
    mocks.sessionManager._setActiveForWindow(String(mocks.windows[0].webContents.id), { id: SESSION_B });

    await store.spawn('sleep 30', { sessionId: SESSION_A });

    expect(sendForB).not.toHaveBeenCalledWith(
      IPC_CHANNELS.BG_CMD_CHANGED,
      expect.anything(),
    );
  });

  it('broadcast try/catch: a failing window does not abort delivery to others', async () => {
    const sendA = makeWindow();
    mocks.sessionManager._setActiveForWindow(String(mocks.windows[0].webContents.id), { id: SESSION_A });
    // Second window's send throws; third window should still receive.
    const throwingSend = vi.fn(() => { throw new Error('renderer gone'); });
    mocks.windows.push({
      isDestroyed: () => false,
      webContents: { id: 999, send: throwingSend, isDestroyed: () => false },
    });
    mocks.sessionManager._setActiveForWindow('999', { id: SESSION_A });
    const sendC = makeWindow();
    mocks.sessionManager._setActiveForWindow(String(mocks.windows[2].webContents.id), { id: SESSION_A });

    await store.spawn('sleep 30', { sessionId: SESSION_A });

    expect(sendA).toHaveBeenCalledWith(IPC_CHANNELS.BG_CMD_CHANGED, { sessionId: SESSION_A });
    expect(sendC).toHaveBeenCalledWith(IPC_CHANNELS.BG_CMD_CHANGED, { sessionId: SESSION_A });
  });

  it('stops broadcasting after unregisterChatIPC unsubscribes', async () => {
    const send = makeWindow();
    mocks.sessionManager._setActiveForWindow(String(mocks.windows[0].webContents.id), { id: SESSION_A });

    await store.spawn('sleep 30', { sessionId: SESSION_A });
    const callsAfterFirstSpawn = send.mock.calls.length;
    expect(callsAfterFirstSpawn).toBeGreaterThan(0);

    chatIpc.unregisterChatIPC();
    await store.spawn('sleep 30', { sessionId: SESSION_A });
    expect(send.mock.calls.length).toBe(callsAfterFirstSpawn);

    // Re-register so afterEach cleanup sees a balanced register/unregister pair.
    chatIpc.registerChatIPC();
  });
});

// ── Foreground registry dropped on abort/stop (#12) ──────────────────────────

describe('foreground registry abort/stop cleanup (#12)', () => {
  it('dropSession clears foreground live entries for the session (direct)', async () => {
    registry.register('call-abort-direct', {
      command: 'sleep 30',
      sessionId: SESSION_A,
      agentScopeId: 'main',
    });
    registry.append('call-abort-direct', Buffer.from('hello tail\n'));
    // Visible before abort.
    let pre = await invokeChannel<BgCommandSnapshotResult>(IPC_CHANNELS.BG_CMD_SNAPSHOT, {
      toolCallId: 'call-abort-direct',
      sessionId: SESSION_A,
    });
    expect(pre).toMatchObject({ found: true, tail: expect.stringContaining('hello tail') });

    // Simulate abort/stop: dropSession is the contract both paths call.
    registry.dropSession(SESSION_A);

    const post = await invokeChannel<BgCommandSnapshotResult>(IPC_CHANNELS.BG_CMD_SNAPSHOT, {
      toolCallId: 'call-abort-direct',
      sessionId: SESSION_A,
    });
    expect(post).toEqual({ found: false });
    expect(registry.get('call-abort-direct')).toBeUndefined();
  });

  it('dropSession is scope-isolated: other sessions keep their entries', async () => {
    registry.register('call-keep-a', { command: 'sleep 30', sessionId: SESSION_A, agentScopeId: 'main' });
    registry.register('call-keep-b', { command: 'sleep 30', sessionId: SESSION_B, agentScopeId: 'main' });

    registry.dropSession(SESSION_A);

    expect(registry.get('call-keep-a')).toBeUndefined();
    expect(registry.get('call-keep-b')).toBeDefined();
    const snapB = await invokeChannel<BgCommandSnapshotResult>(IPC_CHANNELS.BG_CMD_SNAPSHOT, {
      toolCallId: 'call-keep-b',
      sessionId: SESSION_B,
    });
    expect(snapB).toMatchObject({ found: true });
  });

  it('forceAbortSession wiring drops the foreground live registry', async () => {
    registry.register('call-via-abort', {
      command: 'sleep 30',
      sessionId: SESSION_A,
      agentScopeId: 'main',
    });
    registry.append('call-via-abort', Buffer.from('before abort\n'));

    // Sanity: snapshot is visible before abort.
    expect(registry.snapshotForSession('call-via-abort', 50, SESSION_A)).toBeDefined();

    const { forceAbortSession } = await import('../../src/main/ipc/chat/abort');
    forceAbortSession(SESSION_A);

    expect(registry.snapshotForSession('call-via-abort', 50, SESSION_A)).toBeUndefined();
    expect(registry.get('call-via-abort')).toBeUndefined();

    // IPC reflects the drop as found:false.
    const post = await invokeChannel<BgCommandSnapshotResult>(IPC_CHANNELS.BG_CMD_SNAPSHOT, {
      toolCallId: 'call-via-abort',
      sessionId: SESSION_A,
    });
    expect(post).toEqual({ found: false });
  });

  it('forceStopSession drops foreground live entries (registry abort seam)', async () => {
    // Seed an active stream so the stop handler has a session to act on, then
    // register a foreground entry that should be dropped when the handler runs.
    // The bg-command harness reuses the same sessionManager mock as chat.ts;
    // set the active session for the sender window so stop resolves it.
    const session = { id: SESSION_A, name: 'test', cwd: '/tmp', chains: [], activeChainId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), subagentChains: [], todoStore: { tasks: [] } } as unknown as { id: string };
    mocks.sessionManager._setActiveForWindow(String(WINDOW_SENDER_ID), session as never);

    registry.register('call-via-stop', {
      command: 'sleep 30',
      sessionId: SESSION_A,
      agentScopeId: 'main',
    });
    registry.append('call-via-stop', Buffer.from('before stop\n'));
    expect(registry.snapshotForSession('call-via-stop', 50, SESSION_A)).toBeDefined();

    // Directly exercise the dropSession contract exercised by chat:stop's
    // confirm path and by forceStopSession. The handler itself is exercised
    // more fully in chat-ipc.test.ts; this asserts the registry seam.
    const { forceStopSession } = await import('../../src/main/ipc/chat/abort');
    forceStopSession(SESSION_A);

    expect(registry.get('call-via-stop')).toBeUndefined();
    const post = await invokeChannel<BgCommandSnapshotResult>(IPC_CHANNELS.BG_CMD_SNAPSHOT, {
      toolCallId: 'call-via-stop',
      sessionId: SESSION_A,
    });
    expect(post).toEqual({ found: false });
  });
});

// ── USER ownership auto-release via idle timeout (#13) ───────────────────────

describe('USER ownership auto-release via idle timeout (#13)', () => {
  it('auto-releases USER ownership after background_command_idle_timeout and unblocks agent send_input', async () => {
    vi.useFakeTimers();
    try {
      // Use a real entry so agentSendInput scope gating is exercised.
      const now = Date.now();
      // Spawn an interactive background command (PTY).
      const procId = await store.spawn('cat', {
        sessionId: SESSION_A,
        agentScopeId: 'main',
        interactive: true,
        description: 'idle reclaim probe',
      });
      // Allow PTY to start before taking ownership.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 250));
      vi.useFakeTimers();
      // Re-establish Date.now baseline after the real delay.
      // takeOwnership stamps lastUserInputAt = Date.now().
      store.takeOwnership(procId);
      expect(store.get(procId)!.owner).toBe('USER');
      // Agent should be blocked while USER owns the input.
      const blocked = await agentSendInput(procId, 'agent line\n', SESSION_A, 'main');
      expect(blocked.canonical.status).toBe('error');
      expect(blocked.agentProjection.content).toContain('control: USER');

      // Advance past the idle timeout (900s) and reclaim.
      const idleTimeoutMs = 900 * 1000;
      await vi.advanceTimersByTimeAsync(idleTimeoutMs + 1);
      store.checkIdleOwnership(idleTimeoutMs);

      expect(store.get(procId)!.owner).toBe('AGENT');

      // Agent is now unblocked.
      const unblocked = await agentSendInput(procId, 'agent line\n', SESSION_A, 'main');
      expect(unblocked.canonical.status).toBe('complete');

      // Snapshot reflects the reclaimed ownership.
      const snap = await invokeChannel<BgCommandSnapshotResult>(IPC_CHANNELS.BG_CMD_SNAPSHOT, {
        commandId: procId,
        sessionId: SESSION_A,
      });
      expect(snap).toMatchObject({ found: true, owner: 'AGENT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not release before the idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const procId = await store.spawn('cat', {
        sessionId: SESSION_A,
        agentScopeId: 'main',
        interactive: true,
      });
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 150));
      vi.useFakeTimers();

      store.takeOwnership(procId);
      expect(store.get(procId)!.owner).toBe('USER');

      const idleTimeoutMs = 900 * 1000;
      await vi.advanceTimersByTimeAsync(idleTimeoutMs - 1000);
      store.checkIdleOwnership(idleTimeoutMs);
      expect(store.get(procId)!.owner).toBe('USER');

      // One ms past the boundary flips.
      await vi.advanceTimersByTimeAsync(1001);
      store.checkIdleOwnership(idleTimeoutMs);
      expect(store.get(procId)!.owner).toBe('AGENT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkIdleOwnership operates per-entry lastUserInputAt (unit-level)', () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      // Inject two fake entries with controlled timestamps to avoid PTY overhead.
      const idUserRecent = 8101;
      const idUserStale = 8102;
      (store as unknown as { _entries: Map<number, unknown> })._entries.set(idUserRecent, {
        id: idUserRecent,
        command: 'fake-recent',
        process: { write: () => {} },
        buffer: { getTail: () => '' },
        owner: 'USER' as const,
        lastOutputAt: now,
        lastUserInputAt: now,
        exitCode: null,
        createdAt: now,
        interactive: true,
        sessionId: SESSION_A,
        agentScopeId: 'main',
        description: '',
      });
      (store as unknown as { _entries: Map<number, unknown> })._entries.set(idUserStale, {
        id: idUserStale,
        command: 'fake-stale',
        process: { write: () => {} },
        buffer: { getTail: () => '' },
        owner: 'USER' as const,
        lastOutputAt: now - 1_000_000,
        lastUserInputAt: now - 1_000_000,
        exitCode: null,
        createdAt: now - 1_000_000,
        interactive: true,
        sessionId: SESSION_A,
        agentScopeId: 'main',
        description: '',
      });
      // Only the stale entry should be reclaimed.
      store.checkIdleOwnership(900 * 1000);
      expect((store.get(idUserRecent) as unknown as { owner: string }).owner).toBe('USER');
      expect((store.get(idUserStale) as unknown as { owner: string }).owner).toBe('AGENT');
    } finally {
      vi.useRealTimers();
    }
  });
});
