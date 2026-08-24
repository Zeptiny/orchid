import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const selectedByWebContents = new Map<number, string>();
  const activeTurnOwnerBySession = new Map<string, string>();
  const webContentsById = new Map<string, {
    id: number;
    isDestroyed: () => boolean;
    send: ReturnType<typeof vi.fn>;
  }>();

  return {
    handlers,
    selectedByWebContents,
    activeTurnOwnerBySession,
    webContentsById,
    configState: { approval_timeout: 5 } as unknown,
    forceAbortMainTurn: vi.fn(),
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    sessionManager: {
      getActive: vi.fn((ownerId: string) => {
        const id = selectedByWebContents.get(Number(ownerId));
        return id ? { id } : null;
      }),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
}));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return {
    ...actual,
    getConfig: () => mocks.configState,
  };
});

vi.mock('../../src/main/ipc/chat', () => ({
  forceAbortMainTurn: mocks.forceAbortMainTurn,
  getActiveMainTurnWindowId: (sessionId: string) =>
    mocks.activeTurnOwnerBySession.get(sessionId) ?? null,
  webContentsForWindowId: (windowId: string) => {
    const webContents = mocks.webContentsById.get(windowId);
    return webContents && !webContents.isDestroyed() ? webContents : null;
  },
}));

// U5: ask_question:cancel now aborts through the host pipeline binding, which
// sources forceAbortMainTurn from host/chat/abort instead of the IPC facade.
vi.mock('../../src/main/host/chat/abort', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  forceAbortMainTurn: mocks.forceAbortMainTurn,
}));

vi.mock('../../src/main/ipc/session', () => ({
  getSessionManager: () => mocks.sessionManager,
}));

// U5: the host-routed handlers resolve the caller's active session through the
// session singleton (the server binding), not the IPC re-export.
vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => mocks.sessionManager,
  resolveWindowWorkspace: () => ({ cwd: null, source: 'unbound', status: 'unbound' }),
  resolveBoundProjectPath: () => null,
}));

import {
  registerAskQuestionIPC,
  unregisterAskQuestionIPC,
} from '../../src/main/ipc/ask-question';
import { questionStore } from '../../src/main/tools/ask-question/store';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const TOOL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOOL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const QUESTIONS = [{ type: 'single', title: 'Choose', options: [{ label: 'A' }] }];

function addWindow(id: number, destroyed = false) {
  const webContents = {
    id,
    isDestroyed: () => destroyed,
    send: vi.fn(),
  };
  mocks.webContentsById.set(String(id), webContents);
  return { webContents };
}

function eventFrom(id: number) {
  return { sender: { id } };
}

describe('ask_question IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.selectedByWebContents.clear();
    mocks.activeTurnOwnerBySession.clear();
    mocks.webContentsById.clear();
    mocks.forceAbortMainTurn.mockClear();
    questionStore.cleanupAll();
    registerAskQuestionIPC();
  });

  afterEach(() => {
    vi.useRealTimers();
    unregisterAskQuestionIPC();
  });

  it('replays pending questions only to windows viewing the owning session', async () => {
    const owner = addWindow(10);
    const other = addWindow(20);
    mocks.selectedByWebContents.set(10, SESSION_A);
    mocks.selectedByWebContents.set(20, SESSION_B);

    void questionStore.create(TOOL_A, SESSION_A, QUESTIONS);
    // Owner binding the turn's window would establish (the host binds the
    // active main-turn window, or promotes the first connected viewer).
    expect(questionStore.bindOwnerWindow(TOOL_A, '10')).toBe(true);

    // Delivery is protocol-owned now (host server + window broadcast); this
    // module only exposes the replay + answer surface.
    expect(owner.webContents.send).not.toHaveBeenCalled();
    expect(other.webContents.send).not.toHaveBeenCalled();

    const snapshot = mocks.handlers.get(IPC_CHANNELS.ASK_QUESTION_SNAPSHOT)!;
    await expect(snapshot(eventFrom(10))).resolves.toEqual({
      questions: [{ sessionId: SESSION_A, toolCallId: TOOL_A, questions: QUESTIONS }],
    });
    await expect(snapshot(eventFrom(20))).resolves.toEqual({ questions: [] });
  });

  it('settles a pending question exactly once when answered', async () => {
    addWindow(10);
    mocks.selectedByWebContents.set(10, SESSION_A);
    const pending = questionStore.create(TOOL_A, SESSION_A, QUESTIONS);
    expect(questionStore.bindOwnerWindow(TOOL_A, '10')).toBe(true);

    expect(questionStore.answer(TOOL_A, [])).toBe(true);
    expect(questionStore.answer(TOOL_A, [])).toBe(false);
    await expect(pending).resolves.toMatchObject({ type: 'answered' });
    expect(questionStore.get(TOOL_A)).toBeUndefined();
  });

  it('keeps a question pending with no owner renderer and settles it cancelled at the timeout (fail-closed)', async () => {
    vi.useFakeTimers();
    // No window is connected and no renderer exists for the owner — the
    // question must stay pending (never auto-answered, never aborted) and
    // settle CANCELLED at the approval timeout boundary (R7).
    mocks.activeTurnOwnerBySession.set(SESSION_A, '10');

    const pending = questionStore.create(TOOL_A, SESSION_A, QUESTIONS);

    expect(questionStore.get(TOOL_A)).toBeDefined();
    expect(mocks.forceAbortMainTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ type: 'cancelled' });
    expect(questionStore.get(TOOL_A)).toBeUndefined();
    expect(mocks.forceAbortMainTurn).not.toHaveBeenCalled();
  });

  it('does not expose or settle a question from another window on the same session', async () => {
    addWindow(10);
    addWindow(20);
    mocks.selectedByWebContents.set(10, SESSION_A);
    mocks.selectedByWebContents.set(20, SESSION_A);
    const pending = questionStore.create(TOOL_A, SESSION_A, QUESTIONS);
    expect(questionStore.bindOwnerWindow(TOOL_A, '10')).toBe(true);

    const snapshot = mocks.handlers.get(IPC_CHANNELS.ASK_QUESTION_SNAPSHOT)!;
    await expect(snapshot(eventFrom(20))).resolves.toEqual({ questions: [] });

    const answer = mocks.handlers.get(IPC_CHANNELS.ASK_QUESTION_ANSWER)!;
    await expect(answer(eventFrom(20), { toolCallId: TOOL_A, answers: [] })).resolves.toEqual({ ok: false });
    expect(questionStore.get(TOOL_A)).toBeDefined();

    await expect(answer(eventFrom(10), { toolCallId: TOOL_A, answers: [] })).resolves.toEqual({ ok: true });
    await expect(pending).resolves.toEqual({ type: 'answered', answers: [] });
  });

  it('rejects a different window and runtime-validates answer payloads', async () => {
    addWindow(10);
    addWindow(20);
    mocks.selectedByWebContents.set(10, SESSION_A);
    mocks.selectedByWebContents.set(20, SESSION_B);
    mocks.activeTurnOwnerBySession.set(SESSION_A, '10');
    const pending = questionStore.create(TOOL_A, SESSION_A, QUESTIONS);
    expect(questionStore.bindOwnerWindow(TOOL_A, '10')).toBe(true);
    const answer = mocks.handlers.get(IPC_CHANNELS.ASK_QUESTION_ANSWER)!;

    await expect(answer(eventFrom(20), { toolCallId: TOOL_A, answers: [] })).resolves.toEqual({ ok: false });
    expect(() => answer(eventFrom(10), {
      toolCallId: TOOL_A,
      answers: [{ selected: 'A', text: null, skipped: false }],
    })).toThrow();
    await expect(answer(eventFrom(10), {
      toolCallId: TOOL_A,
      answers: [{ selected: ['A'], text: null, skipped: false }],
    })).resolves.toEqual({ ok: true });
    await expect(pending).resolves.toMatchObject({ type: 'answered' });
  });

  it('cancels only the owning main turn and validates cancel payloads', async () => {
    addWindow(10);
    mocks.selectedByWebContents.set(10, SESSION_A);
    mocks.activeTurnOwnerBySession.set(SESSION_A, '10');
    const pending = questionStore.create(TOOL_B, SESSION_A, QUESTIONS);
    expect(questionStore.bindOwnerWindow(TOOL_B, '10')).toBe(true);
    const cancel = mocks.handlers.get(IPC_CHANNELS.ASK_QUESTION_CANCEL)!;

    expect(() => cancel(eventFrom(10), { toolCallId: 'not-a-uuid' })).toThrow();
    await expect(cancel(eventFrom(10), { toolCallId: TOOL_B })).resolves.toEqual({ ok: true });
    await expect(pending).resolves.toEqual({ type: 'cancelled' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.forceAbortMainTurn).toHaveBeenCalledWith(
      SESSION_A,
      { emitTerminalEvents: true },
    );
  });
});
