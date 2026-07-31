import { describe, expect, it, vi } from 'vitest';
import {
  StartupState,
  STARTUP_STEPS,
  type StartupClock,
} from '../../src/main/startup';

function clockAt(initial = 0): { clock: StartupClock; advance: (ms: number) => void } {
  let now = initial;
  return {
    clock: () => now,
    advance: (ms) => { now += ms; },
  };
}

describe('StartupState', () => {
  it('publishes ordered immutable snapshots with monotonic revisions and durations', () => {
    const time = clockAt(100);
    const state = new StartupState(time.clock);
    const changed = vi.fn();
    state.subscribe(changed);

    expect(state.snapshot()).toMatchObject({
      revision: 0,
      phase: 'starting',
      steps: STARTUP_STEPS.map(({ id, label }) => ({ id, label, state: 'pending', durationMs: null })),
    });

    state.activate('opening_window');
    time.advance(12);
    state.complete('opening_window');

    const snapshot = state.snapshot();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.steps[0]).toMatchObject({ state: 'complete', durationMs: 12 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.steps)).toBe(true);
    expect(Object.isFrozen(snapshot.steps[0]!)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);

    expect(() => state.activate('agents_tools')).toThrow(/previous step/i);
    expect(state.snapshot()).toBe(snapshot);
  });

  it('rejects regressions, duplicate terminal updates, and post-terminal writes', () => {
    const time = clockAt();
    const state = new StartupState(time.clock);

    state.activate('opening_window');
    state.complete('opening_window');
    expect(() => state.complete('opening_window')).toThrow(/active/i);
    expect(() => state.activate('opening_window')).toThrow(/pending/i);

    state.activate('settings_providers');
    state.fail('settings_providers');
    expect(state.snapshot().phase).toBe('failed');
    expect(() => state.activate('agents_tools')).toThrow(/terminal phase/i);
    expect(() => state.ready()).toThrow(/terminal phase/i);
  });

  it('maps worker outcomes to the fixed skipped, complete, and warning states', () => {
    for (const [outcome, expected] of [
      ['disabled', 'skipped'],
      ['success', 'complete'],
      ['failure', 'warning'],
    ] as const) {
      const time = clockAt();
      const state = new StartupState(time.clock);
      for (const id of ['opening_window', 'settings_providers', 'agents_tools'] as const) {
        state.activate(id);
        state.complete(id);
      }

      state.activate('tool_workers');
      state.recordWorkerOutcome(outcome);
      expect(state.snapshot().steps[3]).toMatchObject({ state: expected, durationMs: 0 });
    }
  });

  it('hydrates late subscribers with every completed step and the latest active state', () => {
    const time = clockAt();
    const state = new StartupState(time.clock);
    state.activate('opening_window');
    state.complete('opening_window');
    state.activate('settings_providers');

    const snapshot = state.snapshot();
    expect(snapshot.revision).toBe(3);
    expect(snapshot.steps.map((step) => step.state)).toEqual([
      'complete', 'active', 'pending', 'pending', 'pending',
    ]);
  });

  it('moves degraded to ready exactly once after the main-owned acknowledgement', () => {
    const time = clockAt();
    const state = new StartupState(time.clock);
    for (const id of ['opening_window', 'settings_providers', 'agents_tools'] as const) {
      state.activate(id);
      state.complete(id);
    }
    state.activate('tool_workers');
    state.recordWorkerOutcome('failure');
    state.activate('preparing_interface');
    state.complete('preparing_interface');
    state.degraded();

    expect(state.snapshot().phase).toBe('degraded');
    expect(state.continueDegraded()).toBe(true);
    expect(state.snapshot().phase).toBe('ready');
    expect(state.continueDegraded()).toBe(false);
  });
});
