/**
 * Error classification primitives used by provider resolution and retry.
 */

// ---------------------------------------------------------------------------
// Error class for provider resolution
// ---------------------------------------------------------------------------

/**
 * Custom error for provider resolution failures.
 */
export class ProviderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderResolutionError';
  }
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

/** HTTP status codes that qualify as transient (worth retrying). */
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Check if an error is transient (worth retrying).
 *
 * - HTTP status codes 408, 429, 500, 502, 503, 504
 * - Message-based detection for native errors
 */
export function isTransientError(error: unknown): boolean {
  // Status code on error object
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (typeof statusCode === 'number' && TRANSIENT_STATUS_CODES.has(statusCode)) {
    return true;
  }

  // Message-based detection for native Error objects
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504')
    ) {
      return true;
    }
  }

  return false;
}
