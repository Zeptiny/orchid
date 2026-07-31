/**
 * Lifecycle state for one LLM streaming attempt.
 *
 * The controller owns the attempt's idle watchdog and combined cancellation
 * signal. It deliberately knows nothing about AI SDK stream parts: the
 * orchestrator tells it when model output was delivered or a tool is running.
 */

export interface StreamAttemptControllerOptions {
  /** Parent turn cancellation, if the user cancelled the stream. */
  userAbortSignal?: AbortSignal;
  /** Maximum time to wait for model output while no tools are running. */
  idleTimeoutMs: number;
}

/** Merge optional user cancellation with the attempt's idle-timeout signal. */
export function combineAbortSignals(
  userSignal: AbortSignal | undefined,
  idleSignal: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!userSignal) {
    return { signal: idleSignal, dispose: () => {} };
  }
  // Node 20+ / modern Electron — no manual listeners to clean up.
  if (typeof AbortSignal.any === 'function') {
    return {
      signal: AbortSignal.any([userSignal, idleSignal]),
      dispose: () => {},
    };
  }

  const controller = new AbortController();
  const onAbort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (userSignal.aborted || idleSignal.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }
  userSignal.addEventListener('abort', onAbort);
  idleSignal.addEventListener('abort', onAbort);
  return {
    signal: controller.signal,
    dispose: () => {
      userSignal.removeEventListener('abort', onAbort);
      idleSignal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Owns cancellation and idle-watchdog state for exactly one stream attempt.
 * A retry creates a fresh instance so a timed-out attempt cannot leak state
 * into the next provider call.
 */
export class StreamAttemptController {
  private readonly idleController = new AbortController();
  private readonly mergedAbort: { signal: AbortSignal; dispose: () => void };
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimedOut = false;
  private deliveredOutput = false;
  private toolsInFlight = 0;

  readonly signal: AbortSignal;

  constructor(private readonly options: StreamAttemptControllerOptions) {
    this.mergedAbort = combineAbortSignals(
      options.userAbortSignal,
      this.idleController.signal,
    );
    this.signal = this.mergedAbort.signal;
  }

  get didIdleTimeout(): boolean {
    return this.idleTimedOut;
  }

  get didDeliverOutput(): boolean {
    return this.deliveredOutput;
  }

  get didUserAbort(): boolean {
    return this.options.userAbortSignal?.aborted === true;
  }

  /** Clear then arm the watchdog, unless an active tool owns the quiet period. */
  armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.toolsInFlight > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimedOut = true;
      this.idleController.abort();
    }, this.options.idleTimeoutMs);
  }

  /** Pause idle accounting for one tool. Supports overlapping tool executions. */
  pauseIdleForTool(): void {
    this.toolsInFlight += 1;
    this.clearIdleTimer();
  }

  /** Resume idle accounting once this tool settles. */
  resumeIdleAfterTool(): void {
    this.toolsInFlight = Math.max(0, this.toolsInFlight - 1);
    if (this.toolsInFlight === 0) this.armIdleTimer();
  }

  markDeliveredOutput(): void {
    this.deliveredOutput = true;
  }

  /** Whether this failed attempt is eligible for an idle-timeout retry. */
  canRetryIdle(attemptIndex: number, maxAttempts: number): boolean {
    return this.idleTimedOut &&
      !this.didUserAbort &&
      !this.deliveredOutput &&
      attemptIndex + 1 < maxAttempts;
  }

  /** Release timer/listener resources when this attempt settles. Safe to repeat. */
  dispose(): void {
    this.clearIdleTimer();
    this.mergedAbort.dispose();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
