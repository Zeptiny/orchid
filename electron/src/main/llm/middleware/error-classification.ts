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

// ---------------------------------------------------------------------------
// Context-window overflow detection (R15)
// ---------------------------------------------------------------------------

/**
 * Whether an error indicates the request exceeded the model's context window.
 *
 * Covers provider error codes (`context_length_exceeded`), OpenAI-style
 * `"maximum context length"` messages, and generic `"input too long"` /
 * `"context window"` overflow phrasing. Used to trigger one
 * compaction-and-retry before declaring the turn failed.
 */
export function isContextLengthExceededError(error: unknown): boolean {
  const raw = (() => {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return `${error.name} ${error.message}`;
    if (error && typeof error === 'object') {
      const maybe = error as { message?: unknown; detail?: unknown; title?: unknown; error?: unknown; code?: unknown };
      const parts: string[] = [];
      if (typeof maybe.message === 'string') parts.push(maybe.message);
      if (typeof maybe.detail === 'string') parts.push(maybe.detail);
      if (typeof maybe.title === 'string') parts.push(maybe.title);
      if (typeof maybe.error === 'string') parts.push(maybe.error);
      if (typeof maybe.code === 'string') parts.push(maybe.code);
      if (parts.length > 0) {
        try { parts.push(JSON.stringify(error)); } catch { parts.push(String(error)); }
        return parts.join(' ');
      }
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }
    return String(error ?? '');
  })();
  const haystack = raw.toLowerCase();
  if (haystack.includes('context_length_exceeded')) return true;
  if (haystack.includes('context length')) return true;
  if (haystack.includes('maximum context')) return true;
  if (haystack.includes('context window')) return true;
  if (haystack.includes('token limit') && haystack.includes('exceeded')) return true;
  if (haystack.includes('input is too long') || haystack.includes('input too long')) return true;
  if (haystack.includes('prompt is too long') || haystack.includes('request too large')) return true;
  return false;
}

/** Haystack variant for already-joined title+detail strings. */
export function isContextLengthExceededMessage(haystack: string | null | undefined): boolean {
  if (!haystack) return false;
  return isContextLengthExceededError(haystack);
}
