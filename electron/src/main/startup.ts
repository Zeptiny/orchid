import {
  STARTUP_STEP_DEFINITIONS,
  type StartupPhase,
  type StartupSnapshot,
  type StartupStepId,
  type StartupStepState,
  type ToolWorkerStartupOutcome,
} from '../shared/types/ipc-boundary';

export type StartupClock = () => number;

export const STARTUP_STEPS = STARTUP_STEP_DEFINITIONS;

type MutableStep = {
  id: StartupStepId;
  label: string;
  state: StartupStepState;
  durationMs: number | null;
  startedAt: number | null;
};
type StartupListener = (snapshot: StartupSnapshot) => void;

const TERMINAL_STEP_STATES = new Set<StartupStepState>([
  'complete', 'skipped', 'warning', 'failed',
]);

function monotonicNow(): number {
  return performance.now();
}

function freezeSnapshot(revision: number, phase: StartupPhase, steps: readonly MutableStep[]): StartupSnapshot {
  return Object.freeze({
    revision,
    phase,
    steps: Object.freeze(steps.map(({ id, label, state, durationMs }) => Object.freeze({
      id, label, state, durationMs,
    }))),
  });
}

/** Main-owned startup lifecycle. The renderer only observes immutable snapshots. */
export class StartupState {
  private revision = 0;
  private phase: StartupPhase = 'starting';
  private readonly steps: MutableStep[] = STARTUP_STEPS.map(({ id, label }) => ({
    id,
    label,
    state: 'pending',
    durationMs: null,
    startedAt: null,
  }));
  private currentSnapshot = freezeSnapshot(this.revision, this.phase, this.steps);
  private readonly listeners = new Set<StartupListener>();

  constructor(private readonly clock: StartupClock = monotonicNow) {}

  snapshot(): StartupSnapshot {
    return this.currentSnapshot;
  }

  subscribe(listener: StartupListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activate(id: StartupStepId): StartupSnapshot {
    this.assertStarting();
    const index = this.indexOf(id);
    const step = this.steps[index]!;
    if (step.state !== 'pending') {
      throw new Error(`Startup step '${id}' must be pending before it can become active`);
    }
    if (this.steps.slice(0, index).some((prior) => !TERMINAL_STEP_STATES.has(prior.state))) {
      throw new Error(`Startup step '${id}' cannot begin before the previous step has settled`);
    }
    step.state = 'active';
    step.startedAt = this.clock();
    return this.publish();
  }

  complete(id: StartupStepId): StartupSnapshot {
    return this.settle(id, 'complete');
  }

  skip(id: StartupStepId): StartupSnapshot {
    return this.settle(id, 'skipped');
  }

  warn(id: StartupStepId): StartupSnapshot {
    return this.settle(id, 'warning');
  }

  fail(id: StartupStepId): StartupSnapshot {
    this.settle(id, 'failed', false);
    this.phase = 'failed';
    return this.publish();
  }

  recordWorkerOutcome(outcome: ToolWorkerStartupOutcome): StartupSnapshot {
    switch (outcome) {
      case 'disabled': return this.skip('tool_workers');
      case 'success': return this.complete('tool_workers');
      case 'failure': return this.warn('tool_workers');
    }
  }

  ready(): StartupSnapshot {
    this.assertStarting();
    this.assertAllStepsSettled();
    if (this.steps.some((step) => step.state === 'warning' || step.state === 'failed')) {
      throw new Error('Startup cannot become ready while a step has warning or failed status');
    }
    this.phase = 'ready';
    return this.publish();
  }

  degraded(cause: 'tool-workers' | 'local-host' = 'tool-workers'): StartupSnapshot {
    this.assertStarting();
    this.assertAllStepsSettled();
    if (cause === 'tool-workers' && this.step('tool_workers').state !== 'warning') {
      throw new Error('Startup can become degraded only after a tool worker warning');
    }
    this.phase = 'degraded';
    return this.publish();
  }

  continueDegraded(): boolean {
    if (this.phase !== 'degraded') return false;
    this.phase = 'ready';
    this.publish();
    return true;
  }

  private settle(
    id: StartupStepId,
    state: Extract<StartupStepState, 'complete' | 'skipped' | 'warning' | 'failed'>,
    shouldPublish = true,
  ): StartupSnapshot {
    this.assertStarting();
    const step = this.step(id);
    if (step.state !== 'active' || step.startedAt === null) {
      throw new Error(`Startup step '${id}' must be active before it can become ${state}`);
    }
    const duration = this.clock() - step.startedAt;
    if (duration < 0) {
      throw new Error(`Startup clock regressed while completing '${id}'`);
    }
    step.state = state;
    step.durationMs = duration;
    step.startedAt = null;
    console.log(`[startup] step=${id} outcome=${state} duration_ms=${duration}`);
    return shouldPublish ? this.publish() : this.currentSnapshot;
  }

  private assertStarting(): void {
    if (this.phase !== 'starting') {
      throw new Error(`Startup is in terminal phase '${this.phase}'`);
    }
  }

  private assertAllStepsSettled(): void {
    if (this.steps.some((step) => !TERMINAL_STEP_STATES.has(step.state))) {
      throw new Error('Every startup step must settle before the overall phase can change');
    }
  }

  private indexOf(id: StartupStepId): number {
    const index = this.steps.findIndex((step) => step.id === id);
    if (index === -1) throw new Error(`Unknown startup step '${id}'`);
    return index;
  }

  private step(id: StartupStepId): MutableStep {
    return this.steps[this.indexOf(id)]!;
  }

  private publish(): StartupSnapshot {
    this.revision += 1;
    this.currentSnapshot = freezeSnapshot(this.revision, this.phase, this.steps);
    for (const listener of this.listeners) listener(this.currentSnapshot);
    return this.currentSnapshot;
  }
}

/** Process-wide startup source used by the application lifecycle and startup IPC. */
export const startupState = new StartupState();
