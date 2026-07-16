/**
 * Shared useSession cache: Config + Chat must share one active session.
 * Runs in Node (no jsdom) via the test-only store surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainStatus } from '../../src/shared/types/chain';
import type { Session } from '../../src/shared/types/session';

const listMock = vi.fn();
const loadMock = vi.fn();
const createMock = vi.fn();
const clearActiveMock = vi.fn();
const deleteMock = vi.fn();
const renameMock = vi.fn();
const getWorkspaceMock = vi.fn();
const setWorkspaceMock = vi.fn();

const renamedHandlers: Array<(event: { id: string; name: string }) => void> = [];
const createdHandlers: Array<(event: {
  session: Session;
  draftGeneration?: number;
}) => void> = [];
const updatedHandlers: Array<(event: { session: Session }) => void> = [];
const workspaceHandlers: Array<(event: {
  workspace: { cwd: string | null; source: string; status: string };
}) => void> = [];

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  const sessionId = overrides.id ?? 'session-1';
  const chainId = 'chain-1';
  return {
    id: sessionId,
    name: overrides.name ?? 'Session 1',
    selection: overrides.selection ?? null,
    modelLabel: overrides.modelLabel ?? null,
    cwd: overrides.cwd ?? null,
    chains: overrides.chains ?? [{
      id: chainId,
      sessionId,
      messages: [],
      status: ChainStatus.ACTIVE,
      selection: null,
      modelLabel: null,
      agentName: 'general',
      agentType: 'internal',
      agentTier: 'bloom',
      subagentRecord: null,
      startTime: now,
      endTime: null,
    }],
    activeChainId: overrides.activeChainId ?? chainId,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    subagentChains: overrides.subagentChains ?? [],
    todoStore: overrides.todoStore ?? { tasks: [] },
  };
}

function installOrchidApi() {
  renamedHandlers.length = 0;
  createdHandlers.length = 0;
  updatedHandlers.length = 0;
  workspaceHandlers.length = 0;

  vi.stubGlobal('window', {
    orchid: {
      session: {
        list: listMock,
        load: loadMock,
        create: createMock,
        clearActive: clearActiveMock,
        delete: deleteMock,
        rename: renameMock,
        getWorkspace: getWorkspaceMock,
        setWorkspace: setWorkspaceMock,
        onRenamed: (handler: (event: { id: string; name: string }) => void) => {
          renamedHandlers.push(handler);
          return () => {
            const idx = renamedHandlers.indexOf(handler);
            if (idx >= 0) renamedHandlers.splice(idx, 1);
          };
        },
        onCreated: (handler: (event: {
          session: Session;
          draftGeneration?: number;
        }) => void) => {
          createdHandlers.push(handler);
          return () => {
            const idx = createdHandlers.indexOf(handler);
            if (idx >= 0) createdHandlers.splice(idx, 1);
          };
        },
        onUpdated: (handler: (event: { session: Session }) => void) => {
          updatedHandlers.push(handler);
          return () => {
            const idx = updatedHandlers.indexOf(handler);
            if (idx >= 0) updatedHandlers.splice(idx, 1);
          };
        },
        onWorkspaceChanged: (handler: (event: {
          workspace: { cwd: string | null; source: string; status: string };
        }) => void) => {
          workspaceHandlers.push(handler);
          return () => {
            const idx = workspaceHandlers.indexOf(handler);
            if (idx >= 0) workspaceHandlers.splice(idx, 1);
          };
        },
      },
    },
  });
}

describe('useSession shared cache', () => {
  beforeEach(() => {
    vi.resetModules();
    listMock.mockReset();
    loadMock.mockReset();
    createMock.mockReset();
    clearActiveMock.mockReset();
    deleteMock.mockReset();
    renameMock.mockReset();
    getWorkspaceMock.mockReset();
    setWorkspaceMock.mockReset();
    installOrchidApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares active session across load from a second consumer', async () => {
    const sessionA = makeSession({ id: 'a', name: 'Alpha' });
    const sessionB = makeSession({ id: 'b', name: 'Beta' });
    listMock.mockResolvedValue([
      { id: 'a', name: 'Alpha', modelLabel: null, cwd: null, chainCount: 1, updatedAt: 1 },
      { id: 'b', name: 'Beta', modelLabel: null, cwd: null, chainCount: 1, updatedAt: 2 },
    ]);
    getWorkspaceMock.mockResolvedValue({ cwd: null, source: 'unbound', status: 'unbound' });
    loadMock.mockImplementation(async ({ id }: { id: string }) => (
      id === 'a' ? sessionA : sessionB
    ));

    const { __sessionCacheTest } = await import('../../src/renderer/hooks/useSession');
    __sessionCacheTest.reset();
    __sessionCacheTest.ensureBootstrapped();
    await __sessionCacheTest.refresh();

    await __sessionCacheTest.load('a');
    expect(__sessionCacheTest.getActiveSession()?.id).toBe('a');

    // Second "consumer" sees the same store (Config selecting while Chat is mounted).
    await __sessionCacheTest.load('b');
    expect(__sessionCacheTest.getActiveSession()?.id).toBe('b');
    expect(__sessionCacheTest.getActiveSession()?.name).toBe('Beta');
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('enterDraft clears active session for all consumers', async () => {
    const session = makeSession({ id: 's1' });
    listMock.mockResolvedValue([
      { id: 's1', name: 'S', modelLabel: null, cwd: null, chainCount: 1, updatedAt: 1 },
    ]);
    getWorkspaceMock.mockResolvedValue({ cwd: null, source: 'unbound', status: 'unbound' });
    loadMock.mockResolvedValue(session);
    clearActiveMock.mockResolvedValue(undefined);

    const { __sessionCacheTest } = await import('../../src/renderer/hooks/useSession');
    __sessionCacheTest.reset();
    __sessionCacheTest.ensureBootstrapped();
    await __sessionCacheTest.load('s1');
    expect(__sessionCacheTest.getActiveSession()?.id).toBe('s1');

    await __sessionCacheTest.enterDraft();
    expect(__sessionCacheTest.getActiveSession()).toBeNull();
    expect(clearActiveMock).toHaveBeenCalledTimes(1);
    expect(__sessionCacheTest.getDraftGeneration()).toBeGreaterThan(0);
  });

  it('drops stale load when a newer load supersedes it', async () => {
    const sessionA = makeSession({ id: 'a', name: 'Alpha' });
    const sessionB = makeSession({ id: 'b', name: 'Beta' });
    listMock.mockResolvedValue([]);
    getWorkspaceMock.mockResolvedValue({ cwd: null, source: 'unbound', status: 'unbound' });

    let resolveA: (value: Session) => void = () => {};
    const loadA = new Promise<Session>((resolve) => {
      resolveA = resolve;
    });
    loadMock
      .mockReturnValueOnce(loadA)
      .mockResolvedValueOnce(sessionB);

    const { __sessionCacheTest } = await import('../../src/renderer/hooks/useSession');
    __sessionCacheTest.reset();
    __sessionCacheTest.ensureBootstrapped();

    const first = __sessionCacheTest.load('a');
    const second = __sessionCacheTest.load('b');
    await second;
    expect(__sessionCacheTest.getActiveSession()?.id).toBe('b');

    resolveA(sessionA);
    await first;
    // Stale A must not overwrite B.
    expect(__sessionCacheTest.getActiveSession()?.id).toBe('b');
  });

  it('adopts SESSION_CREATED only while still in draft for that generation', async () => {
    listMock.mockResolvedValue([]);
    getWorkspaceMock.mockResolvedValue({ cwd: null, source: 'unbound', status: 'unbound' });
    clearActiveMock.mockResolvedValue(undefined);

    const { __sessionCacheTest } = await import('../../src/renderer/hooks/useSession');
    __sessionCacheTest.reset();
    __sessionCacheTest.ensureBootstrapped();
    await __sessionCacheTest.enterDraft();
    const gen = __sessionCacheTest.getDraftGeneration();

    const created = makeSession({ id: 'lazy-1', name: 'Lazy' });
    for (const handler of createdHandlers) {
      handler({ session: created, draftGeneration: gen });
    }
    expect(__sessionCacheTest.getActiveSession()?.id).toBe('lazy-1');

    await __sessionCacheTest.enterDraft();
    const nextGen = __sessionCacheTest.getDraftGeneration();
    const stale = makeSession({ id: 'stale', name: 'Stale' });
    for (const handler of createdHandlers) {
      handler({ session: stale, draftGeneration: gen });
    }
    expect(__sessionCacheTest.getActiveSession()).toBeNull();
    expect(nextGen).toBeGreaterThan(gen);
  });

  it('notifies subscribers when active session changes', async () => {
    const session = makeSession({ id: 'n1' });
    listMock.mockResolvedValue([]);
    getWorkspaceMock.mockResolvedValue({ cwd: null, source: 'unbound', status: 'unbound' });
    loadMock.mockResolvedValue(session);

    const { __sessionCacheTest } = await import('../../src/renderer/hooks/useSession');
    __sessionCacheTest.reset();
    const listener = vi.fn();
    const unsub = __sessionCacheTest.subscribe(listener);
    __sessionCacheTest.ensureBootstrapped();

    await __sessionCacheTest.load('n1');
    expect(listener).toHaveBeenCalled();
    expect(__sessionCacheTest.getSnapshot().activeSession?.id).toBe('n1');
    unsub();
  });
});
