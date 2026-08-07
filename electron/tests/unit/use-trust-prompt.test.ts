// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTrustPrompt } from '../../src/renderer/hooks/useTrustPrompt';
import { useChat } from '../../src/renderer/hooks/useChat';
import type {
  ChatSendResult,
  ProjectTrustInfo,
  ProjectTrustReport,
} from '../../src/shared/types/ipc';

function report(): ProjectTrustReport {
  return {
    projectDir: '/proj',
    hasSurface: true,
    mcpServers: [{ name: 'context7', kind: 'added', command: 'npx' }],
    permissions: [],
    agentsMdOverrides: [],
    modelOverrides: [],
    otherConfigOverrides: [],
    definitions: [],
    instructionFiles: [],
  };
}

function trustInfo(state: ProjectTrustInfo['state']): ProjectTrustInfo {
  return {
    projectDir: '/proj',
    state,
    report: state === 'trusted' ? null : report(),
  };
}

interface TrustBridgeOptions {
  getState?: ProjectTrustInfo['state'];
  getImpl?: (message: { cwd: string }) => Promise<ProjectTrustInfo>;
  setImpl?: (message: { cwd: string; trusted: boolean }) => Promise<ProjectTrustInfo>;
}

function installTrustBridge(options: TrustBridgeOptions = {}) {
  const get = vi.fn(options.getImpl ?? (() => Promise.resolve(trustInfo(options.getState ?? 'untrusted'))));
  const set = vi.fn(options.setImpl ?? ((message: { cwd: string }) => Promise.resolve({
    ...trustInfo('trusted'),
    projectDir: message.cwd,
  })));
  Object.defineProperty(window, 'orchid', {
    configurable: true,
    value: {
      projectTrust: {
        get,
        set,
        list: vi.fn(() => Promise.resolve([])),
        onChanged: vi.fn(() => () => {}),
      },
    },
  });
  return { get, set };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as Partial<Window>).orchid;
});

describe('useTrustPrompt', () => {
  it('no-ops when the project is already trusted', async () => {
    const { get } = installTrustBridge({ getState: 'trusted' });
    const { result } = renderHook(() => useTrustPrompt());

    act(() => {
      result.current.openFor('/proj');
    });

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    // Give any erroneous state update a tick to land.
    await act(async () => {});
    expect(result.current.pending).toBeNull();
  });

  it('opens with the report when the project is untrusted', async () => {
    const { get } = installTrustBridge({ getState: 'untrusted' });
    const { result } = renderHook(() => useTrustPrompt());

    act(() => {
      result.current.openFor('/proj');
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(get).toHaveBeenCalledWith({ cwd: '/proj' });
    expect(result.current.pending?.cwd).toBe('/proj');
    expect(result.current.pending?.info.state).toBe('untrusted');
    expect(result.current.pending?.info.report?.mcpServers).toHaveLength(1);
  });

  it('opens for changed projects too (re-confirmation)', async () => {
    installTrustBridge({ getState: 'changed' });
    const { result } = renderHook(() => useTrustPrompt());

    act(() => {
      result.current.openFor('/proj');
    });

    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending?.info.state).toBe('changed');
  });

  it('grant persists trust, closes, and runs onGranted with the cwd', async () => {
    const { set } = installTrustBridge({ getState: 'untrusted' });
    const onGranted = vi.fn();
    const { result } = renderHook(() => useTrustPrompt({ onGranted }));

    act(() => {
      result.current.openFor('/proj');
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());

    await act(async () => {
      await result.current.grant();
    });

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ cwd: '/proj', trusted: true });
    expect(result.current.pending).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(onGranted).toHaveBeenCalledWith('/proj');
  });

  it('decline closes without calling projectTrust.set', async () => {
    const { set } = installTrustBridge({ getState: 'untrusted' });
    const onGranted = vi.fn();
    const { result } = renderHook(() => useTrustPrompt({ onGranted }));

    act(() => {
      result.current.openFor('/proj');
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());

    act(() => {
      result.current.decline();
    });

    expect(result.current.pending).toBeNull();
    expect(set).not.toHaveBeenCalled();
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('a newer openFor supersedes a stale in-flight lookup', async () => {
    let resolveFirst: ((info: ProjectTrustInfo) => void) | null = null;
    const getImpl = vi.fn((message: { cwd: string }) => {
      if (message.cwd === '/stale') {
        return new Promise<ProjectTrustInfo>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ ...trustInfo('untrusted'), projectDir: message.cwd });
    });
    installTrustBridge({ getImpl });
    const { result } = renderHook(() => useTrustPrompt());

    act(() => {
      result.current.openFor('/stale');
      result.current.openFor('/fresh');
    });

    await waitFor(() => expect(result.current.pending?.cwd).toBe('/fresh'));

    // The stale lookup resolves late; it must not replace the fresh dialog.
    await act(async () => {
      resolveFirst?.({ ...trustInfo('untrusted'), projectDir: '/stale' });
    });
    expect(result.current.pending?.cwd).toBe('/fresh');
  });

  it('keeps the dialog open with an error when grant fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { set } = installTrustBridge({
      getState: 'untrusted',
      setImpl: () => Promise.reject(new Error('vault locked')),
    });
    const { result } = renderHook(() => useTrustPrompt());

    act(() => {
      result.current.openFor('/proj');
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());

    await act(async () => {
      await result.current.grant();
    });

    expect(set).toHaveBeenCalledTimes(1);
    // The dialog stays open for retry; busy resets and the error surfaces.
    expect(result.current.pending?.cwd).toBe('/proj');
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe('Trusting this project failed. Try again.');
  });

  it('sets an error without opening the dialog when the trust lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installTrustBridge({
      getImpl: () => Promise.reject(new Error('ipc unavailable')),
    });
    const { result } = renderHook(() => useTrustPrompt());

    act(() => {
      expect(() => result.current.openFor('/proj')).not.toThrow();
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Could not check this project's trust state. Try again.");
    });
    expect(result.current.pending).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it('clears the error on the next openFor start and on decline', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let failLookup = true;
    installTrustBridge({
      getImpl: () => (failLookup
        ? Promise.reject(new Error('ipc down'))
        : Promise.resolve(trustInfo('untrusted'))),
      setImpl: () => Promise.reject(new Error('vault locked')),
    });
    const { result } = renderHook(() => useTrustPrompt());

    // Lookup failure sets the error without opening the dialog.
    act(() => {
      result.current.openFor('/proj');
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.pending).toBeNull();

    // The next openFor clears the error and opens normally.
    failLookup = false;
    act(() => {
      result.current.openFor('/proj');
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.error).toBeNull();

    // A failed grant sets the error again; decline clears it.
    await act(async () => {
      await result.current.grant();
    });
    expect(result.current.error).toBe('Trusting this project failed. Try again.');

    act(() => {
      result.current.decline();
    });
    expect(result.current.pending).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

// ── useChat untrusted_project send-failure mapping ───────────────────────────

function installChatBridge(sendResult: ChatSendResult) {
  const send = vi.fn(() => Promise.resolve(sendResult));
  Object.defineProperty(window, 'orchid', {
    configurable: true,
    value: {
      chat: {
        send,
        onChunk: vi.fn(() => () => {}),
        onThinking: vi.fn(() => () => {}),
        onState: vi.fn(() => () => {}),
        onDone: vi.fn(() => () => {}),
        onError: vi.fn(() => () => {}),
        onUsage: vi.fn(() => () => {}),
        onToolCallStart: vi.fn(() => () => {}),
        onToolCallDelta: vi.fn(() => () => {}),
        onToolCallUpdate: vi.fn(() => () => {}),
      },
    },
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    let n = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++n}` });
  }
  return { send };
}

const UNTRUSTED_RESULT: ChatSendResult = {
  status: 'error',
  kind: 'untrusted_project',
  error: 'Project directory is not trusted yet.',
};

describe('useChat untrusted_project mapping', () => {
  it('invokes onUntrustedProject and suppresses the raw error bubble', async () => {
    const { send } = installChatBridge(UNTRUSTED_RESULT);
    const onUntrustedProject = vi.fn();
    const { result } = renderHook(() => useChat('session-a', { onUntrustedProject }));

    let started = true;
    await act(async () => {
      started = await result.current.send('hello');
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(started).toBe(false);
    expect(onUntrustedProject).toHaveBeenCalledTimes(1);
    // No raw error bubble; the optimistic user message was dropped.
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe('idle');
    expect(result.current.messages).toHaveLength(0);
  });

  it('keeps the generic error behavior when no callback is provided', async () => {
    const { send } = installChatBridge(UNTRUSTED_RESULT);
    const { result } = renderHook(() => useChat('session-a'));

    let started = true;
    await act(async () => {
      started = await result.current.send('hello');
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(started).toBe(false);
    expect(result.current.error).toBe('Project directory is not trusted yet.');
    expect(result.current.status).toBe('error');
    // Optimistic bubble dropped on gate failure.
    expect(result.current.messages).toHaveLength(0);
  });
});
