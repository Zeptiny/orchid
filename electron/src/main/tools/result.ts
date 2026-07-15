/**
 * Normalize tool handler return values into content + explicit isError.
 *
 * Handlers may return:
 * - string → success content, isError false
 * - { content, display?, isError? / is_error? } → structured result
 *
 * Failure is never inferred from content text. Handlers (or the dispatch
 * layer for throws/timeouts) must set isError explicitly.
 */

/** Normalized content + explicit error flag returned to LLM/orchestrator. */
export interface NormalizedToolResult {
  content: string;
  isError: boolean;
}

/**
 * Coerce a tool handler return value into a content string + isError flag.
 * Preserves `{ display, content }` as JSON for UI summary parsing.
 */
export function normalizeToolHandlerResult(result: unknown): NormalizedToolResult {
  if (typeof result === 'string') {
    return { content: result, isError: false };
  }

  if (result != null && typeof result === 'object' && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    const isError = obj.isError === true || obj.is_error === true;

    if (typeof obj.content === 'string') {
      if (typeof obj.display === 'string') {
        // Keep display+content JSON for ToolCallBlock / parseToolPayload.
        return {
          content: JSON.stringify({ display: obj.display, content: obj.content }),
          isError,
        };
      }
      return { content: obj.content, isError };
    }
  }

  try {
    return { content: JSON.stringify(result), isError: false };
  } catch {
    return { content: String(result), isError: false };
  }
}

/**
 * Parse the object returned by AI SDK tool `execute` (or equivalent).
 * Expects `{ content, isError }` when structured; plain strings are success.
 */
export function parseToolExecuteOutput(raw: unknown): NormalizedToolResult {
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.content === 'string' && ('isError' in obj || 'is_error' in obj)) {
      return {
        content: obj.content,
        isError: obj.isError === true || obj.is_error === true,
      };
    }
  }
  if (typeof raw === 'string') {
    return { content: raw, isError: false };
  }
  if (raw == null) {
    return { content: '', isError: false };
  }
  try {
    return { content: JSON.stringify(raw), isError: false };
  } catch {
    return { content: String(raw), isError: false };
  }
}
