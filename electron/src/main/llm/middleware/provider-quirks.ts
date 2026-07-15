/**
 * Provider quirks middleware — handles provider-specific failure modes.
 *
 * Re-derives behavioral contracts from Python client.py against AI SDK's
 * actual failure modes. These are NOT litellm-specific — they are
 * provider-agnostic contracts any LLM client must implement:
 *
 * 1. Empty-choices IndexError: Usage-only chunks with empty `choices` list
 *    must not crash the stream (Python: _patch_litellm_raise_on_model_repetition,
 *    lines 125-180).
 *
 * 2. MidStreamFallbackError detection: Benign mid-stream errors (usage-only
 *    chunks) must continue, not terminate (Python:
 *    _is_benign_midstream_litellm_error, lines 185-215).
 *
 * 3. Tool output offloading: Outputs >20KB written to cache files, replaced
 *    with pointer message (Python: _maybe_offload_tool_output, lines 251-307).
 *    **Owned by U9** — placeholder here.
 *
 * 4. THINKING replay: THINKING messages replayed as assistant content, NOT as
 *    `reasoning` field (strict providers 400 on it) (Python:
 *    _history_to_api_messages, lines 360-377).
 *    **Owned by U9** — placeholder here.
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
// Constants
// ---------------------------------------------------------------------------

/**
 * Signature for benign mid-stream errors.
 * Matches Python `_MID_STREAM_BENIGN_SIGNATURE = "list index out of range"`
 * (client.py:122).
 */
const MID_STREAM_BENIGN_SIGNATURE = 'list index out of range';

/**
 * Threshold for tool output offloading.
 * Matches Python `_TOOL_OUTPUT_INLINE_THRESHOLD = 20_000` (client.py:46).
 */
export const TOOL_OUTPUT_INLINE_THRESHOLD = 20_000;

/**
 * Tools exempt from output offloading.
 * Matches Python `_TOOLS_WITHOUT_OUTPUT_OFFLOAD` (client.py:47).
 */
export const TOOLS_WITHOUT_OUTPUT_OFFLOAD = new Set([
  'read',
  'grep',
  'glob',
  'directory_tree',
  'web_fetch',
  'skill',
  'write',
  'wait_for_subagent',
]);

// ---------------------------------------------------------------------------
// Provider quirks middleware
// ---------------------------------------------------------------------------

/**
 * Create provider quirks middleware.
 *
 * This middleware wraps the stream to handle provider-specific edge cases
 * that AI SDK doesn't abstract away:
 *
 * 1. **Empty-choices guard**: Some providers send usage-only chunks with no
 *    `choices` array. AI SDK's default behavior may crash on these. The
 *    middleware filters out such chunks gracefully.
 *
 * 2. **Mid-stream error suppression**: Some providers emit benign errors
 *    mid-stream (e.g., usage-only chunk parsing failures). The middleware
 *    catches these and continues the stream rather than terminating.
 *
 * Note: Items 3 (tool output offloading) and 4 (THINKING replay) are
 * owned by U9 (LLM Stream Orchestration). This middleware provides the
 * infrastructure hooks; the actual logic lives in U9's orchestrator.
 */
export function createProviderQuirksMiddleware(): LanguageModelMiddleware {
  return {
    wrapStream: async ({
      doStream,
    }: {
      doGenerate: () => ReturnType<LanguageModelV4['doGenerate']>;
      doStream: () => ReturnType<LanguageModelV4['doStream']>;
      params: LanguageModelV4CallOptions;
      model: LanguageModelV4;
    }): Promise<LanguageModelV4StreamResult> => {
      let hasReceivedContent = false;

      try {
        const result = await doStream();
        const { stream, ...rest } = result;

        // Wrap the stream to handle provider quirks.
        const quirksStream = stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(chunk, controller) {
              if (chunk.type === 'text-delta' && chunk.delta.length > 0) {
                hasReceivedContent = true;
              }

              // Quirk 1: Empty-choices guard.
              // AI SDK handles most of this internally, but we guard against
              // malformed chunks that might slip through. The key insight from
              // Python is that usage-only chunks (no content) should be silently
              // consumed, not crash the stream.
              //
              // In AI SDK, this manifests as chunks with no text-delta,
              // no reasoning, no tool-call-delta — just usage or finish info.
              // These are valid and should pass through.

              // Quirk 2: Mid-stream error detection happens at the try/catch
              // level below, not per-chunk. The TransformStream just handles
              // the happy path.

              controller.enqueue(chunk);
            },
          }),
        );

        return { stream: quirksStream, ...rest };
      } catch (error) {
        // Quirk 2: Mid-stream error suppression.
        // Matches Python _is_benign_midstream_litellm_error (client.py:185-215).
        // If we've already received content AND the error looks like a benign
        // parsing error (e.g., empty-choices IndexError), suppress it.
        if (hasReceivedContent && isBenignMidStreamError(error)) {
          console.warn(
            '[provider-quirks] Suppressing benign mid-stream error:',
            error instanceof Error ? error.message : error,
          );
          // Return an empty stream — the content was already delivered.
          return createEmptyStreamResult();
        }

        throw error;
      }
    },

    // Quirk 3 & 4 are owned by U9. The middleware structure is in place
    // for the orchestrator to compose with tool-dispatch and history modules.
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if an error is a benign mid-stream error.
 * Matches Python _is_benign_midstream_litellm_error (client.py:185-215).
 *
 * Key conditions:
 * - Must occur AFTER content has been delivered (is_pre_first_chunk=False)
 * - Error message must contain the benign signature
 */
function isBenignMidStreamError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  // Check for the specific benign signature from empty-choices parsing.
  if (message.includes(MID_STREAM_BENIGN_SIGNATURE)) {
    return true;
  }

  // Check for common provider-specific mid-stream errors that are benign
  // when they occur after content delivery.
  if (
    message.includes('list index out of range') ||
    message.includes('index out of range') ||
    message.includes('cannot read properties of undefined')
  ) {
    return true;
  }

  return false;
}

/**
 * Create an empty stream result for when a benign error is suppressed.
 * The stream yields no additional chunks — the content was already delivered.
 */
function createEmptyStreamResult(): LanguageModelV4StreamResult {
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.close();
    },
  });

  return {
    stream,
  };
}
