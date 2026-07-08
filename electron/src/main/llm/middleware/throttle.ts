/**
 * Throttle middleware — rate-limits thinking-content yields.
 *
 * Replicates Python `_YIELD_THROTTLE = 0.1` (client.py:43).
 * Ensures a minimum interval between consecutive thinking-content yields
 * to prevent flooding the UI with rapid updates.
 *
 * Uses AI SDK's `LanguageModelV1Middleware` interface.
 */
import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1Middleware,
  LanguageModelV1StreamPart,
} from 'ai';

// ---------------------------------------------------------------------------
// Constants — match Python client.py:43
// ---------------------------------------------------------------------------

/** Minimum interval between thinking-content yields in milliseconds. */
const YIELD_THROTTLE_MS = 100;

// ---------------------------------------------------------------------------
// Throttle middleware
// ---------------------------------------------------------------------------

export interface ThrottleMiddlewareOptions {
  /** Minimum interval between thinking yields in ms. Defaults to 100. */
  intervalMs?: number;
}

/**
 * Create throttle middleware for thinking-content yields.
 *
 * Replicates the Python `_YIELD_THROTTLE` behavior:
 * - Thinking deltas are buffered and only yielded at the throttle interval
 * - Content (non-thinking) deltas pass through immediately
 * - On flush, the accumulated thinking content is yielded as a single chunk
 *
 * This prevents the UI from being flooded with rapid thinking updates
 * while still ensuring content flows as fast as possible.
 */
export function createThrottleMiddleware(
  options: ThrottleMiddlewareOptions = {},
): LanguageModelV1Middleware {
  const intervalMs = options.intervalMs ?? YIELD_THROTTLE_MS;

  return {
    wrapStream: async ({
      doStream,
    }: {
      doGenerate: () => ReturnType<LanguageModelV1['doGenerate']>;
      doStream: () => ReturnType<LanguageModelV1['doStream']>;
      params: LanguageModelV1CallOptions;
      model: LanguageModelV1;
    }): Promise<Awaited<ReturnType<LanguageModelV1['doStream']>>> => {
      const result = await doStream();
      const { stream, ...rest } = result;

      let lastThinkingYield = 0;
      let pendingThinkingDelta = '';
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const throttledStream = stream.pipeThrough(
        new TransformStream<LanguageModelV1StreamPart, LanguageModelV1StreamPart>({
          transform(chunk, controller) {
            // Only throttle reasoning/thinking chunks.
            // Content and other chunks pass through immediately.
            if (chunk.type === 'reasoning' && chunk.textDelta.length > 0) {
              const now = Date.now();
              const elapsed = now - lastThinkingYield;

              if (elapsed >= intervalMs) {
                // Enough time has passed — yield immediately.
                lastThinkingYield = now;
                controller.enqueue(chunk);
              } else {
                // Buffer the thinking delta and schedule a flush.
                pendingThinkingDelta += chunk.textDelta;
                if (flushTimer === null) {
                  const remaining = intervalMs - elapsed;
                  flushTimer = setTimeout(() => {
                    flushTimer = null;
                    if (pendingThinkingDelta.length > 0) {
                      lastThinkingYield = Date.now();
                      controller.enqueue({
                        type: 'reasoning',
                        textDelta: pendingThinkingDelta,
                      } as LanguageModelV1StreamPart);
                      pendingThinkingDelta = '';
                    }
                  }, remaining);
                }
              }
            } else {
              // Non-reasoning chunks pass through immediately.
              // If there's pending thinking, flush it first so ordering
              // is preserved (thinking before content).
              if (pendingThinkingDelta.length > 0) {
                if (flushTimer !== null) {
                  clearTimeout(flushTimer);
                  flushTimer = null;
                }
                lastThinkingYield = Date.now();
                controller.enqueue({
                  type: 'reasoning',
                  textDelta: pendingThinkingDelta,
                } as LanguageModelV1StreamPart);
                pendingThinkingDelta = '';
              }
              controller.enqueue(chunk);
            }
          },

          flush(controller) {
            // Flush any remaining buffered thinking on stream end.
            if (pendingThinkingDelta.length > 0) {
              if (flushTimer !== null) {
                clearTimeout(flushTimer);
                flushTimer = null;
              }
              controller.enqueue({
                type: 'reasoning',
                textDelta: pendingThinkingDelta,
              } as LanguageModelV1StreamPart);
              pendingThinkingDelta = '';
            }
          },
        }),
      );

      return { stream: throttledStream, ...rest };
    },
  };
}
