import type { StartupStepId } from '../shared/types/ipc-boundary';
import type { StartupState } from './startup';

export type ToolWorkerPoolStartupResult =
  | { status: 'ready' }
  | { status: 'disabled' }
  | { status: 'unavailable' };

export interface StartupLifecycleDependencies {
  state: StartupState;
  openWindow: () => void | Promise<void>;
  /** Yield exactly one event-loop turn so the renderer can present active work. */
  yieldForPresentation: () => Promise<void>;
  loadSettingsAndProviders: () => void | Promise<void>;
  loadAgentsAndTools: () => void | Promise<void>;
  startToolWorkers: () => Promise<ToolWorkerPoolStartupResult>;
  /** Must register normal IPC before this stage settles and startup becomes terminal. */
  prepareInterface: () => void | Promise<void>;
  /** Detailed diagnostics stay local; startup state remains sanitized. */
  logFailure: (step: StartupStepId | null, error: unknown) => void;
}

export type StartupLifecycleResult = 'ready' | 'degraded' | 'failed';

/**
 * Runs the main-owned startup sequence. Each stage is made visible before its
 * substantial work begins, while the renderer only receives immutable state.
 */
export async function runStartupLifecycle(
  dependencies: StartupLifecycleDependencies,
): Promise<StartupLifecycleResult> {
  const { state } = dependencies;
  let activeStep: StartupStepId | null = null;

  const runStage = async (
    id: Exclude<StartupStepId, 'tool_workers'>,
    work: () => void | Promise<void>,
  ): Promise<void> => {
    activeStep = id;
    state.activate(id);
    if (id !== 'opening_window') await dependencies.yieldForPresentation();
    await work();
    state.complete(id);
    activeStep = null;
    if (id === 'opening_window') await dependencies.yieldForPresentation();
  };

  try {
    await runStage('opening_window', dependencies.openWindow);
    await runStage('settings_providers', dependencies.loadSettingsAndProviders);
    await runStage('agents_tools', dependencies.loadAgentsAndTools);

    activeStep = 'tool_workers';
    state.activate(activeStep);
    await dependencies.yieldForPresentation();
    const workerResult = await dependencies.startToolWorkers();
    state.recordWorkerOutcome(
      workerResult.status === 'ready'
        ? 'success'
        : workerResult.status === 'disabled'
          ? 'disabled'
          : 'failure',
    );
    activeStep = null;

    await runStage('preparing_interface', dependencies.prepareInterface);
    if (workerResult.status === 'unavailable') {
      state.degraded();
      return 'degraded';
    }
    state.ready();
    return 'ready';
  } catch (error) {
    dependencies.logFailure(activeStep, error);
    if (activeStep !== null && state.snapshot().phase === 'starting') {
      state.fail(activeStep);
    }
    return 'failed';
  }
}
