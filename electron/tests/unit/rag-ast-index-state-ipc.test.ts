/**
 * rag:index_state / ast:index_state host routing (#14).
 *
 * Both channels used to read THIS machine's in-flight index runs while
 * rag:status/ast:status already routed to the active machine's host — a
 * remote-active Workspace Index panel mixed remote status with local
 * busy/progress. The handlers must now go through hostRequest (the host
 * binding resolves the caller client's bound project itself), never through
 * the local session-manager path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    hostRequest: vi.fn(async (_windowId: string, channel: string) => ({
      routed: channel,
    })),
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    resolveBoundProjectPath: vi.fn((): string | null => '/tmp/should-not-be-read'),
    ragGetIndexState: vi.fn(() => ({ indexing: false, progress: null })),
    astGetIndexState: vi.fn(() => ({ indexing: false, progress: null })),
  };
});

vi.mock('electron', () => ({ ipcMain: mocks.ipcMain }));

vi.mock('../../src/main/ipc/host-request', () => ({
  hostRequest: mocks.hostRequest,
}));

// The local resolution path the handlers must NOT take anymore.
vi.mock('../../src/main/ipc/session', () => ({
  resolveBoundProjectPath: mocks.resolveBoundProjectPath,
}));
vi.mock('../../src/main/session/singleton', () => ({
  resolveBoundProjectPath: mocks.resolveBoundProjectPath,
  resolveWindowWorkspace: () => ({ cwd: null, source: 'unbound', status: 'unbound' }),
  getSessionManager: () => ({ getActive: () => null, listSaved: () => [] }),
}));
vi.mock('../../src/main/rag/indexer', () => ({
  getIndexState: mocks.ragGetIndexState,
}));
vi.mock('../../src/main/ast/indexer', () => ({
  getIndexState: mocks.astGetIndexState,
}));

function handler(channel: string): (...args: unknown[]) => unknown {
  const registered = mocks.handlers.get(channel);
  if (!registered) throw new Error(`Missing handler: ${channel}`);
  return (event?: unknown) => registered(event ?? { sender: { id: 42 } });
}

describe('rag:index_state / ast:index_state host routing (#14)', () => {
  let ragIpc: typeof import('../../src/main/ipc/rag');
  let astIpc: typeof import('../../src/main/ipc/ast');

  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.hostRequest.mockClear();
    mocks.resolveBoundProjectPath.mockClear();
    mocks.ragGetIndexState.mockClear();
    mocks.astGetIndexState.mockClear();
    ragIpc = await import('../../src/main/ipc/rag');
    astIpc = await import('../../src/main/ipc/ast');
    ragIpc.registerRAGIPC();
    astIpc.registerASTIPC();
  });

  afterEach(() => {
    ragIpc.unregisterRAGIPC();
    astIpc.unregisterASTIPC();
  });

  it('routes rag:index_state through the active machine\'s host, not the local index state', async () => {
    const result = await handler(IPC_CHANNELS.RAG_INDEX_STATE)();

    // The window's sender id is forwarded so a remote-active window resolves
    // against the remote host's bound project.
    expect(mocks.hostRequest).toHaveBeenCalledTimes(1);
    expect(mocks.hostRequest).toHaveBeenCalledWith('42', IPC_CHANNELS.RAG_INDEX_STATE);
    expect(result).toEqual({ routed: IPC_CHANNELS.RAG_INDEX_STATE });
    expect(mocks.ragGetIndexState).not.toHaveBeenCalled();
    expect(mocks.resolveBoundProjectPath).not.toHaveBeenCalled();
  });

  it('routes ast:index_state through the active machine\'s host, not the local index state', async () => {
    const result = await handler(IPC_CHANNELS.AST_INDEX_STATE)();

    expect(mocks.hostRequest).toHaveBeenCalledTimes(1);
    expect(mocks.hostRequest).toHaveBeenCalledWith('42', IPC_CHANNELS.AST_INDEX_STATE);
    expect(result).toEqual({ routed: IPC_CHANNELS.AST_INDEX_STATE });
    expect(mocks.astGetIndexState).not.toHaveBeenCalled();
    expect(mocks.resolveBoundProjectPath).not.toHaveBeenCalled();
  });
});
