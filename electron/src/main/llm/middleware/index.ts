/**
 * Middleware layer — public API and composition helper.
 *
 * Exports all middleware and provides `createMiddlewareStack()` to compose
 * them into an ordered array for `wrapLanguageModel({ model, middleware })`.
 *
 * Middleware order (outermost first):
 * 1. Retry — catches transient errors, retries with backoff
 * 2. Throttle — rate-limits thinking-content yields
 *
 * (Optional) Attempt accounting sits between retry and throttle when a
 * ledger context is provided.
 *
 * Provider-specific empty-choices handling is owned by the AI SDK. Tool
 * output offload thresholds live in `provider-quirks.ts` (constants only).
 */
import type { LanguageModelMiddleware } from 'ai';
import { createRetryMiddleware, type RetryMiddlewareOptions } from './retry';
import { createThrottleMiddleware, type ThrottleMiddlewareOptions } from './throttle';
import {
  createAttemptAccountingMiddleware,
  type ProviderAttemptAccountingContext,
} from '../../providers/accounting/middleware';

// Re-export individual middleware
export { createRetryMiddleware, type RetryMiddlewareOptions } from './retry';
export { createThrottleMiddleware, type ThrottleMiddlewareOptions } from './throttle';
export { isTransientError } from './error-classification';
export {
  getToolOutputInlineThreshold,
  TOOLS_WITHOUT_OUTPUT_OFFLOAD,
} from './provider-quirks';
export {
  createAttemptAccountingMiddleware,
  type ProviderAttemptAccountingContext,
} from '../../providers/accounting/middleware';

// Re-export error classes for use by other modules
export {
  ProviderResolutionError,
} from './error-classification';

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface MiddlewareStackOptions {
  /** Retry middleware options. */
  retry?: RetryMiddlewareOptions;
  /** Throttle middleware options. */
  throttle?: ThrottleMiddlewareOptions;
  /** Frozen ledger context; omitted only for local/non-provider test streams. */
  accounting?: ProviderAttemptAccountingContext;
}

/**
 * Create a composed middleware stack for LLM streaming.
 *
 * Returns an ordered array of middleware suitable for:
 * ```ts
 * wrapLanguageModel({ model, middleware: createMiddlewareStack(config) })
 * ```
 *
 * @param options - Optional configuration for individual middleware
 * @returns Ordered array of LanguageModelV1Middleware
 */
export function createMiddlewareStack(
  options: MiddlewareStackOptions = {},
): LanguageModelMiddleware[] {
  return [
    // 1. Retry (outermost) — catches transient errors before they propagate
    createRetryMiddleware(options.retry),

    // Insert a durable pending row for every inner retry/tool-loop call.
    ...(options.accounting ? [createAttemptAccountingMiddleware(options.accounting)] : []),

    // 2. Throttle — rate-limits thinking yields
    createThrottleMiddleware(options.throttle),
  ];
}
