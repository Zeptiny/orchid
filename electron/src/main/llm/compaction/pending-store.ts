/**
 * Scope-keyed pending-compaction store (R37).
 *
 * One process-wide registry of prepared-but-not-yet-applied compactions,
 * keyed by (sessionId, agentScopeId) so the main session and each subagent
 * run own independent pendings. The entry shape and the validity rules are
 * shared verbatim by both scope adapters — a pending is registered at prepare
 * time (cut, expected ids, compactor promise) and re-validated against the
 * LIVE history at apply time, so history appended between prepare and apply
 * (or a re-written history) can never be compacted against a stale cut.
 *
 * Deliberately dependency-free beyond the compaction engine's own types so
 * both `host/chat/compaction.ts` (main adapter) and `agents/subagent-compaction.ts`
 * (subagent adapter) can import it without crossing module-graph boundaries.
 */
import type { Message } from '../../../shared/types/message';
import { normalizeAgentScopeId, type AgentScopeId } from '../../../shared/types/agent-scope';
import type { CutResult } from './select';
import type { SummarizeResult } from './summarize';
import type { CompactionAttemptOutcome } from './run-attempt';

/**
 * A compaction prepared but not yet applied. Registered by the prepare fire
 * point; consumed at the next pause boundary (or turn start for main).
 */
export interface CompactionPendingEntry {
  readonly cut: CutResult;
  readonly flaggedIds: string[];
  readonly expectedIds?: string[];
  readonly estimatedInput: number;
  readonly contextTokens: number;
  readonly mode: 'simple' | 'selective';
  readonly promise?: Promise<SummarizeResult | null>;
  readonly selectivePromise?: Promise<CompactionAttemptOutcome>;
}

/**
 * Dedupe a message history by id, keeping first occurrences. Mid-turn callers
 * concatenate turn bases with turn progress where the triggering user message
 * repeats, so index-anchored validation must run over the deduped view.
 */
export function dedupeHistoryById(messages: readonly Message[]): Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const m of messages) {
    if (m.id && seen.has(m.id)) continue;
    if (m.id) seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * Whether a pending compaction's cut still matches the live history it is
 * about to be applied over (R37, shared by both scopes).
 *
 * Index-anchored: the compactable range must land inside the history, every
 * expected id must still sit at its prepare-time position, and no flagged id
 * may have vanished or been flagged by someone else. Pre-flagged messages
 * inside the range are tolerated — cancelled tool results, prior
 * mechanical-reclaim flags, and superseded compacted summary heads are
 * already excluded from the model (or are re-summarizable by design) and
 * `buildCompactionApply` skips them.
 *
 * Compacted summary heads inside the range are valid at ANY depth: select.ts
 * treats heads as re-summarizable chain boundaries, and selective mode
 * materializes one synthetic per summarize op — a re-compaction range
 * legitimately contains several stacked heads that the new compaction
 * supersedes. A head inserted AFTER the prepare would shift the expected ids
 * and is rejected by the index anchoring, so no marker-specific check is
 * needed.
 */
export function isPendingCutStillValid(
  pending: Pick<CompactionPendingEntry, 'cut' | 'flaggedIds' | 'expectedIds'>,
  messages: readonly Message[],
): boolean {
  const { start, end } = pending.cut.compactableRange;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < 0 || end > messages.length || start >= end) return false;
  if (pending.cut.cutIndex < 0 || pending.cut.cutIndex > messages.length) return false;
  // Fail closed without expected ids: with the marker-depth check removed the
  // id anchoring is the ONLY staleness protection, so a pending that did not
  // capture its expected ids cannot be proven still-valid and must discard.
  if (!pending.expectedIds || pending.expectedIds.length === 0) return false;
  if (pending.flaggedIds.length > 0) {
    const idToMsg = new Map<string, Message>();
    for (const m of messages) idToMsg.set(m.id, m);
    for (const id of pending.flaggedIds) {
      const msg = idToMsg.get(id);
      if (!msg) return false;
      if (msg.excludeFromModel) return false;
    }
  }
  if (pending.expectedIds) {
    if (pending.expectedIds.length !== end - start) return false;
    for (let i = 0; i < pending.expectedIds.length; i += 1) {
      if (messages[start + i]?.id !== pending.expectedIds[i]) return false;
    }
  }
  return true;
}
function key(sessionId: string, agentScopeId: AgentScopeId | null): string {
  return `${sessionId}\u0000${normalizeAgentScopeId(agentScopeId)}`;
}

const pendings = new Map<string, CompactionPendingEntry>();

/** Register a prepared compaction for one agent scope (replaces any prior entry). */
export function setCompactionPending(
  sessionId: string,
  agentScopeId: AgentScopeId | null,
  entry: CompactionPendingEntry,
): void {
  pendings.set(key(sessionId, agentScopeId), entry);
}

/** The prepared compaction registered for one agent scope, if any. */
export function getCompactionPending(
  sessionId: string,
  agentScopeId: AgentScopeId | null,
): CompactionPendingEntry | undefined {
  return pendings.get(key(sessionId, agentScopeId));
}

/** Atomically remove and return the pending registered for one agent scope. */
export function takeCompactionPending(
  sessionId: string,
  agentScopeId: AgentScopeId | null,
): CompactionPendingEntry | undefined {
  const k = key(sessionId, agentScopeId);
  const entry = pendings.get(k);
  pendings.delete(k);
  return entry;
}

/** Discard the pending registered for one agent scope without applying it. */
export function deleteCompactionPending(
  sessionId: string,
  agentScopeId: AgentScopeId | null,
): void {
  pendings.delete(key(sessionId, agentScopeId));
}

/** Discard every pending prepared for a session (any scope — session deleted). */
export function clearCompactionPendingsForSession(sessionId: string): void {
  for (const k of pendings.keys()) {
    if (k.startsWith(`${sessionId}\u0000`)) pendings.delete(k);
  }
}
