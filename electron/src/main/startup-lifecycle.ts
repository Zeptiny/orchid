import type { StartupStepId } from '../shared/types/ipc-boundary';
import type { StartupState } from './startup';

export type ToolWorkerPoolStartupResult =
  | { status: 'ready' }
  | { status: 'disabled' }
  | { status: 'unavailable' };

export interface StartupLifecycleDependencies {
  state: StartupState;
  /** Aborts startup during application shutdown without publishing a failed UI state. */
  abortSignal?: AbortSignal;
  openWindow: () => void | Promise<void>;
  /** Yield exactly one event-loop turn so the renderer can present active work. */
  yieldForPresentation: () => Promise<void>;
  loadSettingsAndProviders: () => void | Promise<void>;
  loadAgentsAndTools: () => void | Promise<void>;
  startToolWorkers: () => Promise<ToolWorkerPoolStartupResult>;
  /**
   * Start the embedded local host (the unified client protocol for the local
   * machine, U5). Runs after providers/agents/tools are up and before the IPC
   * facade is registered. Failure degrades startup (the lazy path retries on
   * the first machine-scoped request) rather than failing it.
   */
  startLocalHost?: () => void | Promise<void>;
  /** Must register normal IPC before this stage settles and startup becomes terminal. */
  prepareInterface: () => void | Promise<void>;
  /** Detailed diagnostics stay local; startup state remains sanitized. */
  logFailure: (step: StartupStepId | null, error: unknown) => void;
}

export type StartupLifecycleResult = 'ready' | 'degraded' | 'failed' | 'aborted';

/**
 * Runs the main-owned startup sequence. Each stage is made visible before its
 * substantial work begins, while the renderer only receives immutable state.
 */
export async function runStartupLifecycle(
  dependencies: StartupLifecycleDependencies,
): Promise<StartupLifecycleResult> {
  const { state } = dependencies;
  let activeStep: StartupStepId | null = null;

  const isAborted = () => dependencies.abortSignal?.aborted === true;

  const runStage = async (
    id: Exclude<StartupStepId, 'tool_workers'>,
    work: () => void | Promise<void>,
  ): Promise<boolean> => {
    if (isAborted()) return false;
    activeStep = id;
    state.activate(id);
    if (id !== 'opening_window') await dependencies.yieldForPresentation();
    if (isAborted()) return false;
    await work();
    if (isAborted()) return false;
    state.complete(id);
    activeStep = null;
    if (id === 'opening_window') await dependencies.yieldForPresentation();
    return !isAborted();
  };

  try {
    if (!await runStage('opening_window', dependencies.openWindow)) return 'aborted';
    if (!await runStage('settings_providers', dependencies.loadSettingsAndProviders)) return 'aborted';
    if (!await runStage('agents_tools', dependencies.loadAgentsAndTools)) return 'aborted';

    if (isAborted()) return 'aborted';
    activeStep = 'tool_workers';
    state.activate(activeStep);
    await dependencies.yieldForPresentation();
    if (isAborted()) return 'aborted';
    const workerResult = await dependencies.startToolWorkers();
    if (isAborted()) return 'aborted';
    state.recordWorkerOutcome(
      workerResult.status === 'ready'
        ? 'success'
        : workerResult.status === 'disabled'
          ? 'disabled'
          : 'failure',
    );
    activeStep = null;

    let localHostDegraded = false;
    if (dependencies.startLocalHost) {
      if (isAborted()) return 'aborted';
      try {
        await dependencies.startLocalHost();
      } catch (error) {
        // The embedded host is retryable lazily, so treat a failure as a
        // degraded (not failed) startup exactly like the worker-pool case.
        dependencies.logFailure('preparing_interface', error);
        localHostDegraded = true;
      }
    }
    if (isAborted()) return 'aborted';

    if (!await runStage('preparing_interface', dependencies.prepareInterface)) return 'aborted';
    if (workerResult.status === 'unavailable' || localHostDegraded) {
      state.degraded();
      return 'degraded';
    }
    state.ready();
    return 'ready';
  } catch (error) {
    dependencies.logFailure(activeStep, error);
    if (activeStep !== null && state.snapshot().phase === 'starting') {
      try {
        state.fail(activeStep);
      } catch (transitionError) {
        dependencies.logFailure(activeStep, transitionError);
      }
    }
    return 'failed';
  }
}
