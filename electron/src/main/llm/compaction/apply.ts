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
 * - Persistence is owned by the caller (ipc/chat/persist.ts): it takes the
 *   ApplyResult and writes flagged chains + the summary-head chain as one
 *   crash-safe transaction (crash before → old history, crash after → compacted).
 *
 * Never mutate older chains in place: callers receive new chain objects; storage
 * transaction replaces rows atomically.
 */

import { randomUUID } from 'node:crypto';
import type { Message, CompactedMarker, CompactionMode } from '../../../shared/types/message';
import { MessageRole, MessageType, compactedMarkerFromUnknown } from '../../../shared/types/message';
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
 * Whether the compactable range already contains a compaction summary head
 * (a message carrying a valid `compacted` marker) that is NOT being superseded.
 *
 * A head DEEPER than the range start would be summarized together with its own
 * covered span — true double-compaction — and stays the one fatal precondition
 * for the summary path. A head at index === start is being SUPERSEDED: select.ts
 * deliberately lands compactableStart ON the previous summary head so a
 * re-compaction can re-summarize it under the new head; it is flagged like any
 * other range message and replaced by the new head.
 *
 * Pre-flagged (excludeFromModel) messages inside the range are NOT failures:
 * cancelled tool results (flagged at creation) and prior mechanical-reclaim
 * flags are already excluded from the model, so buildCompactionApply tolerates
 * them and skips them when applying flags instead of double-processing.
 */
export function validateCompactableRangeNotSummarized(
  messages: readonly Message[],
  cutResult: CutResult,
): { valid: boolean; summaryHeadIds: string[] } {
  const start = Math.max(0, Math.min(cutResult.compactableRange.start, messages.length));
  const end = Math.max(start, Math.min(cutResult.compactableRange.end, messages.length));
  const summaryHeadIds: string[] = [];
  for (let i = start; i < end; i += 1) {
    const m = messages[i]!;
    if (i > start && compactedMarkerFromUnknown(m.compacted)) summaryHeadIds.push(m.id);
  }
  return { valid: summaryHeadIds.length === 0, summaryHeadIds };
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

  // Double-compaction guard (summary path only): a range that already contains
  // a summary head (compacted marker) DEEPER than its start would summarize a
  // summary and is fatal. A head at index === start is being superseded —
  // select.ts lands compactableStart ON the old head so re-compaction
  // re-summarizes it — so it is allowed and flagged like other range messages.
  // Pre-flagged (excludeFromModel) messages inside the range are tolerated:
  // cancelled tool results and prior mechanical-reclaim flags are already
  // excluded from the model, so they are skipped by the flagging pass below
  // instead of double-processed. The reclaim-only path never throws.
  if (!isEmptyRange && hasSummaryText) {
    const { valid, summaryHeadIds } = validateCompactableRangeNotSummarized(messages, cutResult);
    if (!valid) {
      throw new CompactionApplyError(
        `compactable range [${start},${end}) already contains a summary head: ${summaryHeadIds.join(', ')}`,
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
      // Already excluded (cancelled results, prior reclaims) — tolerated as-is;
      // it keeps its existing flag and is never double-processed.
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
      if (!flaggedSet.has(m.id) || m.excludeFromModel) return m;
      const updated = idToUpdated.get(m.id);
      if (!updated) return m;
      changed = true;
      return updated;
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
    let insertionIdx = finalChains.length;
    let intraHandled = false;
    if (chains.length > 0) {
      const idToChainIdx = new Map<string, number>();
      chains.forEach((chain, idx) => {
        for (const m of chain.messages) if (!idToChainIdx.has(m.id)) idToChainIdx.set(m.id, idx);
      });
      const firstIndexByChain = new Map<string, number>();
      const lastIndexByChain = new Map<string, number>();
      for (let i = 0; i < originalFlat.length; i += 1) {
        const msgId = originalFlat[i]!.id;
        const chainIdx = idToChainIdx.get(msgId);
        if (chainIdx !== undefined) {
          const chainId = chains[chainIdx]!.id;
          if (!firstIndexByChain.has(chainId)) firstIndexByChain.set(chainId, i);
          lastIndexByChain.set(chainId, i);
        }
      }
      let containingIdx: number | null = null;
      let containingId: string | null = null;
      for (let idx = 0; idx < chains.length; idx += 1) {
        const chainId = chains[idx]!.id;
        const firstIdx = firstIndexByChain.get(chainId);
        const lastIdx = lastIndexByChain.get(chainId);
        if (firstIdx !== undefined && lastIdx !== undefined && cutIndex >= firstIdx && cutIndex <= lastIdx + 1) {
          containingIdx = idx;
          containingId = chainId;
          break;
        }
      }
      if (containingIdx !== null && containingId !== null) {
        const firstIdx = firstIndexByChain.get(containingId)!;
        if (cutIndex === firstIdx) {
          const finalIdx = finalChains.findIndex((c) => c.id === containingId);
          insertionIdx = finalIdx >= 0 ? finalIdx : finalChains.length;
        } else if (cutIndex > firstIdx) {
          const finalIdx = finalChains.findIndex((c) => c.id === containingId);
          if (finalIdx >= 0) {
            const originalChain = finalChains[finalIdx]!;
            const cutOffsetInChain = cutIndex - firstIdx;
            const beforeMessages = originalChain.messages.slice(0, cutOffsetInChain);
            const afterMessages = originalChain.messages.slice(cutOffsetInChain);
            if (beforeMessages.length === 0) {
              finalChains.splice(finalIdx, 1, newChain, { ...originalChain, messages: afterMessages });
            } else if (afterMessages.length === 0) {
              finalChains.splice(finalIdx + 1, 0, newChain);
            } else {
              // Split id assignment: the PRESERVED after-half keeps the ORIGINAL
              // chain id so external references (session.activeChainId, subagent
              // record.chain) keep pointing at the live, continuing half. The
              // flagged prefix half is frozen history and takes a fresh id —
              // nothing external references it.
              const prefixChain: Chain = {
                id: randomUUID(),
                sessionId: originalChain.sessionId,
                messages: beforeMessages,
                status: originalChain.status,
                selection: originalChain.selection,
                modelLabel: originalChain.modelLabel,
                agentName: originalChain.agentName,
                agentType: originalChain.agentType,
                agentTier: originalChain.agentTier,
                subagentRecord: null,
                startTime: originalChain.startTime,
                endTime: originalChain.endTime,
                errorDetail: originalChain.errorDetail,
                errorTitle: originalChain.errorTitle,
              };
              const afterChain: Chain = { ...originalChain, messages: afterMessages };
              // Replay order: flagged prefix (new id) → summary head → preserved
              // after-half (original id).
              finalChains.splice(finalIdx, 1, prefixChain, newChain, afterChain);
            }
            intraHandled = true;
          }
        }
      } else {
        insertionIdx = finalChains.length;
      }
      if (!intraHandled) {
        for (let idx = 0; idx < finalChains.length; idx += 1) {
          const chain = finalChains[idx]!;
          const firstIdx = firstIndexByChain.get(chain.id) ?? Number.MAX_SAFE_INTEGER;
          if (firstIdx >= cutIndex) {
            insertionIdx = idx;
            break;
          }
        }
        finalChains.splice(insertionIdx, 0, newChain);
      }
    } else {
      finalChains.splice(insertionIdx, 0, newChain);
    }
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
