import { describe, expect, it, vi } from 'vitest';
import { StartupState } from '../../src/main/startup';
import { runStartupLifecycle } from '../../src/main/startup-lifecycle';

function createLifecycle(overrides: Partial<Parameters<typeof runStartupLifecycle>[0]> = {}) {
  const events: string[] = [];
  const state = new StartupState(() => 1);
  state.subscribe((snapshot) => {
    const active = snapshot.steps.find((step) => step.state === 'active');
    events.push(active ? `state:${active.id}:active` : `state:${snapshot.phase}`);
  });

  return {
    events,
    state,
    lifecycle: {
      state,
      openWindow: vi.fn(() => { events.push('window'); }),
      yieldForPresentation: vi.fn(async () => { events.push('yield'); }),
      loadSettingsAndProviders: vi.fn(() => { events.push('settings'); }),
      loadAgentsAndTools: vi.fn(() => { events.push('agents'); }),
      startToolWorkers: vi.fn(async () => {
        events.push('workers');
        return { status: 'ready' as const };
      }),
      prepareInterface: vi.fn(() => { events.push('normal-ipc'); }),
      logFailure: vi.fn((step) => { events.push(`failure:${step ?? 'none'}`); }),
      ...overrides,
    },
  };
}

describe('startup lifecycle', () => {
  it('opens the window and startup IPC-facing state before substantial startup work', async () => {
    const { lifecycle, events, state } = createLifecycle();

    await expect(runStartupLifecycle(lifecycle)).resolves.toBe('ready');

    expect(events).toEqual([
      'state:opening_window:active', 'window', 'state:starting', 'yield',
      'state:settings_providers:active', 'yield', 'settings', 'state:starting',
      'state:agents_tools:active', 'yield', 'agents', 'state:starting',
      'state:tool_workers:active', 'yield', 'workers', 'state:starting',
      'state:preparing_interface:active', 'yield', 'normal-ipc', 'state:starting',
      'state:ready',
    ]);
    expect(state.snapshot().phase).toBe('ready');
  });

  it('settles an unavailable worker attempt as degraded after normal IPC preparation', async () => {
    const { lifecycle, events, state } = createLifecycle({
      startToolWorkers: vi.fn(async () => ({ status: 'unavailable' as const })),
    });

    await expect(runStartupLifecycle(lifecycle)).resolves.toBe('degraded');

    expect(state.snapshot().steps[3]).toMatchObject({ state: 'warning' });
    expect(state.snapshot().phase).toBe('degraded');
    expect(events.indexOf('normal-ipc')).toBeLessThan(events.indexOf('state:degraded'));
  });

  it('settles a disabled worker pool as skipped and opens normally', async () => {
    const { lifecycle, state } = createLifecycle({
      startToolWorkers: vi.fn(async () => ({ status: 'disabled' as const })),
    });

    await expect(runStartupLifecycle(lifecycle)).resolves.toBe('ready');

    expect(state.snapshot()).toMatchObject({ phase: 'ready' });
    expect(state.snapshot().steps[3]).toMatchObject({ state: 'skipped' });
  });

  it('marks the active mandatory stage failed and keeps its terminal state when startup work throws', async () => {
    const error = new Error('provider credentials should stay local');
    const { lifecycle, state } = createLifecycle({
      loadSettingsAndProviders: vi.fn(() => { throw error; }),
    });

    await expect(runStartupLifecycle(lifecycle)).resolves.toBe('failed');

    expect(state.snapshot().phase).toBe('failed');
    expect(state.snapshot().steps.slice(0, 2)).toMatchObject([
      { state: 'complete' },
      { state: 'failed' },
    ]);
    expect(lifecycle.logFailure).toHaveBeenCalledWith('settings_providers', error);
    expect(lifecycle.prepareInterface).not.toHaveBeenCalled();
  });
});
