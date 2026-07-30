/**
 * Retry middleware — exponential backoff with jitter and content-delivered guard.
 *
 * - Backoff formula: 0.2 * 2^attempt + uniform(0, 0.2)
 * - Max retries from config (default 3)
 * - Critical guard: "no retry after content delivered" — once any token
 *   has been streamed to the user, retries are suppressed
 *
 * Retry coverage:
 * - doStream() setup failures (await throws)
 * - Mid-stream failures that occur BEFORE any user-visible stream part
 *   (text, reasoning, tool calls, etc.) is delivered
 *
 * Residual limitation: once any content-bearing part has been enqueued to the
 * consumer, mid-stream drops are NOT retried (would double-deliver content).
 * Full reconnect-with-continuation is out of scope.
 *
 * Uses AI SDK's `LanguageModelV1Middleware` interface.
 */
import type { LanguageModelMiddleware } from 'ai';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import { isTransientError } from './error-classification';
import { sleep } from '../../utils/async';
import { getConfig } from '../../config/loader';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function backoffDelayMs(attempt: number): number {
  let base: number;
  let maxDelay: number;
  try {
    const cfg = getConfig();
    base = cfg.llm_retry_backoff_base;
    maxDelay = cfg.llm_retry_max_delay;
  } catch {
    base = 0.2;
    maxDelay = 30;
  }
  const exponential = base * Math.pow(2, attempt);
  const jitter = Math.random() * base;
  return Math.min(exponential + jitter, maxDelay) * 1000;
}

/** Parts that are safe to re-emit after a pre-content retry (metadata only). */
const NON_CONTENT_STREAM_TYPES = new Set([
  'stream-start',
  'response-metadata',
  'finish',
  'finish-step',
  'start-step',
  'raw',
]);

/**
 * True once the consumer has seen something that must not be replayed.
 * Includes text, reasoning, and tool-call stream parts — not only text-delta.
 */
function isContentChunk(chunk: LanguageModelV4StreamPart): boolean {
  if (NON_CONTENT_STREAM_TYPES.has(chunk.type)) {
    return false;
  }
  if (chunk.type === 'text-delta') {
    return chunk.delta.length > 0;
  }
  if (chunk.type === 'reasoning-delta') {
    return 'delta' in chunk && typeof chunk.delta === 'string' && chunk.delta.length > 0;
  }
  return true;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('Operation aborted');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

async function cancelStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  reason: unknown,
): Promise<void> {
  try {
    await stream.cancel(reason);
  } catch {
    // The provider stream may already be errored or locked.
  }
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
 * "No retry after content delivered" — once any token has been streamed
 * to the user, retries are suppressed. This prevents re-playing already
 * visible content.
 *
 * Retries both doStream() setup failures and mid-stream errors that occur
 * before any content-bearing part is delivered. After content is delivered,
 * errors propagate immediately (no reconnect).
 */
export function createRetryMiddleware(
  options: RetryMiddlewareOptions = {},
): LanguageModelMiddleware {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  return {
    wrapStream: async ({
      doStream,
      params,
    }: {
      doGenerate: () => ReturnType<LanguageModelV4['doGenerate']>;
      doStream: () => ReturnType<LanguageModelV4['doStream']>;
      params: LanguageModelV4CallOptions;
      model: LanguageModelV4;
    }): Promise<LanguageModelV4StreamResult> => {
      const abortSignal = params.abortSignal;
      let attempt = 0;
      let contentDelivered = false;

      const tryDoStream = async (): Promise<LanguageModelV4StreamResult> => {
        while (true) {
          throwIfAborted(abortSignal);
          try {
            const result = await doStream();
            if (abortSignal?.aborted) {
              await cancelStream(result.stream, abortReason(abortSignal));
              throwIfAborted(abortSignal);
            }
            return result;
          } catch (error) {
            throwIfAborted(abortSignal);
            if (contentDelivered) {
              throw error;
            }
            if (attempt < maxRetries && isTransientError(error)) {
              const delayMs = backoffDelayMs(attempt);
              console.warn(
                `[retry] Transient error (attempt ${attempt + 1}/${maxRetries}): ${
                  error instanceof Error ? error.message : error
                }. Retrying in ${(delayMs / 1000).toFixed(1)}s...`,
              );
              await sleep(delayMs, abortSignal);
              throwIfAborted(abortSignal);
              attempt++;
              continue;
            }
            throw error;
          }
        }
      };

      // Obtain first successful setup so we can return stream metadata.
      const first = await tryDoStream();
      const { stream: initialStream, ...rest } = first;
      let activeReader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | null = null;
      const cancelActiveReader = (reason: unknown): void => {
        if (activeReader) {
          void activeReader.cancel(reason).catch(() => {
            // The provider reader may already have failed or been released.
          });
        }
      };

      // Outer stream owns mid-stream pre-content retries: if the inner
      // stream errors before any text-delta, call doStream again (up to
      // maxRetries). After content is delivered, errors propagate.
      const trackedStream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          let currentStream: ReadableStream<LanguageModelV4StreamPart> = initialStream;
          const onAbort = (): void => {
            cancelActiveReader(abortReason(abortSignal));
          };
          abortSignal?.addEventListener('abort', onAbort, { once: true });

          try {
            while (true) {
              throwIfAborted(abortSignal);
              const reader = currentStream.getReader();
              activeReader = reader;
              try {
                while (true) {
                  throwIfAborted(abortSignal);
                  const { done, value } = await reader.read();
                  throwIfAborted(abortSignal);
                  if (done) {
                    controller.close();
                    return;
                  }
                  if (isContentChunk(value)) {
                    contentDelivered = true;
                  }
                  controller.enqueue(value);
                }
              } catch (error) {
                if (abortSignal?.aborted) {
                  controller.error(abortReason(abortSignal));
                  return;
                }
                if (contentDelivered) {
                  controller.error(error);
                  return;
                }

                if (attempt < maxRetries && isTransientError(error)) {
                  const delayMs = backoffDelayMs(attempt);
                  console.warn(
                    `[retry] Transient mid-stream error before content (attempt ${attempt + 1}/${maxRetries}): ${
                      error instanceof Error ? error.message : error
                    }. Retrying in ${(delayMs / 1000).toFixed(1)}s...`,
                  );
                  await sleep(delayMs, abortSignal);
                  throwIfAborted(abortSignal);
                  attempt++;
                  try {
                    const next = await tryDoStream();
                    throwIfAborted(abortSignal);
                    currentStream = next.stream;
                    continue;
                  } catch (setupError) {
                    controller.error(setupError);
                    return;
                  }
                }

                controller.error(error);
                return;
              } finally {
                if (activeReader === reader) {
                  activeReader = null;
                }
                try {
                  reader.releaseLock();
                } catch {
                  // Reader may already be released if the stream errored.
                }
              }
            }
          } catch (error) {
            controller.error(error);
          } finally {
            abortSignal?.removeEventListener('abort', onAbort);
          }
        },
        cancel(reason) {
          cancelActiveReader(reason);
        },
      });

      return { stream: trackedStream, ...rest };
    },
  };
}
