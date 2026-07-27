/**
 * Shared async helpers for the main process.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface WithTimeoutOptions {
  /** Aborted when the timeout fires (or immediately for invalid/non-positive ms). */
  abortController?: AbortController;
  /** Factory for the rejection error. Defaults to `new Error(message)`. */
  createError?: (message: string) => Error;
}

// ── Sleep ────────────────────────────────────────────────────────────────────

/** Resolve after `ms` milliseconds, or reject when the optional signal aborts. */
export function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? new Error('Operation aborted'));
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      reject(abortSignal?.reason ?? new Error('Operation aborted'));
    };

    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── Timeout ──────────────────────────────────────────────────────────────────

/**
 * Race an already-started promise against a timeout.
 *
 * Rejects with `createError(message)` if the timeout fires first (or if `ms`
 * is non-finite / <= 0). Clears the timer on settle and swallows late
 * rejections/resolutions from the work promise after timeout (or after an
 * immediate invalid-ms reject) so they do not surface as unhandled rejections.
 */
export function withTimeoutPromise<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  options: WithTimeoutOptions = {},
): Promise<T> {
  const createError = options.createError ?? ((m: string) => new Error(m));
  const abortController = options.abortController;

  if (!Number.isFinite(ms) || ms <= 0) {
    abortController?.abort();
    promise.then(
      () => undefined,
      () => undefined,
    );
    return Promise.reject(createError(message));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      abortController?.abort();
      reject(createError(message));
    }, ms);
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }
  });

  return Promise.race([
    promise.then(
      (value) => {
        if (timer !== undefined) clearTimeout(timer);
        return value;
      },
      (err: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
        throw err;
      },
    ),
    timeoutPromise,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      promise.then(
        () => undefined,
        () => undefined,
      );
    }
  });
}

/**
 * Race a work function against a timeout.
 *
 * Does not invoke `work` when `ms` is non-finite or <= 0. For already-started
 * promises use {@link withTimeoutPromise} so late settlements are still
 * swallowed on invalid timeouts.
 */
export function withTimeout<T>(
  work: () => Promise<T>,
  ms: number,
  message: string,
  options: WithTimeoutOptions = {},
): Promise<T> {
  const createError = options.createError ?? ((m: string) => new Error(m));

  if (!Number.isFinite(ms) || ms <= 0) {
    options.abortController?.abort();
    return Promise.reject(createError(message));
  }

  return withTimeoutPromise(work(), ms, message, options);
}
