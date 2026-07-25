/**
 * Throttle middleware — rate-limits thinking-content yields.
 *
 * Replicates Python `_YIELD_THROTTLE = 0.1` (client.py:43).
 * Ensures a minimum interval between consecutive thinking-content yields
 * to prevent flooding the UI with rapid updates.
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
): LanguageModelMiddleware {
  const intervalMs = options.intervalMs ?? YIELD_THROTTLE_MS;

  return {
    wrapStream: async ({
      doStream,
    }: {
      doGenerate: () => ReturnType<LanguageModelV4['doGenerate']>;
      doStream: () => ReturnType<LanguageModelV4['doStream']>;
      params: LanguageModelV4CallOptions;
      model: LanguageModelV4;
    }): Promise<LanguageModelV4StreamResult> => {
      const result = await doStream();
      const { stream, ...rest } = result;

      let lastThinkingYield = 0;
      let pendingThinkingDelta = '';
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;

      const clearFlushTimer = (): void => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
      };

      const transformer: Transformer<LanguageModelV4StreamPart, LanguageModelV4StreamPart> & {
        cancel?: () => void;
      } = {
        transform(chunk, controller) {
          if (closed) return;

          if (chunk.type === 'reasoning-delta' && chunk.delta.length > 0) {
            const now = Date.now();
            const elapsed = now - lastThinkingYield;

            if (elapsed >= intervalMs) {
              lastThinkingYield = now;
              controller.enqueue(chunk);
            } else {
              pendingThinkingDelta += chunk.delta;
              if (flushTimer === null) {
                const remaining = intervalMs - elapsed;
                flushTimer = setTimeout(() => {
                  flushTimer = null;
                  if (closed || pendingThinkingDelta.length === 0) return;
                  lastThinkingYield = Date.now();
                  controller.enqueue({
                    type: 'reasoning-delta',
                    id: 'reasoning-0',
                    delta: pendingThinkingDelta,
                  } as LanguageModelV4StreamPart);
                  pendingThinkingDelta = '';
                }, remaining);
              }
            }
          } else {
            if (pendingThinkingDelta.length > 0) {
              clearFlushTimer();
              lastThinkingYield = Date.now();
              controller.enqueue({
                type: 'reasoning-delta',
                id: 'reasoning-0',
                delta: pendingThinkingDelta,
              } as LanguageModelV4StreamPart);
              pendingThinkingDelta = '';
            }
            controller.enqueue(chunk);
          }
        },

        flush(controller) {
          clearFlushTimer();
          if (!closed && pendingThinkingDelta.length > 0) {
            controller.enqueue({
              type: 'reasoning-delta',
              id: 'reasoning-0',
              delta: pendingThinkingDelta,
            } as LanguageModelV4StreamPart);
            pendingThinkingDelta = '';
          }
          closed = true;
        },

        cancel() {
          closed = true;
          clearFlushTimer();
          pendingThinkingDelta = '';
        },
      };

      const throttledStream = stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>(transformer),
      );

      return { stream: throttledStream, ...rest };
    },
  };
}
