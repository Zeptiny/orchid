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
 * both `ipc/chat/compaction.ts` (main adapter) and `agents/subagent-compaction.ts`
 * (subagent adapter) can import it without crossing module-graph boundaries.
 */
import { compactedMarkerFromUnknown, type Message } from '../../../shared/types/message';
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
 * expected id must still sit at its prepare-time position, no flagged id may
 * have vanished or been flagged by someone else, and no compacted summary
 * head may sit deeper than the range start (a head AT the start is being
 * superseded by design). Pre-flagged messages inside the range are tolerated
 * — cancelled tool results and prior mechanical-reclaim flags are already
 * excluded from the model and `buildCompactionApply` skips them.
 */
export function isPendingCutStillValid(
  pending: Pick<CompactionPendingEntry, 'cut' | 'flaggedIds' | 'expectedIds'>,
  messages: readonly Message[],
): boolean {
  const { start, end } = pending.cut.compactableRange;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < 0 || end > messages.length || start >= end) return false;
  if (pending.cut.cutIndex < 0 || pending.cut.cutIndex > messages.length) return false;
  for (let i = start; i < end; i += 1) {
    const message = messages[i];
    if (!message) continue;
    // A compacted summary head DEEPER than the range start would summarize a
    // summary — invalidate. A head at index === start is being superseded
    // (select.ts lands compactableStart ON the old head so re-compaction can
    // re-summarize it), so it is allowed.
    if (i > start && compactedMarkerFromUnknown(message.compacted)) return false;
  }
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
