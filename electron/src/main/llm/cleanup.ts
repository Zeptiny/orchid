/**
 * Cleanup utilities for tool_call/tool_result reconciliation.
 *
 * Provides functions to:
 * - Clean up orphaned tool results (TOOL_RESULT with no preceding assistant tool_calls)
 * - Clean up dangling tool calls (assistant tool_calls with no following tool result)
 * - Reconcile chain on restore (used by session restoration)
 *
 * These utilities complement the pairing invariant enforced by `toApiMessages`
 * in `history.ts`. While `toApiMessages` filters at API message conversion time,
 * these functions operate on the persisted Message arrays directly.
 */
import type { Message } from '../../shared/types/message';
import { MessageType, MessageRole } from '../../shared/types/message';

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

/**
 * Prune TOOL_RESULT messages whose tool_call_id has no preceding assistant
 * tool_calls partner in this list.
 *
 * Also drops duplicate TOOL_RESULT messages for the same tool_call_id.
 *
 * Matches Python `_reconcile_orphan_tool_results` and the chain.ts
 * `reconcileOrphanToolResults` function.
 *
 * @param messages - Messages to clean up
 * @returns Messages with orphaned tool results removed
 */
export function cleanOrphanToolResults(messages: Message[]): Message[] {
  if (!messages.length) return messages;

  const seenToolCallIds = new Set<string>();
  const seenResultIds = new Set<string>();
  const keep: Message[] = [];

  for (const msg of messages) {
    if (msg.role === MessageRole.TOOL && msg.tool_call_id) {
      // Drop duplicate TOOL_RESULT for same tool_call_id
      if (seenResultIds.has(msg.tool_call_id)) {
        continue;
      }
      // Drop orphan TOOL_RESULT (no preceding assistant tool_calls)
      if (!seenToolCallIds.has(msg.tool_call_id)) {
        continue;
      }
      seenResultIds.add(msg.tool_call_id);
    }

    // Track tool_call IDs from assistant messages
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          seenToolCallIds.add(tc.id);
        }
      }
    }

    keep.push(msg);
  }

  return keep;
}

// ---------------------------------------------------------------------------
// Dangling tool_calls cleanup
// ---------------------------------------------------------------------------

/**
 * Filter out assistant tool_calls entries that have no following TOOL_RESULT.
 *
 * This handles interrupted turns where the assistant emitted tool_calls
 * but the stream was cancelled before the tools could execute. Strict
 * providers reject dangling tool_calls with HTTP 400.
 *
 * @param messages - Messages to clean up
 * @returns Messages with dangling tool_calls filtered
 */
export function cleanDanglingToolCalls(messages: Message[]): Message[] {
  if (!messages.length) return messages;

  // First pass: collect all tool_call_ids that have a TOOL_RESULT
  const resultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === MessageRole.TOOL && msg.tool_call_id) {
      resultIds.add(msg.tool_call_id);
    }
  }

  // Second pass: filter tool_calls from assistant messages
  return messages.map((msg) => {
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg;
    }

    const surviving = msg.tool_calls.filter((tc) => resultIds.has(tc.id));

    if (surviving.length === msg.tool_calls.length) {
      // All tool_calls have results — no change
      return msg;
    }

    if (surviving.length === 0) {
      // All tool_calls are dangling — remove the field entirely
      if (!msg.content) {
        // Empty assistant turn — could be dropped entirely by caller
        return { ...msg, tool_calls: null };
      }
      return { ...msg, tool_calls: null };
    }

    // Some tool_calls survived — keep only those
    return { ...msg, tool_calls: surviving };
  });
}

// ---------------------------------------------------------------------------
// Chain reconciliation (full restore pipeline)
// ---------------------------------------------------------------------------

/**
 * Reconcile a chain's messages on restore.
 *
 * Runs the full cleanup pipeline:
 * 1. Drop orphaned TOOL_RESULT messages (no preceding assistant tool_calls)
 * 2. Drop duplicate TOOL_RESULT messages
 * 3. Filter dangling tool_calls from assistant messages
 *
 * This is the TS equivalent of what happens in `chainFromStorageDict`
 * and should be called when restoring a chain from persistence.
 *
 * @param messages - Messages from a restored chain
 * @returns Cleaned messages with pairing invariant enforced
 */
export function reconcileChain(messages: Message[]): Message[] {
  // Step 1 & 2: Clean orphaned and duplicate tool results
  let cleaned = cleanOrphanToolResults(messages);

  // Step 3: Clean dangling tool_calls
  cleaned = cleanDanglingToolCalls(cleaned);

  return cleaned;
}

// ---------------------------------------------------------------------------
// Streaming-phase cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up messages at the end of a streaming phase.
 *
 * Called when a stream is interrupted or cancelled. Ensures:
 * - Partial tool_calls (no id or name) are removed
 * - Assistant messages with only partial tool_calls are cleaned
 *
 * @param messages - Messages from the current streaming phase
 * @returns Cleaned messages
 */
export function cleanStreamingArtifacts(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg;
    }

    // Filter out partial tool_calls (missing id or name)
    const wellFormed = msg.tool_calls.filter(
      (tc) => tc.id && tc.function?.name,
    );

    if (wellFormed.length === msg.tool_calls.length) {
      return msg;
    }

    if (wellFormed.length === 0) {
      return { ...msg, tool_calls: null };
    }

    return { ...msg, tool_calls: wellFormed };
  });
}
