/**
 * Server-side snapshot trimming with a `session.history_page` continuation
 * (review #25).
 *
 * `chat.snapshot` / `session.open` return the whole flattened message history
 * in ONE JSON frame; over a wire transport a snapshot past the 32MiB frame cap
 * (`MAX_FRAME_BYTES`) throws FrameTooLargeError and kills the transport, and
 * every reconnect/reopen re-requests the same snapshot — a deterministic
 * connect→lost flap. This helper caps the serialized result at a safe budget
 * (24MiB, headroom for the response envelope and the live tail under the
 * 32MiB cap) by keeping the most recent messages that fit and emitting a
 * continuation cursor the renderer can feed straight into
 * `session.history_page` ({ sessionId, chainId, beforeIndex }).
 *
 * Cost model: one byte estimate per message at snapshot build time (no work on
 * the happy path beyond a single serialization pass when the budget is
 * exceeded). A single message larger than the whole budget is still kept — an
 * empty snapshot is worse than an oversized frame, and no per-message splitter
 * exists.
 */
import type { Chain } from '../../../shared/types/chain';
import { MAX_FRAME_BYTES } from '../../../shared/host/framing';
import type { Message } from '../../../shared/types/message';

/**
 * Serialized-message budget for one snapshot result frame. Deliberately below
 * MAX_FRAME_BYTES so the response envelope, the live-turn snapshot, and JSON
 * escaping overhead still fit after the messages payload.
 */
export const SNAPSHOT_FRAME_BYTE_BUDGET = 24 * 1024 * 1024;

/** Mutable view of the budget (test seam; production always the constant above). */
let frameByteBudget = SNAPSHOT_FRAME_BYTE_BUDGET;

/** Test seam: shrink/restore the frame budget so trimming is testable cheaply. */
export function _setSnapshotFrameByteBudgetForTests(bytes: number | null): void {
  frameByteBudget = bytes ?? SNAPSHOT_FRAME_BYTE_BUDGET;
}

/** `history_page` continuation: the page immediately older than the kept tail. */
export interface SnapshotHistoryCursor {
  readonly chainId: string;
  readonly beforeIndex: number;
}

/** Trim marker attached to a budgeted snapshot (absent when nothing dropped). */
export interface SnapshotTrim {
  /** Number of leading durable messages dropped to fit the budget. */
  readonly trimFromIndex: number;
  /**
   * Cursor satisfying `session.history_page` params for the next older page.
   * Null when the boundary message cannot be located in a durable chain
   * (e.g. a live-only in-flight message older siblings were trimmed around).
   */
  readonly historyBefore: SnapshotHistoryCursor | null;
}

export interface SnapshotTrimResult {
  readonly messages: readonly Message[];
  readonly trim: SnapshotTrim | null;
}

/** Serialized size of one message in UTF-8 bytes (undefined-safe). */
function messageBytes(message: Message): number {
  try {
    return Buffer.byteLength(JSON.stringify(message) ?? '', 'utf8');
  } catch {
    // A non-serializable member (circular prototype pollution, exotic getter)
    // must not break the snapshot; estimate conservatively as oversized so the
    // message is never the reason a frame silently exceeds the budget check.
    return SNAPSHOT_FRAME_BYTE_BUDGET;
  }
}

/**
 * Locate the `history_page` cursor for the kept tail: walk forward from the
 * first kept message until one is found in a durable chain (searching the
 * newest chains first), then report that chain and the message's index in it.
 * Messages belonging to the in-flight turn may not be persisted yet; skipping
 * them lands the cursor on the newest kept DURABLE message, which is exactly
 * the boundary `history_page` can serve.
 */
function historyCursorFor(
  messages: readonly Message[],
  trimFromIndex: number,
  chains: readonly Chain[],
): SnapshotHistoryCursor | null {
  for (let index = trimFromIndex; index < messages.length; index += 1) {
    const id = messages[index]?.id;
    if (id == null) continue;
    for (let chainIndex = chains.length - 1; chainIndex >= 0; chainIndex -= 1) {
      const chain = chains[chainIndex];
      if (!chain) continue;
      const beforeIndex = chain.messages.findIndex((message) => message.id === id);
      if (beforeIndex >= 0) {
        return { chainId: chain.id, beforeIndex };
      }
    }
  }
  return null;
}

/**
 * Keep the most recent `messages` that fit `budgetBytes` and describe what was
 * dropped. `chains` is the durable chain layout used to derive the
 * `history_page` continuation cursor.
 */
export function trimMessagesForFrame(
  messages: readonly Message[],
  chains: readonly Chain[] = [],
  budgetBytes: number = frameByteBudget,
): SnapshotTrimResult {
  // The budget must always leave headroom under the transport's hard frame
  // cap — a budget at/above it would trim nothing and re-create #25.
  if (budgetBytes >= MAX_FRAME_BYTES) {
    throw new Error(
      `Snapshot byte budget ${budgetBytes} must stay below the ${MAX_FRAME_BYTES}-byte frame cap`,
    );
  }
  if (messages.length === 0) return { messages, trim: null };

  const sizes = messages.map(messageBytes);
  let totalBytes = 0;
  for (const size of sizes) totalBytes += size;
  if (totalBytes <= budgetBytes) return { messages, trim: null };

  // Keep the newest messages that fit; always keep at least the newest one so
  // an oversized single message degrades to a still-renderable snapshot.
  let keptCount = 0;
  let keptBytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const size = sizes[index] ?? 0;
    if (keptCount > 0 && keptBytes + size > budgetBytes) break;
    keptCount += 1;
    keptBytes += size;
  }
  const trimFromIndex = messages.length - keptCount;
  if (trimFromIndex <= 0) return { messages, trim: null };

  return {
    messages: messages.slice(trimFromIndex),
    trim: {
      trimFromIndex,
      historyBefore: historyCursorFor(messages, trimFromIndex, chains),
    },
  };
}
