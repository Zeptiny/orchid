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
 * Normalize an unknown error into a single string for keyword classification.
 *
 * Handles raw strings, `Error` instances, and plain objects. For `Error`
 * instances the provider diagnostics AI SDK provider errors carry are appended
 * alongside `name`/`message`: `responseBody` (the raw HTTP body string), `data`
 * (the parsed JSON payload), and the recursively normalized `cause` chain.
 * Providers put their overflow text in those fields while the Error message
 * itself is often a generic "API call failed", so the diagnostics must reach
 * the classifier or context-overflow errors go undetected. Recursion into
 * `cause` is depth-capped and never self-referential.
 */
export function extractErrorMessage(error: unknown, depth = 0): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    const parts: string[] = [`${error.name} ${error.message}`];
    const carrier = error as Error & { responseBody?: unknown; data?: unknown };
    // Raw provider HTTP body (AI SDK APICallError.responseBody).
    if (typeof carrier.responseBody === 'string' && carrier.responseBody.length > 0) {
      parts.push(carrier.responseBody);
    }
    // Parsed JSON payload (AI SDK APICallError.data) — skipped when it cannot
    // be serialized (circular, bigint) or stringifies to nothing.
    if (carrier.data !== undefined) {
      try {
        const json = JSON.stringify(carrier.data);
        if (typeof json === 'string' && json.length > 0) parts.push(json);
      } catch {
        // Unserializable payloads are simply not classifiable text.
      }
    }
    // Normalized cause chain — bounded depth, never the error itself.
    const cause = (error as { cause?: unknown }).cause;
    if (depth < 3 && cause !== undefined && cause !== error) {
      const causeText = extractErrorMessage(cause, depth + 1);
      if (causeText.length > 0) parts.push(causeText);
    }
    return parts.join(' ');
  }
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
}

/**
 * Whether an error indicates the request exceeded the model's context window.
 *
 * Covers provider error codes (`context_length_exceeded`), OpenAI-style
 * `"maximum context length"` messages, and generic `"input too long"` /
 * `"context window"` overflow phrasing. Used to trigger one
 * compaction-and-retry before declaring the turn failed. Provider diagnostics
 * (`responseBody` / `data` / `cause`) must reach the classifier because
 * providers put overflow text there (see {@link extractErrorMessage}).
 */
export function isContextLengthExceededError(error: unknown): boolean {
  const raw = extractErrorMessage(error);
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
