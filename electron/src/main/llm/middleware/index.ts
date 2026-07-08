/**
 * Middleware layer — public API and composition helper.
 *
 * Exports all middleware and provides `createMiddlewareStack()` to compose
 * them into an ordered array for `wrapLanguageModel({ model, middleware })`.
 *
 * Middleware order (outermost first):
 * 1. Retry — catches transient errors, retries with backoff
 * 2. Provider quirks — handles provider-specific edge cases
 * 3. Throttle — rate-limits thinking-content yields
 *
 * This matches the Python behavior where retry wraps the outermost layer,
 * provider-specific handling is in the middle, and yield throttling is
 * closest to the stream consumer.
 */
import type { LanguageModelMiddleware } from 'ai';
import { createRetryMiddleware, type RetryMiddlewareOptions } from './retry';
import { createThrottleMiddleware, type ThrottleMiddlewareOptions } from './throttle';
import { createProviderQuirksMiddleware } from './provider-quirks';

// Re-export individual middleware
export { createRetryMiddleware, type RetryMiddlewareOptions } from './retry';
export { createThrottleMiddleware, type ThrottleMiddlewareOptions } from './throttle';
export { classifyError, isTransientError, type ClassifiedError } from './error-classification';
export {
  createProviderQuirksMiddleware,
  shouldOffloadToolOutput,
  TOOL_OUTPUT_INLINE_THRESHOLD,
  TOOLS_WITHOUT_OUTPUT_OFFLOAD,
} from './provider-quirks';

// Re-export error classes for use by other modules
export {
  ProviderResolutionError,
  APIError,
  AuthenticationError,
  RateLimitError,
  TimeoutError,
  APIConnectionError,
  BadRequestError,
  InternalServerError,
  ServiceUnavailableError,
  BadGatewayError,
} from './error-classification';

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface MiddlewareStackOptions {
  /** Retry middleware options. */
  retry?: RetryMiddlewareOptions;
  /** Throttle middleware options. */
  throttle?: ThrottleMiddlewareOptions;
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

    // 2. Provider quirks — handles empty-choices, mid-stream errors
    createProviderQuirksMiddleware(),

    // 3. Throttle — rate-limits thinking yields
    createThrottleMiddleware(options.throttle),
  ];
}
