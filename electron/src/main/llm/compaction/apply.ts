/**
 * U7: Atomic compaction persistence — flags + summary head as one crash-safe write.
 *
 * Requirements R3,R20,R22,R23.
 * Dependencies U3,U4,U5.
 *
 * Replacement via excludeFromModel never deletion (R3).
 * Summary head is its own chain (R20, R23).
 * Crash before apply leaves old history, crash after leaves compacted (R22).
 *
 * Approach:
 * - Pure build: buildCompactionApply() produces flagged replay state + summary head
 *   with compacted marker {rangeStart, rangeEnd, mode, summarizedCount}.
 * - Persistence wrappers ride existing paths:
 *   between-turns → single atomic DB transaction (summary head as COMPLETED chain + flagged chains)
 *   mid-turn      → checkpointActiveTurn debounce so crash resumes compacted chain
 *   reclaim-only  → flags without summary head, same atomic path
 *
 * Never mutate older chains in place: callers receive new chain objects; storage
 * transaction replaces rows atomically. If DB integration is unavailable, the pure
 * build plus a stub persistence wrapper is sufficient for U8/U9 to call with a
 * mocked session manager.
 */

import { randomUUID } from 'node:crypto';
import type { Message, CompactedMarker, CompactionMode } from '../../../shared/types/message';
import { MessageRole, MessageType } from '../../../shared/types/message';
import type { Chain } from '../../../shared/types/chain';
import { ChainStatus } from '../../../shared/types/chain';
import type { CutResult } from './select';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ApplyInput {
  /** Flat conversation (all chain messages concatenated, chronological). */
  readonly messages: readonly Message[];
  /** Ordered chains (chronological, ordinal ascending). */
  readonly chains: readonly Chain[];
  /** Cut produced by select.ts — compactable is [compactableRange.start, compactableRange.end) == [0, cutIndex) typically. */
  readonly cutResult: CutResult;
  /** Handoff summary text; null/empty → reclaim-only path (flags without summary head). */
  readonly summaryText: string | null;
  readonly mode: CompactionMode;
  /** Extra ids to flag (e.g. caller-merged reclaim ids). */
  readonly flaggedIds?: readonly string[];
  /** Alias for flaggedIds from mechanical reclaim pass; merged into flagged set. */
  readonly reclaimedIds?: readonly string[];
  /** Session id for the new chain; falls back to chains[0].sessionId when omitted. */
  readonly sessionId?: string;
}

export interface ApplyResult {
  /** New flat replay state: flagged range + summary head inserted at cutIndex (when present). */
  readonly updatedMessages: Message[];
  /** New chain list: every input chain cloned with flagged messages, plus newChain appended when present. */
  readonly updatedChains: Chain[];
  /** Summary head message with compacted marker, or null for reclaim-only. */
  readonly summaryMessage: Message | null;
  /** Summary head chain (COMPLETED), or null for reclaim-only / empty compactable. */
  readonly newChain: Chain | null;
  /** Flags that were applied to the flat history (ids). */
  readonly flaggedIds: string[];
  /** Compacted marker placed on summary head (when present). */
  readonly compactedMarker: CompactedMarker | null;
  /** Whether anything was actually applied (flags or summary). */
  readonly didApply: boolean;
}

// ── Validation ──────────────────────────────────────────────────────────────

export class CompactionApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompactionApplyError';
  }
}

/**
 * Whether the compactable range already contains flagged (excludeFromModel) messages.
 * Used to prevent double-flagging / no-op re-compaction over same range.
 */
export function validateCompactableRangeNotFlagged(
  messages: readonly Message[],
  cutResult: CutResult,
): { valid: boolean; alreadyFlaggedIds: string[] } {
  const start = Math.max(0, Math.min(cutResult.compactableRange.start, messages.length));
  const end = Math.max(start, Math.min(cutResult.compactableRange.end, messages.length));
  const alreadyFlaggedIds: string[] = [];
  for (let i = start; i < end; i += 1) {
    const m = messages[i]!;
    if (m.excludeFromModel) alreadyFlaggedIds.push(m.id);
  }
  return { valid: alreadyFlaggedIds.length === 0, alreadyFlaggedIds };
}

/**
 * Strict variant: throw if compactable range is already partially flagged.
 */
export function assertCompactableRangeNotFlagged(
  messages: readonly Message[],
  cutResult: CutResult,
): void {
  const { valid, alreadyFlaggedIds } = validateCompactableRangeNotFlagged(messages, cutResult);
  if (!valid) {
    throw new CompactionApplyError(
      `compactable range [${cutResult.compactableRange.start},${cutResult.compactableRange.end}) already contains flagged messages: ${alreadyFlaggedIds.join(', ')}`,
    );
  }
}

// ── Summary head ────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

export function makeSummaryHeadMessage(params: {
  summaryText: string;
  cutResult: CutResult;
  messages: readonly Message[];
  mode: CompactionMode;
  summarizedCount?: number;
}): Message {
  const { summaryText, cutResult, messages, mode } = params;
  const start = cutResult.compactableRange.start;
  const end = cutResult.compactableRange.end;
  // Use ids of first/last message in the compactable range as range anchors.
  // Fall back to index-based synthetic ids when messages at those positions missing.
  const rangeStart = messages[start]?.id ?? `idx-${start}`;
  const rangeEnd = messages[Math.max(start, end - 1)]?.id ?? `idx-${Math.max(start, end - 1)}`;
  const marker: CompactedMarker = {
    rangeStart,
    rangeEnd,
    mode,
    ...(typeof params.summarizedCount === 'number' ? { summarizedCount: Math.max(0, Math.floor(params.summarizedCount)) } : {}),
  };
  return {
    id: randomUUID(),
    role: MessageRole.ASSISTANT,
    content: summaryText,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: nowIso(),
    usage: null,
    hidden: false,
    excludeFromModel: false,
    compacted: marker,
    tool_result: null,
  };
}

// ── Pure transform ──────────────────────────────────────────────────────────

export function buildCompactionApply(input: ApplyInput): ApplyResult {
  const { messages, chains, cutResult, summaryText, mode } = input;
  const n = messages.length;
  const start = Math.max(0, Math.min(cutResult.compactableRange.start, n));
  const end = Math.max(start, Math.min(cutResult.compactableRange.end, n));
  const cutIndex = Math.max(0, Math.min(cutResult.cutIndex, n));

  // Empty compactable → nothing to flag, no summary head even if text provided.
  const isEmptyRange = start >= end;
  const hasSummaryText = typeof summaryText === 'string' && summaryText.trim().length > 0;

  // Validate: if non-empty range, ensure not already flagged — caller can pre-validate,
  // but we surface a descriptive throw rather than silently double-flagging.
  if (!isEmptyRange) {
    const { valid, alreadyFlaggedIds } = validateCompactableRangeNotFlagged(messages, cutResult);
    if (!valid && hasSummaryText) {
      // For reclaim-only we tolerate already-flagged ids overlapping the range,
      // because reclaim flags are subsets. But for summary compaction the whole
      // range should be unflagged; surface error.
      // Allow callers to bypass by not passing summaryText; for now we only warn for reclaim.
      // Throw for summary case so tests can assert crash-safety precondition.
      throw new CompactionApplyError(
        `compactable range already flagged: ${alreadyFlaggedIds.join(', ')}`,
      );
    }
  }

  // Determine final flagged ids.
  let finalFlaggedIds: string[];
  if (hasSummaryText && !isEmptyRange) {
    // Flag entire compactable range (every message id in [start,end) that is not already excluded/hidden is flagged)
    const rangeIds: string[] = [];
    for (let i = start; i < end; i += 1) {
      const m = messages[i]!;
      // Skip already excluded — not needed but ensures idempotence
      if (m.excludeFromModel) continue;
      if (m.hidden) continue;
      rangeIds.push(m.id);
    }
    const extra = [...(input.flaggedIds ?? []), ...(input.reclaimedIds ?? [])];
    const set = new Set<string>([...rangeIds, ...extra]);
    finalFlaggedIds = [...set];
  } else {
    // Reclaim-only (or empty range): only flag explicitly supplied ids
    const set = new Set<string>([...(input.flaggedIds ?? []), ...(input.reclaimedIds ?? [])]);
    finalFlaggedIds = [...set].filter((id) => typeof id === 'string' && id.length > 0);
    // In reclaim-only we do not implicitly flag the whole range — only duplicates.
  }

  // If nothing to do, return passthrough (no summary, no flags)
  const nothingToFlag = finalFlaggedIds.length === 0;
  const shouldInsertSummary = hasSummaryText && !isEmptyRange;

  if (nothingToFlag && !shouldInsertSummary) {
    return {
      updatedMessages: [...messages],
      updatedChains: chains.map((c) => ({ ...c, messages: [...c.messages] })),
      summaryMessage: null,
      newChain: null,
      flaggedIds: [],
      compactedMarker: null,
      didApply: false,
    };
  }

  const flaggedSet = new Set(finalFlaggedIds);
  const flaggedMessages: Message[] = messages.map((m) =>
    flaggedSet.has(m.id) ? { ...m, excludeFromModel: true } : m,
  );

  let summaryMessage: Message | null = null;
  let compactedMarker: CompactedMarker | null = null;
  let updatedMessages: Message[] = flaggedMessages;

  if (shouldInsertSummary) {
    const summarizedCount = end - start;
    summaryMessage = makeSummaryHeadMessage({
      summaryText: summaryText!.trim(),
      cutResult,
      messages: flaggedMessages,
      mode,
      summarizedCount,
    });
    compactedMarker = summaryMessage.compacted ?? null;
    // Insert summary head at cutIndex (which equals end in contiguous case).
    // Use cutIndex rather than end to respect tool-group snapping.
    const safeCut = Math.max(0, Math.min(cutIndex, flaggedMessages.length));
    updatedMessages = [
      ...flaggedMessages.slice(0, safeCut),
      summaryMessage,
      ...flaggedMessages.slice(safeCut),
    ];
  }

  // Build updated chains: map each chain's messages through the flagged set.
  // Never mutate input chains in place — always produce new objects for affected chains.
  const idToUpdated = new Map<string, Message>();
  for (const m of flaggedMessages) idToUpdated.set(m.id, m);

  const updatedChains: Chain[] = chains.map((chain) => {
    let changed = false;
    const newMessages = chain.messages.map((m) => {
      const updated = idToUpdated.get(m.id);
      if (updated && updated !== m) {
        // Either flagged or same content but different reference due to excludeFromModel change
        // Compare excludeFromModel flag
        if (updated.excludeFromModel !== m.excludeFromModel) {
          changed = true;
          return updated;
        }
        // Also propagate if original was within flagged range but we flagged via id; updated has flag
        if (flaggedSet.has(m.id) && !m.excludeFromModel) {
          changed = true;
          return updated;
        }
      }
      return m;
    });
    if (!changed) {
      // Return clone with shallow copy of messages to guarantee not-mutated invariant
      return { ...chain, messages: [...chain.messages] };
    }
    return { ...chain, messages: newMessages };
  });

  let newChain: Chain | null = null;
  const finalChains: Chain[] = [...updatedChains];
  if (summaryMessage) {
    const sessionId = input.sessionId ?? chains[0]?.sessionId ?? 'unknown';
    const now = nowIso();
    newChain = {
      id: randomUUID(),
      sessionId,
      messages: [summaryMessage],
      status: ChainStatus.COMPLETED,
      selection: null,
      modelLabel: null,
      agentName: 'compactor',
      agentType: 'internal',
      agentTier: 'seed',
      subagentRecord: null,
      startTime: now,
      endTime: now,
      errorDetail: null,
      errorTitle: null,
    };
    // Append-only insertion: place newChain logically before preserved window for
    // flat replay correctness, but persist atomically. For pure transform we
    // insert it at the ordinal that preserves chronological replay:
    // find first chain whose start index >= cutIndex.
    // We don't have explicit ordinal mapping here; infer from flat messages order.
    // Build flat index -> chain mapping via original messages order.
    // Simpler for pure result: insert at position that keeps flat updatedMessages order consistent.
    // Determine insertion index as number of chains that are fully before cut.
    const originalFlat = messages;
    let insertionIdx = finalChains.length; // default append
    if (chains.length > 0) {
      // O(n) prebuild: id -> chainIdx (avoids O(n*m) nested scan)
      const idToChainIdx = new Map<string, number>();
      chains.forEach((chain, idx) => {
        for (const m of chain.messages) if (!idToChainIdx.has(m.id)) idToChainIdx.set(m.id, idx);
      });
      const firstIndexByChain = new Map<string, number>();
      for (let i = 0; i < originalFlat.length; i += 1) {
        const msgId = originalFlat[i]!.id;
        const chainIdx = idToChainIdx.get(msgId);
        if (chainIdx !== undefined) {
          const chainId = chains[chainIdx]!.id;
          if (!firstIndexByChain.has(chainId)) firstIndexByChain.set(chainId, i);
        }
      }
      for (let idx = 0; idx < finalChains.length; idx += 1) {
        const chain = finalChains[idx]!;
        const firstIdx = firstIndexByChain.get(chain.id) ?? Number.MAX_SAFE_INTEGER;
        if (firstIdx >= cutIndex) {
          insertionIdx = idx;
          break;
        }
      }
    }
    finalChains.splice(insertionIdx, 0, newChain);
  }

  return {
    updatedMessages,
    updatedChains: finalChains,
    summaryMessage,
    newChain,
    flaggedIds: finalFlaggedIds,
    compactedMarker,
    didApply: true,
  };
}

// ── Persistence wrappers (stub-friendly) ────────────────────────────────────

export interface CompactionPersistResult {
  readonly sessionId: string;
  readonly appliedChainIds: string[];
  readonly newChainId: string | null;
  readonly flaggedCount: number;
}

/**
 * Options for between-turn atomic persistence.
 *
 * Provide either a sessionManager (in-memory mock or real) or a direct
 * storage transaction hook. For tests, a minimal in-memory manager suffices.
 */
export interface BetweenTurnsPersistOptions {
  /** In-memory or real session manager with getSession/save access. */
  sessionManager?: {
    getSession?(sessionId: string): { id: string; chains: Chain[] } | null;
    getModelHistory?(sessionId: string): Message[];
    ensureSession?(sessionId: string): { id: string; chains: Chain[] } | null;
  };
  /**
   * Optional atomic writer that must update flagged chains and insert newChain
   * in a single transaction. When provided, it is preferred over individual calls.
   */
  atomicWriter?: (
    sessionId: string,
    updatedChains: Chain[],
    newChain: Chain | null,
  ) => boolean | Promise<boolean>;
  /** Direct storage injection for integration tests — called after pure build. */
  onPersist?: (result: ApplyResult) => void | Promise<void>;
}

/**
 * Persist a compaction between turns atomically (single transaction).
 *
 * Crash before apply → old history (caller hasn't called this yet).
 * Crash after → compacted history (transaction committed).
 *
 * Stub-friendly: when no DB is available, invokes onPersist or delegates to
 * sessionManager atomicWriter; the pure build already produced the new chains.
 */
export async function persistCompactionBetweenTurns(
  sessionId: string,
  applyResult: ApplyResult,
  opts: BetweenTurnsPersistOptions = {},
): Promise<CompactionPersistResult> {
  if (!applyResult.didApply) {
    return { sessionId, appliedChainIds: [], newChainId: null, flaggedCount: 0 };
  }

  if (opts.atomicWriter) {
    const ok = await opts.atomicWriter(sessionId, applyResult.updatedChains, applyResult.newChain);
    if (!ok) throw new CompactionApplyError('atomic compaction write failed');
  } else if (opts.onPersist) {
    await opts.onPersist(applyResult);
  } else if (opts.sessionManager) {
    // Best-effort mock update: if manager exposes chains, verify we can locate session.
    // No throw when manager is a stub without persistence — still report success for pure path.
    if (typeof opts.sessionManager.getSession === 'function') {
      const sess = opts.sessionManager.getSession(sessionId);
      if (!sess) throw new CompactionApplyError(`session ${sessionId} not found for compaction persist`);
    }
  }

  return {
    sessionId,
    appliedChainIds: applyResult.updatedChains.map((c) => c.id),
    newChainId: applyResult.newChain?.id ?? null,
    flaggedCount: applyResult.flaggedIds.length,
  };
}

/**
 * Mid-turn (active-chain) persistence — rides the existing checkpointActiveTurn debounce.
 *
 * The returned checkpointMessages can be fed to SessionManager.updateActiveChainMessages
 * or to checkpointActiveTurn(activeAgent, context) so a crash resumes the compacted chain.
 *
 * This helper is intentionally side-effect free; the caller decides how to checkpoint
 * (direct update for tests, debounced checkpoint for production).
 */
export interface MidTurnPersistInput {
  readonly sessionId: string;
  readonly activeChainId: string | null;
  readonly priorMessageCount: number;
  /** Current active chain messages before compaction (for reconstruction). */
  readonly activeChainMessages: readonly Message[];
  /** Full prior history (flattened, before this turn's user message). Not used directly but kept for completeness. */
  readonly priorMessages?: readonly Message[];
}

export interface MidTurnCompactionResult {
  /** Messages that should replace the active chain row (debounced checkpoint). */
  readonly checkpointMessages: Message[];
  /** Full updated flat replay (for historyFromSession parity checks). */
  readonly updatedFlatMessages: Message[];
  readonly summaryMessage: Message | null;
  readonly newChain: Chain | null;
  readonly flaggedIds: string[];
}

/**
 * Build the mid-turn checkpoint payload after a pure apply.
 *
 * Mid-turn compaction compacts an in-flight turn's active chain content.
 * The flagged range is still applied to the flat history, but persistence
 * targets only the ACTIVE chain row (via checkpointActiveTurn). Summary head
 * is still its own chain when present — but for mid-turn the summary is
 * conceptually part of the active chain's next checkpoint? U7 says: ride
 * existing checkpointActiveTurn debounce so crash resumes compacted chain.
 * For integration tests we expose both the newChain (summary head) and the
 * checkpointMessages.
 */
export function buildMidTurnCheckpoint(
  input: ApplyInput,
  applyResult: ApplyResult,
  mid: MidTurnPersistInput,
): MidTurnCompactionResult {
  // For mid-turn, the active chain's messages are a suffix of the flat history:
  // flat = priorMessages (n) + activeChainMessages (m)
  // Cut is over flat; flagged portion may span prior chains + active chain suffix.
  // Checkpoint must contain only the active chain's slice after compaction,
  // plus the summary head if it falls inside the active window? But summary
  // head is defined to sit before the preserved window, which includes the
  // open tool group (tail of active chain). So summary head typically sits
  // before active chain content, not inside it — unless active chain is large
  // and compaction spills into it. For simplicity we keep summary head as its
  // own chain even for mid-turn, and checkpointMessages is the active chain's
  // slice of updatedMessages after priorMessageCount.
  const priorCount = mid.priorMessageCount;
  // updatedMessages includes summary head inserted at cutIndex; slice tail for active checkpoint.
  // Determine where active window starts in updatedMessages: it may have shifted by +1 if summary inserted before it.
  const summaryInserted = applyResult.summaryMessage ? 1 : 0;
  const cutIndex = input.cutResult.cutIndex;
  // Active window in original flat starts at priorCount.
  // After compaction, active window start in updated flat:
  // if cutIndex <= priorCount, summary insertion is before active window so active start shifts by summaryInserted.
  // if cutIndex > priorCount, insertion is inside active window.
  let activeStartInUpdated: number;
  if (summaryInserted === 0) {
    activeStartInUpdated = priorCount;
  } else if (cutIndex <= priorCount) {
    activeStartInUpdated = priorCount + summaryInserted;
  } else {
    // Insertion inside active window — active window still starts at priorCount, but includes summary at offset
    activeStartInUpdated = priorCount;
  }

  // Build checkpoint messages as the slice of updatedMessages that belongs to the active chain
  // plus the summary head when it was inserted inside the active window? It's already in updatedMessages slice.
  const checkpointMessages = applyResult.updatedMessages.slice(activeStartInUpdated);

  // For the case where summary was inserted before active window, the summary is not part of active checkpoint
  // — it's a separate COMPLETED chain (newChain). That's correct: mid-turn compaction still creates a new
  // COMPLETED chain for the summary head, and the active chain row holds only the preserved tail.
  // Crash recovery loads both: summary chain + interrupted active chain.

  return {
    checkpointMessages,
    updatedFlatMessages: applyResult.updatedMessages,
    summaryMessage: applyResult.summaryMessage,
    newChain: applyResult.newChain,
    flaggedIds: applyResult.flaggedIds,
  };
}

/**
 * Reclaim-only helper — pure flag apply without summary head.
 * Provided for symmetry with U5; callers may just call buildCompactionApply with null summaryText,
 * but this alias clarifies intent.
 */
export function buildReclaimOnlyApply(
  messages: readonly Message[],
  chains: readonly Chain[],
  cutResult: CutResult,
  reclaimedIds: readonly string[],
): ApplyResult {
  return buildCompactionApply({
    messages,
    chains,
    cutResult,
    summaryText: null,
    mode: 'simple',
    reclaimedIds,
  });
}

/**
 * Convenience: check whether a given apply would actually reclaim anything
 * (used by trigger engine to decide skip).
 */
export function hasReclaimableFlags(input: ApplyInput): boolean {
  const start = input.cutResult.compactableRange.start;
  const end = input.cutResult.compactableRange.end;
  if (start >= end) return false;
  const ids = new Set([...(input.flaggedIds ?? []), ...(input.reclaimedIds ?? [])]);
  return ids.size > 0;
}
