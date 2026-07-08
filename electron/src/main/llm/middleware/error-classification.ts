/**
 * Error classification — maps exceptions to user-facing (title, detail) tuples.
 *
 * Replicates all 13 branches from Python `classify_error()` (client.py:59-89).
 * Each branch maps a specific error type/condition to a human-readable
 * (title, detail) pair suitable for display in the UI.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ERROR_DETAIL_MAX_LEN = 200;

// ---------------------------------------------------------------------------
// Error classes for classification
// ---------------------------------------------------------------------------

/**
 * Custom error for provider resolution failures.
 * Maps to Python's `ProviderResolutionError` (providers.py:51).
 */
export class ProviderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderResolutionError';
  }
}

/**
 * Base class for AI SDK / provider API errors.
 * Carries optional `statusCode` for HTTP-level classification.
 */
export class APIError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
  }
}

export class AuthenticationError extends APIError {
  constructor(message = 'Invalid or missing API key') {
    super(message, 401);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends APIError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 429);
    this.name = 'RateLimitError';
  }
}

export class TimeoutError extends APIError {
  constructor(message = 'Request timed out') {
    super(message, 408);
    this.name = 'TimeoutError';
  }
}

export class APIConnectionError extends APIError {
  constructor(message = 'Connection failed') {
    super(message);
    this.name = 'APIConnectionError';
  }
}

export class BadRequestError extends APIError {
  constructor(message = 'Bad request') {
    super(message, 400);
    this.name = 'BadRequestError';
  }
}

export class InternalServerError extends APIError {
  constructor(message = 'Internal server error') {
    super(message, 500);
    this.name = 'InternalServerError';
  }
}

export class ServiceUnavailableError extends APIError {
  constructor(message = 'Service unavailable') {
    super(message, 503);
    this.name = 'ServiceUnavailableError';
  }
}

export class BadGatewayError extends APIError {
  constructor(message = 'Bad gateway') {
    super(message, 502);
    this.name = 'BadGatewayError';
  }
}

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

export interface ClassifiedError {
  title: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// classifyError — 13 branches matching Python client.py:59-89
// ---------------------------------------------------------------------------

/**
 * Map an exception to a user-facing (title, detail) pair.
 *
 * Branches (matching Python exactly):
 * 1.  ProviderResolutionError → "Unknown Provider"
 * 2.  AuthenticationError    → "Authentication Failed"
 * 3.  RateLimitError         → "Rate Limit Exceeded"
 * 4.  TimeoutError           → "Request Timed Out"
 * 5.  APIConnectionError     → "Connection Failed"
 * 6.  BadRequestError        → "Invalid Request"
 * 7.  InternalServerError    → "Server Error"
 * 8.  ServiceUnavailableError→ "Service Unavailable"
 * 9.  BadGatewayError        → "Bad Gateway"
 * 10. APIError (generic)     → "API Error"
 * 11. Timeout-like (message)  → "Request Timed Out"
 * 12. HTTP error (message)    → "HTTP Error"
 * 13. Fallback               → "Unexpected Error"
 */
export function classifyError(exc: unknown): ClassifiedError {
  const detail = truncateDetail(
    exc instanceof Error ? exc.message : String(exc),
  );
  const fallbackDetail = detail || (exc instanceof Error ? exc.name : typeof exc);

  // Branch 1: ProviderResolutionError
  if (exc instanceof ProviderResolutionError) {
    return {
      title: 'Unknown Provider',
      detail:
        detail ||
        'The model reference could not be resolved. Check your providers config.',
    };
  }

  // Branch 2: AuthenticationError
  if (exc instanceof AuthenticationError) {
    return {
      title: 'Authentication Failed',
      detail: 'Invalid or missing API key. Check your configuration.',
    };
  }

  // Branch 3: RateLimitError
  if (exc instanceof RateLimitError) {
    return {
      title: 'Rate Limit Exceeded',
      detail: 'Too many requests. Please wait and try again.',
    };
  }

  // Branch 4: TimeoutError
  if (exc instanceof TimeoutError) {
    return {
      title: 'Request Timed Out',
      detail: 'The API did not respond in time. Try again later.',
    };
  }

  // Branch 5: APIConnectionError
  if (exc instanceof APIConnectionError) {
    return {
      title: 'Connection Failed',
      detail:
        'Could not reach the API server. Check your network and base_url.',
    };
  }

  // Branch 6: BadRequestError
  if (exc instanceof BadRequestError) {
    return {
      title: 'Invalid Request',
      detail: detail || 'The request was rejected by the API.',
    };
  }

  // Branch 7: InternalServerError
  if (exc instanceof InternalServerError) {
    return {
      title: 'Server Error',
      detail: detail || 'The API server encountered an internal error.',
    };
  }

  // Branch 8: ServiceUnavailableError
  if (exc instanceof ServiceUnavailableError) {
    return {
      title: 'Service Unavailable',
      detail: detail || 'The API service is temporarily unavailable.',
    };
  }

  // Branch 9: BadGatewayError
  if (exc instanceof BadGatewayError) {
    return {
      title: 'Bad Gateway',
      detail: detail || 'The API server returned a bad gateway error.',
    };
  }

  // Branch 10: Generic APIError
  if (exc instanceof APIError) {
    return {
      title: 'API Error',
      detail: detail || 'The API returned an error.',
    };
  }

  // Branch 11: Timeout-like errors (message-based detection for native errors)
  if (exc instanceof Error && isTimeoutLikeMessage(exc.message)) {
    return {
      title: 'Request Timed Out',
      detail: 'The API did not respond in time. Try again later.',
    };
  }

  // Branch 12: HTTP errors (message-based detection)
  if (exc instanceof Error && isHttpErrorMessage(exc.message)) {
    return {
      title: 'HTTP Error',
      detail: detail || 'An HTTP error occurred.',
    };
  }

  // Branch 13: Fallback
  return {
    title: 'Unexpected Error',
    detail: fallbackDetail,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateDetail(s: string): string {
  return s.length > ERROR_DETAIL_MAX_LEN ? s.slice(0, ERROR_DETAIL_MAX_LEN) : s;
}

function isTimeoutLikeMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout')
  );
}

function isHttpErrorMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('http error') ||
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound')
  );
}

// ---------------------------------------------------------------------------
// Transient error detection — mirrors Python _is_transient_error (client.py:99-119)
// ---------------------------------------------------------------------------

/** HTTP status codes that qualify as transient (worth retrying). */
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Check if an error is transient (worth retrying).
 *
 * Matches Python `_is_transient_error` exactly:
 * - Known transient error classes (rate limit, timeout, connection, server)
 * - HTTP status codes 408, 429, 500, 502, 503, 504
 * - Message-based detection for native errors
 */
export function isTransientError(error: unknown): boolean {
  // Class-based detection
  if (
    error instanceof RateLimitError ||
    error instanceof TimeoutError ||
    error instanceof APIConnectionError ||
    error instanceof InternalServerError ||
    error instanceof ServiceUnavailableError ||
    error instanceof BadGatewayError
  ) {
    return true;
  }

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
