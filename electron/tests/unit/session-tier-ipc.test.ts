/**
 * Service-tier session IPC tests — session:set_service_tier and
 * session:get_service_tier_config.
 *
 * Mirrors the reasoning-effort IPC suite conventions: the singleton
 * SessionManager is replaced with a fake, the provider boundary is mocked
 * (connection store, catalog, resolver, driver registry), and the real
 * draft-tier store is exercised so draft parking → promotion is covered.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { ensureActiveSession } from '../../src/main/host/chat/session';
import {
  clearDraftTierOverrides,
  getDraftTierOverride,
} from '../../src/main/session/draft-tier';

const SESSION_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CREATED_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONNECTION_UUID = '11111111-2222-4333-8444-555555555555';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const windows: Array<{
    isDestroyed: () => boolean;
    webContents: { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
  }> = [];

  type SessionShape = {
    id: string;
    name: string;
    selection: { connectionId: string; modelId: string } | null;
    modelLabel: string | null;
    cwd: string | null;
    chains: unknown[];
    activeChainId: string | null;
    createdAt: string;
    updatedAt: string;
    subagentChains: unknown[];
    todoStore: { tasks: unknown[] };
    reasoningEffortOverride: string | number | null;
    tierOverride: string | null;
    permissionMode: string | null;
  };

  let activeSession: SessionShape | null = null;
  let createdSession: SessionShape | null = null;

  const sessionManager = {
    getActive: vi.fn(() => activeSession),
    getSession: vi.fn((id: string) => {
      if (createdSession?.id === id) return createdSession;
      if (activeSession?.id === id) return activeSession;
      return null;
    }),
    setTierOverride: vi.fn((id: string, tier: string | null) => {
      if (createdSession?.id === id) {
        createdSession = { ...createdSession, tierOverride: tier };
      }
      if (activeSession?.id === id) {
        activeSession = { ...activeSession, tierOverride: tier };
      }
    }),
    delete: vi.fn(() => true),
    create: vi.fn((
      selection: { connectionId: string; modelId: string } | null,
      options?: { cwd?: string | null },
      _ownerId?: string,
      modelLabel?: string | null,
    ) => {
      const now = new Date().toISOString();
      createdSession = {
        id: CREATED_UUID,
        name: 'Session Test',
        selection,
        modelLabel: modelLabel ?? selection?.modelId ?? null,
        cwd: options?.cwd ?? null,
        chains: [],
        activeChainId: null,
        createdAt: now,
        updatedAt: now,
        subagentChains: [],
        todoStore: { tasks: [] },
        reasoningEffortOverride: null,
        tierOverride: null,
        permissionMode: null,
      };
      activeSession = createdSession;
      return createdSession;
    }),
    _setActive: (session: SessionShape | null) => {
      activeSession = session;
    },
    _reset: () => {
      activeSession = null;
      createdSession = null;
      sessionManager.getActive.mockClear();
      sessionManager.getSession.mockClear();
      sessionManager.setTierOverride.mockClear();
      sessionManager.create.mockClear();
      sessionManager.delete.mockClear();
    },
  };

  const connectionStore = {
    list: vi.fn(async () => [] as unknown[]),
  };

  const catalogStore = {
    getProviderDefinitions: vi.fn(() => [] as unknown[]),
  };

  const driverRegistry = {
    get: vi.fn(() => undefined as { tierMechanism?: unknown } | undefined),
  };

  return {
    handlers,
    sessionManager,
    connectionStore,
    catalogStore,
    driverRegistry,
    resolveWindowWorkspace: vi.fn(() => ({
      cwd: null,
      source: 'unbound',
      status: 'unbound',
    })),
    workingSetOpenOrFocus: vi.fn((id: string) => ({
      openSessionIds: [id],
      focusedSessionId: id,
    })),
    workingSetRemove: vi.fn((_id: string, ownerId?: string) => ({
      openSessionIds: [`remaining-${ownerId ?? 'primary'}`],
      focusedSessionId: `remaining-${ownerId ?? 'primary'}`,
      mruSessionIds: [`remaining-${ownerId ?? 'primary'}`],
    })),
    getWorkingSetSnapshot: vi.fn((ownerId: string) => ({
      openSessionIds: [`remaining-${ownerId}`],
      focusedSessionId: `remaining-${ownerId}`,
      mruSessionIds: [`remaining-${ownerId}`],
    })),
    windows,
    discardDeletedSessionRuntime: vi.fn(),
    clearChatHistory: vi.fn(),
    clearToolCallHistoryForSession: vi.fn(),
    clearFunctionHashesForSession: vi.fn(),
    clearNextRequestStop: vi.fn(),
    removeSessionActivity: vi.fn(),
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => mocks.windows),
  },
  dialog: { showOpenDialog: vi.fn() },
  webContents: { getAllWebContents: vi.fn(() => []) },
}));

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => mocks.sessionManager,
  resolveWindowWorkspace: (windowId: string) => mocks.resolveWindowWorkspace(windowId),
  resolveBoundProjectPath: () => null,
}));

vi.mock('../../src/main/config/loader', () => ({
  getConfig: vi.fn(() => ({ default_project_dir: null, default_model: null })),
  atomicWriteJson: vi.fn(),
  HOME_CONFIG_PATH: '/tmp/orchid-test-config.json',
  HOME_CONFIG_DIR: '/tmp',
  ConfigManager: { load: vi.fn(), save: vi.fn(), reset: vi.fn() },
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: vi.fn(() => ({
    get: vi.fn(() => ({ config: { default_model: null } })),
  })),
  clearProjectRuntimeRegistry: vi.fn(),
}));

// ensureActiveSession consults the trust gate for the bound cwd; fixture dirs
// are never registered so the gate is stubbed to trusted (chat-ipc convention).
vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: () => 'trusted',
  revokeProjectTrust: vi.fn(),
  revokeProjectTrustRaw: vi.fn(),
}));

vi.mock('../../src/main/ipc/chat-history', () => ({
  clearChatHistory: mocks.clearChatHistory,
  seedChatHistory: vi.fn(),
}));

vi.mock('../../src/main/session/working-set-live', () => ({
  workingSetClearFocus: vi.fn(),
  workingSetOpenOrFocus: mocks.workingSetOpenOrFocus,
  workingSetRemove: mocks.workingSetRemove,
  getWorkingSetSnapshot: mocks.getWorkingSetSnapshot,
  // U5: the embedded local host's HostServer installs its own broadcast and
  // bootstraps the store.
  setWorkingSetBroadcast: vi.fn(),
  bootstrapWorkingSet: vi.fn(),
  filterIfCatalogOk: vi.fn(() => ({
    snapshot: mocks.getWorkingSetSnapshot(),
    membershipChanged: false,
  })),
  tryListSessionCatalog: vi.fn(() => ({ status: 'ok', ids: new Set() })),
  mutateAndPersist: vi.fn((_owner: string, run: () => unknown) => run()),
}));

vi.mock('../../src/main/ipc/chat', () => ({
  discardDeletedSessionRuntime: mocks.discardDeletedSessionRuntime,
}));

// U5: session:delete now runs in the host binding, which sources the runtime
// teardown from host/chat/abort instead of the IPC facade.
vi.mock('../../src/main/host/chat/abort', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  discardDeletedSessionRuntime: mocks.discardDeletedSessionRuntime,
}));

vi.mock('../../src/main/permissions/history', () => ({
  clearToolCallHistoryForSession: mocks.clearToolCallHistoryForSession,
}));

vi.mock('../../src/main/tools/ast/get-function', () => ({
  clearFunctionHashesForSession: mocks.clearFunctionHashesForSession,
}));

vi.mock('../../src/main/agents/next-request-stop', () => ({
  clearNextRequestStop: mocks.clearNextRequestStop,
}));

vi.mock('../../src/main/session/activity-live', () => ({
  removeSessionActivity: mocks.removeSessionActivity,
  // U5: the embedded local host's HostServer installs its own broadcast.
  setSessionActivityBroadcast: vi.fn(),
}));

vi.mock('../../src/main/providers/runtime-context', () => ({
  getProviderConnectionStore: vi.fn(() => mocks.connectionStore),
  getProviderCatalogStore: vi.fn(() => mocks.catalogStore),
  getProviderDriverRegistry: vi.fn(() => mocks.driverRegistry),
}));

vi.mock('../../src/main/providers/resolver', () => ({
  resolveModelSelection: vi.fn((
    selection: { connectionId: string; modelId: string } | null,
    connections: Array<{ id: string; providerId: string }>,
    definitions: Array<{ id: string; models: unknown[] }>,
  ) => {
    if (!selection) return { kind: 'selection-required', reason: 'no-selection' };
    const connection = connections.find((item) => item.id === selection.connectionId);
    if (!connection) return { kind: 'unavailable', selection, reason: 'unknown-connection' };
    const provider = definitions.find((item) => item.id === connection.providerId);
    if (!provider) return { kind: 'unavailable', selection, reason: 'unknown-provider' };
    const model = provider.models.find((item) => (item as { id: string }).id === selection.modelId);
    return { kind: 'resolved', selection, connection, provider, model };
  }),
}));

let sessionIpc: typeof import('../../src/main/ipc/session');

function makeSession(overrides: Partial<{
  selection: { connectionId: string; modelId: string } | null;
  tierOverride: string | null;
}> = {}) {
  return {
    id: SESSION_UUID,
    name: 'Test Session',
    selection: overrides.selection ?? null,
    modelLabel: overrides.selection?.modelId ?? null,
    cwd: '/tmp/project',
    chains: [],
    activeChainId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subagentChains: [],
    todoStore: { tasks: [] },
    reasoningEffortOverride: null,
    tierOverride: overrides.tierOverride ?? null,
    permissionMode: null,
  };
}

function sender(id = 1) {
  return { id, send: vi.fn(), isDestroyed: () => false };
}

function mockTieredProvider(): void {
  mocks.connectionStore.list.mockReturnValue([
    {
      id: CONNECTION_UUID,
      providerId: 'neuralwatt',
      name: 'Neuralwatt',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'h' },
      modelIds: ['glm-5.2'],
      health: 'ready',
      tierSelections: { 'glm-5.2': 'fast' },
    },
  ]);
  mocks.catalogStore.getProviderDefinitions.mockReturnValue([
    {
      id: 'neuralwatt',
      displayName: 'Neuralwatt',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomModels: false,
      models: [
        {
          id: 'glm-5.2',
          displayName: 'GLM 5.2',
          protocol: 'openai-compatible',
          capabilities: {
            inputModalities: ['text'],
            outputModalities: ['text'],
            tools: true,
            reasoning: true,
          },
        },
      ],
    },
  ]);
  mocks.driverRegistry.get.mockReturnValue({
    tierMechanism: {
      kind: 'request-parameter',
      parameter: 'serviceTier',
      tiers: [
        { id: 'flex', displayName: 'Flex' },
        { id: 'fast' },
      ],
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.windows.length = 0;
  mocks.sessionManager._reset();
  mocks.connectionStore.list.mockReturnValue([]);
  mocks.catalogStore.getProviderDefinitions.mockReturnValue([]);
  mocks.driverRegistry.get.mockReturnValue(undefined);
  mocks.resolveWindowWorkspace.mockReturnValue({
    cwd: null,
    source: 'unbound',
    status: 'unbound',
  });
  clearDraftTierOverrides();

  sessionIpc = await import('../../src/main/ipc/session');
  sessionIpc.unregisterSessionIPC();
  sessionIpc.registerSessionIPC();
});

afterEach(() => {
  sessionIpc.unregisterSessionIPC();
  mocks.handlers.clear();
  mocks.sessionManager._reset();
  clearDraftTierOverrides();
});

describe('session:delete', () => {
  it('durably deletes before discarding runtime state and returns the working set', async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_DELETE);
    expect(handler).toBeDefined();

    const result = await handler!({ sender: sender(9) }, { id: SESSION_UUID });

    expect(mocks.sessionManager.delete).toHaveBeenCalledWith(SESSION_UUID);
    expect(mocks.discardDeletedSessionRuntime).toHaveBeenCalledWith(SESSION_UUID);
    expect(mocks.sessionManager.delete.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.discardDeletedSessionRuntime.mock.invocationCallOrder[0]!);
    expect(mocks.workingSetRemove).toHaveBeenCalledWith(SESSION_UUID, '9');
    expect(result).toEqual({
      status: 'deleted',
      workingSet: {
        openSessionIds: ['remaining-9'],
        focusedSessionId: 'remaining-9',
        mruSessionIds: ['remaining-9'],
      },
    });
  });

  it('keeps runtime state intact when durable deletion throws', async () => {
    mocks.sessionManager.delete.mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_DELETE);
    expect(handler).toBeDefined();

    await expect(handler!({ sender: sender(9) }, { id: SESSION_UUID }))
      .rejects.toThrow('database unavailable');

    expect(mocks.discardDeletedSessionRuntime).not.toHaveBeenCalled();
    expect(mocks.workingSetRemove).not.toHaveBeenCalled();
  });

  it('broadcasts a window-specific deletion snapshot to every live renderer', async () => {
    const first = {
      isDestroyed: () => false,
      webContents: { id: 9, isDestroyed: () => false, send: vi.fn() },
    };
    const second = {
      isDestroyed: () => false,
      webContents: { id: 10, isDestroyed: () => false, send: vi.fn() },
    };
    mocks.windows.push(first, second);
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_DELETE);
    expect(handler).toBeDefined();

    await handler!({ sender: sender(9) }, { id: SESSION_UUID });

    expect(first.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.SESSION_DELETED,
      {
        id: SESSION_UUID,
        workingSet: {
          openSessionIds: ['remaining-9'],
          focusedSessionId: 'remaining-9',
          mruSessionIds: ['remaining-9'],
        },
      },
    );
    expect(second.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.SESSION_DELETED,
      {
        id: SESSION_UUID,
        workingSet: {
          openSessionIds: ['remaining-10'],
          focusedSessionId: 'remaining-10',
          mruSessionIds: ['remaining-10'],
        },
      },
    );
    expect(mocks.workingSetRemove).toHaveBeenCalledWith(SESSION_UUID, '9');
    expect(mocks.workingSetRemove).toHaveBeenCalledWith(SESSION_UUID, '10');
  });

  it('broadcasts authoritative absence when the durable row was already missing', async () => {
    mocks.sessionManager.delete.mockReturnValueOnce(false);
    const recipient = {
      isDestroyed: () => false,
      webContents: { id: 10, isDestroyed: () => false, send: vi.fn() },
    };
    mocks.windows.push(recipient);
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_DELETE);
    expect(handler).toBeDefined();

    const result = await handler!({ sender: sender(9) }, { id: SESSION_UUID });

    expect(result).toMatchObject({ status: 'not_found' });
    expect(mocks.clearChatHistory).toHaveBeenCalledWith(SESSION_UUID);
    expect(mocks.removeSessionActivity).toHaveBeenCalledWith(SESSION_UUID);
    expect(recipient.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.SESSION_DELETED,
      expect.objectContaining({ id: SESSION_UUID }),
    );
  });
});

describe('session:set_service_tier', () => {
  it('sets override on active session', async () => {
    mocks.sessionManager._setActive(makeSession());
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_SERVICE_TIER);
    expect(handler).toBeDefined();

    const result = await handler!({ sender: sender() }, { tier: 'flex' });
    expect(result).toEqual({ status: 'ok' });
    expect(mocks.sessionManager.setTierOverride).toHaveBeenCalledWith(SESSION_UUID, 'flex');
  });

  it('clears override with null', async () => {
    mocks.sessionManager._setActive(makeSession({ tierOverride: 'flex' }));
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_SERVICE_TIER);

    const result = await handler!({ sender: sender() }, { tier: null });
    expect(result).toEqual({ status: 'ok' });
    expect(mocks.sessionManager.setTierOverride).toHaveBeenCalledWith(SESSION_UUID, null);
  });

  it('rejects empty and whitespace tiers', async () => {
    mocks.sessionManager._setActive(makeSession());
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_SERVICE_TIER)!;

    await expect(handler({ sender: sender() }, { tier: '' })).rejects.toThrow(
      /Invalid session:set_service_tier payload/,
    );
    await expect(handler({ sender: sender() }, { tier: '   ' })).rejects.toThrow(
      /Invalid session:set_service_tier payload/,
    );
  });

  it('rejects non-string tiers', async () => {
    mocks.sessionManager._setActive(makeSession());
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_SERVICE_TIER)!;

    await expect(handler({ sender: sender() }, { tier: 42 })).rejects.toThrow(
      /Invalid session:set_service_tier payload/,
    );
    await expect(handler({ sender: sender() }, { tier: true })).rejects.toThrow(
      /Invalid session:set_service_tier payload/,
    );
  });

  it('rejects missing payload and missing tier field', async () => {
    mocks.sessionManager._setActive(makeSession());
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_SERVICE_TIER)!;

    await expect(handler({ sender: sender() }, {})).rejects.toThrow(
      /Invalid session:set_service_tier payload/,
    );
    await expect(handler({ sender: sender() }, undefined)).rejects.toThrow(
      /Invalid session:set_service_tier payload/,
    );
  });

  it('parks a draft override per window id when no session is active', async () => {
    mocks.sessionManager._setActive(null);
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_SERVICE_TIER)!;

    // Sender ids are numeric (non-uuid) window ids in Electron; the handler
    // parks under that id until a session exists.
    const result = await handler({ sender: sender(41) }, { tier: 'flex' });
    expect(result).toEqual({ status: 'ok' });
    expect(mocks.sessionManager.setTierOverride).not.toHaveBeenCalled();
    expect(getDraftTierOverride('41')).toBe('flex');
    expect(getDraftTierOverride('42')).toBeNull();
  });

  it('promotes a parked draft tier into the session created from a draft', async () => {
    mocks.sessionManager._setActive(null);
    const setHandler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_SERVICE_TIER)!;
    await setHandler({ sender: sender(9) }, { tier: 'flex' });
    expect(getDraftTierOverride('9')).toBe('flex');

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-tier-promo-'));
    try {
      mocks.resolveWindowWorkspace.mockReturnValue({
        cwd: projectDir,
        source: 'draft',
        status: 'valid',
      });
      const preferred = { connectionId: CONNECTION_UUID, modelId: 'glm-5.2' };

      const result = ensureActiveSession('9', preferred);

      expect(result).toMatchObject({ ok: true });
      expect(mocks.sessionManager.create).toHaveBeenCalledWith(
        preferred,
        { cwd: projectDir },
        '9',
        preferred.modelId,
      );
      expect(mocks.sessionManager.setTierOverride).toHaveBeenCalledWith(CREATED_UUID, 'flex');
      expect((result as { session: { tierOverride: string | null } }).session.tierOverride)
        .toBe('flex');
      // The parked value is consumed exactly once by the promotion.
      expect(getDraftTierOverride('9')).toBeNull();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('session:get_service_tier_config', () => {
  it('returns the empty config shape when there is no selection', async () => {
    mocks.sessionManager._setActive(null);
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    expect(handler).toBeDefined();

    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      mechanism: null,
      tiers: [],
      selected: null,
      override: null,
      effective: null,
    });
  });

  it('returns empty config shape when the active session has no model selection', async () => {
    mocks.sessionManager._setActive(makeSession({ selection: null }));
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);

    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      mechanism: null,
      tiers: [],
      selected: null,
      override: null,
      effective: null,
    });
  });

  it('computes effective = override ?? selected with the override winning', async () => {
    mocks.sessionManager._setActive(makeSession({
      selection: { connectionId: CONNECTION_UUID, modelId: 'glm-5.2' },
      tierOverride: 'flex',
    }));
    mockTieredProvider();
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);

    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      mechanism: 'request-parameter',
      tiers: [
        { id: 'flex', displayName: 'Flex', description: null },
        { id: 'fast', displayName: null, description: null },
      ],
      selected: 'fast',
      override: 'flex',
      effective: 'flex',
    });
  });

  it('falls back to the connection selection when the override is null', async () => {
    mocks.sessionManager._setActive(makeSession({
      selection: { connectionId: CONNECTION_UUID, modelId: 'glm-5.2' },
      tierOverride: null,
    }));
    mockTieredProvider();
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);

    const result = await handler!({ sender: sender() });
    expect(result).toMatchObject({
      selected: 'fast',
      override: null,
      effective: 'fast',
    });
  });

  it('surfaces a draft override parked before any session exists', async () => {
    mocks.sessionManager._setActive(null);
    const setHandler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_SERVICE_TIER)!;
    await setHandler({ sender: sender(7) }, { tier: 'flex' });

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    const result = await handler!({ sender: sender(7) });
    expect(result).toEqual({
      mechanism: null,
      tiers: [],
      selected: null,
      override: 'flex',
      effective: null,
    });
  });

  it('resolves tiers for the default model in draft mode with a parked override', async () => {
    mocks.sessionManager._setActive(null);
    const { getConfig } = await import('../../src/main/config/loader');
    vi.mocked(getConfig).mockReturnValue({
      default_project_dir: null,
      default_model: { connectionId: CONNECTION_UUID, modelId: 'glm-5.2' },
    } as never);
    mockTieredProvider();

    const setHandler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_SERVICE_TIER)!;
    await setHandler({ sender: sender(8) }, { tier: 'flex' });

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    const result = await handler!({ sender: sender(8) });
    expect(result).toMatchObject({
      mechanism: 'request-parameter',
      selected: 'fast',
      override: 'flex',
      effective: 'flex',
    });
  });

  it('returns empty tiers when the driver declares no tier mechanism', async () => {
    mocks.sessionManager._setActive(makeSession({
      selection: { connectionId: CONNECTION_UUID, modelId: 'glm-5.2' },
      tierOverride: 'flex',
    }));
    mockTieredProvider();
    mocks.driverRegistry.get.mockReturnValue({});

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      mechanism: null,
      tiers: [],
      selected: null,
      override: 'flex',
      effective: null,
    });
  });
});
