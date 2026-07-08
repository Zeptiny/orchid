/**
 * Retry middleware — exponential backoff with jitter and content-delivered guard.
 *
 * Replicates Python client.py:478-591, 1146-1171:
 * - Backoff formula: 0.2 * 2^attempt + uniform(0, 0.2)
 * - Max retries from config (default 3)
 * - Critical guard: "no retry after content delivered" — once any token
 *   has been streamed to the user, retries are suppressed
 *
 * Uses AI SDK's `LanguageModelV1Middleware` interface.
 */
import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1Middleware,
  LanguageModelV1StreamPart,
} from 'ai';
import { isTransientError } from './error-classification';

// ---------------------------------------------------------------------------
// Constants — match Python client.py:43, 478
// ---------------------------------------------------------------------------

const BACKOFF_BASE = 0.2;
const MAX_DELAY_SECONDS = 30;
const DEFAULT_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with jitter.
 * Matches Python: delay = 0.2 * (2 ** attempt), jitter = uniform(0, 0.2)
 */
function backoffDelayMs(attempt: number): number {
  const exponential = BACKOFF_BASE * Math.pow(2, attempt);
  const jitter = Math.random() * BACKOFF_BASE;
  return Math.min(exponential + jitter, MAX_DELAY_SECONDS) * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Retry middleware
// ---------------------------------------------------------------------------

export interface RetryMiddlewareOptions {
  /** Maximum number of retry attempts. Defaults to 3. */
  maxRetries?: number;
}

/**
 * Create retry middleware with exponential backoff and content-delivered guard.
 *
 * Behavioral contract from Python client.py:1146-1171:
 * > "No retry after content delivered" — once any token has been streamed
 * > to the user, retries are suppressed. This prevents re-playing already
 * > visible content.
 *
 * The middleware wraps the stream with a TransformStream that tracks
 * whether any `text-delta` chunk has been emitted. If a transient error
 * occurs BEFORE any content, it retries with backoff. If content has
 * already been delivered, the error propagates immediately.
 */
export function createRetryMiddleware(
  options: RetryMiddlewareOptions = {},
): LanguageModelV1Middleware {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  return {
    wrapStream: async ({
      doStream,
    }: {
      doGenerate: () => ReturnType<LanguageModelV1['doGenerate']>;
      doStream: () => ReturnType<LanguageModelV1['doStream']>;
      params: LanguageModelV1CallOptions;
      model: LanguageModelV1;
    }): Promise<Awaited<ReturnType<LanguageModelV1['doStream']>>> => {
      let attempt = 0;
      let contentDelivered = false;

      while (true) {
        try {
          const result = await doStream();
          const { stream, ...rest } = result;

          // Wrap the stream to track whether content has been delivered.
          // This is the critical guard: once any text-delta is emitted,
          // contentDelivered = true and retries are suppressed.
          const trackedStream = stream.pipeThrough(
            new TransformStream<LanguageModelV1StreamPart, LanguageModelV1StreamPart>({
              transform(chunk, controller) {
                if (
                  chunk.type === 'text-delta' &&
                  chunk.textDelta.length > 0
                ) {
                  contentDelivered = true;
                }
                controller.enqueue(chunk);
              },
            }),
          );

          return { stream: trackedStream, ...rest };
        } catch (error) {
          // Critical guard: no retry after content delivered.
          // Matches Python client.py:1146-1171 — if any token was already
          // streamed to the user, we must NOT retry (would re-play content).
          if (contentDelivered) {
            throw error;
          }

          // Only retry transient errors up to maxRetries times.
          if (attempt < maxRetries && isTransientError(error)) {
            const delayMs = backoffDelayMs(attempt);
            console.warn(
              `[retry] Transient error (attempt ${attempt + 1}/${maxRetries}): ${
                error instanceof Error ? error.message : error
              }. Retrying in ${(delayMs / 1000).toFixed(1)}s...`,
            );
            await sleep(delayMs);
            attempt++;
            continue;
          }

          throw error;
        }
      }
    },
  };
}
