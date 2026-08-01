// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/App';
import { StartupScreen } from '../../src/renderer/components/StartupScreen';
import type { StartupSnapshot, StartupStepState } from '../../src/shared/types/ipc-boundary';

const { readyAppRender } = vi.hoisted(() => ({ readyAppRender: vi.fn() }));

vi.mock('../../src/renderer/AppReady', () => ({
  default: () => {
    readyAppRender();
    return <div data-testid="ready-application">Orchid is ready</div>;
  },
}));

const STEP_IDS = [
  'opening_window',
  'settings_providers',
  'agents_tools',
  'tool_workers',
  'preparing_interface',
] as const;

const STEP_LABELS = [
  'Opening window',
  'Loading settings and providers',
  'Loading agents and tools',
  'Starting tool workers',
  'Preparing the application interface',
] as const;

function snapshot(
  revision: number,
  phase: StartupSnapshot['phase'] = 'starting',
  states: readonly StartupStepState[] = ['complete', 'active', 'pending', 'pending', 'pending'],
): StartupSnapshot {
  return {
    revision,
    phase,
    steps: STEP_IDS.map((id, index) => ({
      id,
      label: STEP_LABELS[index],
      state: states[index],
      durationMs: states[index] === 'pending' || states[index] === 'active' ? null : 5,
    })),
  };
}

function installStartupBridge(options: {
  initial: Promise<StartupSnapshot> | StartupSnapshot;
  continueResult?: Promise<{ ok: boolean; snapshot: StartupSnapshot }>;
}) {
  let listener: ((next: StartupSnapshot) => void) | undefined;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((callback: (next: StartupSnapshot) => void) => {
    listener = callback;
    return unsubscribe;
  });
  const continueDegraded = vi.fn(() => options.continueResult ?? Promise.resolve({
    ok: true,
    snapshot: snapshot(4, 'ready', ['complete', 'complete', 'complete', 'warning', 'complete']),
  }));

  Object.defineProperty(window, 'orchid', {
    configurable: true,
    value: {
      startup: {
        snapshot: vi.fn(() => Promise.resolve(options.initial)),
        continueDegraded,
        onChanged: subscribe,
      },
    },
  });

  return {
    emit: (next: StartupSnapshot) => listener?.(next),
    subscribe,
    unsubscribe,
    continueDegraded,
  };
}

afterEach(() => {
  cleanup();
  delete (window as Partial<Window>).orchid;
});

describe('StartupScreen', () => {
  it('renders the fixed startup steps and their truthful states', async () => {
    const bridge = installStartupBridge({
      initial: snapshot(1, 'starting', ['pending', 'active', 'complete', 'skipped', 'warning']),
    });

    render(<StartupScreen onReady={vi.fn()} />);

    await screen.findByText('Loading settings and providers');
    for (const label of STEP_LABELS) expect(screen.getByText(label)).toBeTruthy();
    for (const state of ['Pending', 'In progress', 'Complete', 'Skipped', 'Needs attention']) {
      expect(screen.getByText(state)).toBeTruthy();
    }

    bridge.emit(snapshot(2, 'starting', ['complete', 'complete', 'complete', 'warning', 'failed']));
    expect(await screen.findByText('Failed')).toBeTruthy();
  });

  it('subscribes before hydration and rejects an older snapshot after a newer event', async () => {
    let resolveSnapshot!: (value: StartupSnapshot) => void;
    const initial = new Promise<StartupSnapshot>((resolve) => { resolveSnapshot = resolve; });
    const bridge = installStartupBridge({ initial });

    render(<StartupScreen onReady={vi.fn()} />);

    expect(bridge.subscribe).toHaveBeenCalledTimes(1);
    bridge.emit(snapshot(3, 'starting', ['complete', 'complete', 'complete', 'active', 'pending']));
    resolveSnapshot(snapshot(2, 'starting', ['complete', 'active', 'pending', 'pending', 'pending']));

    expect(await screen.findByText('Starting tool workers')).toBeTruthy();
    expect(screen.getByText('Starting tool workers…')).toBeTruthy();
  });

  it('keeps normal application entry gated in degraded mode until Continue receives ready', async () => {
    const onReady = vi.fn();
    const bridge = installStartupBridge({
      initial: snapshot(3, 'degraded', ['complete', 'complete', 'complete', 'warning', 'complete']),
      continueResult: Promise.resolve({
        ok: true,
        snapshot: snapshot(4, 'ready', ['complete', 'complete', 'complete', 'warning', 'complete']),
      }),
    });

    render(<StartupScreen onReady={onReady} />);

    const continueButton = await screen.findByRole('button', { name: 'Continue with inline tools' });
    expect(onReady).not.toHaveBeenCalled();
    expect(screen.getByText(/less responsive/i)).toBeTruthy();
    fireEvent.click(continueButton);
    fireEvent.click(continueButton);

    await waitFor(() => expect(bridge.continueDegraded).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });

  it('reports a rejected degraded continuation and allows another attempt', async () => {
    const degraded = snapshot(3, 'degraded', ['complete', 'complete', 'complete', 'warning', 'complete']);
    const bridge = installStartupBridge({
      initial: degraded,
      continueResult: Promise.resolve({ ok: false, snapshot: degraded }),
    });

    render(<StartupScreen onReady={vi.fn()} />);

    const continueButton = await screen.findByRole('button', { name: 'Continue with inline tools' });
    fireEvent.click(continueButton);

    expect(await screen.findByText(/could not continue with inline tools/i)).toBeTruthy();
    await waitFor(() => expect((continueButton as HTMLButtonElement).disabled).toBe(false));
    expect(bridge.continueDegraded).toHaveBeenCalledTimes(1);
  });

  it('shows restart guidance for fatal startup failure without exposing details', async () => {
    const onReady = vi.fn();
    installStartupBridge({
      initial: snapshot(5, 'failed', ['complete', 'complete', 'failed', 'pending', 'pending']),
    });

    render(<StartupScreen onReady={onReady} />);

    expect((await screen.findByRole('alert')).textContent).toContain('Orchid could not finish starting');
    expect(screen.getByText(/quit Orchid and start it again/i)).toBeTruthy();
    expect(onReady).not.toHaveBeenCalled();
  });

  it('cleans up the startup listener on unmount', async () => {
    const bridge = installStartupBridge({ initial: snapshot(1) });
    const view = render(<StartupScreen onReady={vi.fn()} />);

    await screen.findByText('Loading settings and providers');
    view.unmount();

    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('replaces startup markup with the normal app exactly once after ready', async () => {
    readyAppRender.mockClear();
    installStartupBridge({
      initial: snapshot(6, 'ready', ['complete', 'complete', 'complete', 'complete', 'complete']),
    });

    render(<App />);

    expect(await screen.findByTestId('ready-application')).toBeTruthy();
    expect(screen.queryByLabelText('Startup steps')).toBeNull();
    expect(readyAppRender).toHaveBeenCalledTimes(1);
  });
});
