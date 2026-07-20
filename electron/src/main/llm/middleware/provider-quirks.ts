/**
 * Tool-output offload constants (shared by tool-dispatch).
 *
 * Formerly also hosted a provider-quirks stream middleware; that path was a
 * no-op identity wrap and was removed from the middleware stack. Empty-choices
 * handling is owned by the AI SDK; mid-stream post-content recovery remains
 * an open residual (see retry middleware for pre-content retries only).
 */

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
