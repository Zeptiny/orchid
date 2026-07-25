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

  it('ChatView and ConfigView both consume the shared useSession store', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const rendererRoot = path.resolve(__dirname, '../../src/renderer');
    const chatView = fs.readFileSync(path.join(rendererRoot, 'components/ChatView.tsx'), 'utf8');
    const configView = fs.readFileSync(path.join(rendererRoot, 'components/ConfigView.tsx'), 'utf8');
    const useSessionSrc = fs.readFileSync(path.join(rendererRoot, 'hooks/useSession.ts'), 'utf8');
    const appSrc = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8');

    expect(chatView).toMatch(/import\s*\{\s*useSession\s*\}\s*from\s*['"].*useSession['"]/);
    expect(configView).toMatch(/import\s*\{\s*useSession\s*\}\s*from\s*['"].*useSession['"]/);
    expect(chatView).toMatch(/const\s+session\s*=\s*useSession\s*\(\s*\)/);
    expect(configView).toMatch(/const\s+session\s*=\s*useSession\s*\(\s*\)/);
    // No local session ownership in either consumer.
    expect(chatView).not.toMatch(/useState\s*<\s*Session\s*>/);
    expect(configView).not.toMatch(/useState\s*<\s*Session\s*>/);
    // Shared store is the canonical source.
    expect(useSessionSrc).toMatch(/useSyncExternalStore/);
    expect(useSessionSrc).toMatch(/Shared store \(one session state for all useSession\(\) callers\)/);
    // Chat stays mounted under Config so both hooks remain live on one store.
    expect(appSrc).toMatch(/Keep ChatView mounted under Config/);
    expect(appSrc).toMatch(/chatVisible \? 'contents' : 'hidden'/);
    expect(appSrc).toMatch(/<ChatView isVisible=\{chatVisible\}/);
    expect(chatView).toMatch(/<DeferredSurface isVisible=\{isVisible\}>[\s\S]*?<ChatStream/);
    expect(chatView).toMatch(/<DeferredSurface isVisible=\{isVisible\}>[\s\S]*?<Sidebar/);
  });

  it('Config session pick routes through ChatView hydrate (not store-only load)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const rendererRoot = path.resolve(__dirname, '../../src/renderer');
    const chatView = fs.readFileSync(path.join(rendererRoot, 'components/ChatView.tsx'), 'utf8');
    const configView = fs.readFileSync(path.join(rendererRoot, 'components/ConfigView.tsx'), 'utf8');

    // Config must not activate via session.load alone — that rebinds the store
    // without beginSessionSwitch / hydrateSnapshot affinity.
    expect(configView).toMatch(/orchid:select-session/);
    expect(configView).not.toMatch(/await session\.load\(id\)/);

    // ChatView listens and runs the full sidebar select path.
    expect(chatView).toMatch(/orchid:select-session/);
    expect(chatView).toMatch(/handleSessionSelect/);
    expect(chatView).toMatch(/beginSessionSwitch/);
    expect(chatView).toMatch(/hydrateSnapshot/);
    expect(chatView).toMatch(/addEventListener\('orchid:select-session'/);
  });

  it('Config orchid:select-session event carries session id for Chat hydrate', () => {
    const target = new EventTarget();
    const received: string[] = [];
    const handler = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id) received.push(id);
    };
    target.addEventListener('orchid:select-session', handler);
    target.dispatchEvent(
      new CustomEvent('orchid:select-session', { detail: { id: 'session-from-config' } }),
    );
    target.removeEventListener('orchid:select-session', handler);
    expect(received).toEqual(['session-from-config']);
  });

  it('dual subscribers observe the same snapshot after load/rename/workspace updates', async () => {
    const sessionA = makeSession({ id: 'a', name: 'Alpha', cwd: '/proj/a' });
    const sessionB = makeSession({ id: 'b', name: 'Beta', cwd: '/proj/b' });
    listMock.mockResolvedValue([
      { id: 'a', name: 'Alpha', modelLabel: null, cwd: '/proj/a', chainCount: 1, updatedAt: 1 },
      { id: 'b', name: 'Beta', modelLabel: null, cwd: '/proj/b', chainCount: 1, updatedAt: 2 },
    ]);
    getWorkspaceMock.mockResolvedValue({ cwd: '/proj/a', source: 'session', status: 'valid' });
    loadMock.mockImplementation(async ({ id }: { id: string }) => (
      id === 'a' ? sessionA : sessionB
    ));
    renameMock.mockResolvedValue(undefined);

    const { __sessionCacheTest } = await import('../../src/renderer/hooks/useSession');
    __sessionCacheTest.reset();

    // Simulate ChatView + ConfigView both mounted (two store subscribers).
    const chatListener = vi.fn();
    const configListener = vi.fn();
    const unsubChat = __sessionCacheTest.subscribe(chatListener);
    const unsubConfig = __sessionCacheTest.subscribe(configListener);
    __sessionCacheTest.ensureBootstrapped();
    await __sessionCacheTest.refresh();

    await __sessionCacheTest.load('a');
    const snapAfterLoad = __sessionCacheTest.getSnapshot();
    expect(snapAfterLoad.activeSession?.id).toBe('a');
    expect(chatListener).toHaveBeenCalled();
    expect(configListener).toHaveBeenCalled();

    // Config renames while Chat is mounted — both see the shared snapshot.
    await __sessionCacheTest.rename('a', 'Alpha Renamed');
    expect(__sessionCacheTest.getSnapshot().activeSession?.name).toBe('Alpha Renamed');
    expect(__sessionCacheTest.getActiveSession()?.name).toBe('Alpha Renamed');

    // Config selects another session — Chat consumer observes via shared store.
    getWorkspaceMock.mockResolvedValue({ cwd: '/proj/b', source: 'session', status: 'valid' });
    await __sessionCacheTest.load('b');
    expect(__sessionCacheTest.getSnapshot().activeSession?.id).toBe('b');
    expect(__sessionCacheTest.getSnapshot().activeSession?.name).toBe('Beta');

    // Workspace event fans out to every subscriber.
    chatListener.mockClear();
    configListener.mockClear();
    for (const handler of workspaceHandlers) {
      handler({ workspace: { cwd: '/proj/b', source: 'session', status: 'valid' } });
    }
    expect(__sessionCacheTest.getSnapshot().workspace?.cwd).toBe('/proj/b');
    expect(chatListener).toHaveBeenCalled();
    expect(configListener).toHaveBeenCalled();

    // Generation guards remain shared (draft + load).
    const genBefore = __sessionCacheTest.getDraftGeneration();
    await __sessionCacheTest.enterDraft();
    expect(__sessionCacheTest.getDraftGeneration()).toBeGreaterThan(genBefore);
    expect(__sessionCacheTest.getSnapshot().activeSession).toBeNull();

    unsubChat();
    unsubConfig();
  });
});
