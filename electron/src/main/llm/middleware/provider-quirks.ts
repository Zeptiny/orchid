/**
 * Tool-output offload constants (shared by tool-dispatch).
 *
 * Formerly also hosted a provider-quirks stream middleware; that path was a
 * no-op identity wrap and was removed from the middleware stack. Empty-choices
 * handling is owned by the AI SDK; mid-stream post-content recovery remains
 * an open residual (see retry middleware for pre-content retries only).
 */
/**
 * Resolve the tool-output inline threshold in characters.
 *
 * Source: `tool_output_inline_threshold` from the live process-wide config
 * (`getConfig()`). Falls back to 20_000 characters when the config is not
 * loaded. Tool handlers with a frozen turn context should prefer the per-turn
 * snapshot via `getToolConfig(ctx)`.
 */
export function getToolOutputInlineThreshold(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require('../../config/loader') as typeof import('../../config/loader');
    return getConfig().tool_output_inline_threshold;
  } catch {
    return 20_000;
  }
}

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
  'wait_for_subagent',
]);
