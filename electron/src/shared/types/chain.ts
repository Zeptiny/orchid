/**
 * Chain types for the Orchid domain.
 *
 * Multi-chain model:
 * - One Chain per user turn (append-only session.chains)
 * - LLM history is flatten(session.chains); storage keeps turns separate
 * - status ACTIVE while streaming; COMPLETED / INTERRUPTED / FAILED when frozen
 *
 * Key restore behavior:
 * - fromStorageDict() runs orphan tool result reconciliation:
 *   TOOL_RESULT with no preceding assistant tool_calls → dropped
 * - ACTIVE → INTERRUPTED on restore (process died; chain cannot still be live)
 */

import type { ModelSelection } from './provider';
import type { Message, Usage } from './message';
import { MessageRole } from './message';
import { sumMessageUsages } from '../usage';
import type { SubagentRecord } from './subagent';

// ── Enums as const objects ──────────────────────────────────────────────────

/**
 * Chain lifecycle status.
 * On restore, `active` is migrated to INTERRUPTED (a restored process
 * cannot resume an in-flight chain).
 */
export const ChainStatus = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  FAILED: 'failed',
} as const;

export type ChainStatus = (typeof ChainStatus)[keyof typeof ChainStatus];

/** Terminal statuses — chain is frozen and no longer the live write target. */
export const TERMINAL_CHAIN_STATUSES: ReadonlySet<ChainStatus> = new Set([
  ChainStatus.COMPLETED,
  ChainStatus.INTERRUPTED,
  ChainStatus.FAILED,
]);

export function isTerminalChainStatus(status: ChainStatus): boolean {
  return TERMINAL_CHAIN_STATUSES.has(status);
}

// ── Chain ───────────────────────────────────────────────────────────────────

export interface Chain {
  readonly id: string;
  readonly sessionId: string;
  readonly messages: readonly Message[];
  readonly status: ChainStatus;
  /** Executable model identity, scoped to one provider connection. */
  readonly selection: ModelSelection | null;
  /** Historical/display snapshot only; never used to resolve a model. */
  readonly modelLabel: string | null;
  readonly agentName: string;
  readonly agentType: string;
  readonly agentTier: string;
  readonly subagentRecord: SubagentRecord | null;
  /**
   * ISO timestamp when the chain started (user submit).
   * Null when unknown (legacy sessions).
   */
  readonly startTime: string | null;
  /**
   * ISO timestamp when the chain finished, or null while ACTIVE / unknown.
   */
  readonly endTime: string | null;
}

// ── Storage dict ────────────────────────────────────────────────────────────

export interface ChainStorageDict {
  id?: string;
  sessionId?: string;
  messages?: unknown[];
  status?: string;
  selection?: ModelSelection | null;
  modelLabel?: string | null;
  agentName?: string;
  agentType?: string;
  agentTier?: string;
  subagentRecord?: unknown;
  startTime?: string;
  endTime?: string | null;
  [key: string]: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Elapsed seconds for a chain (wall clock from startTime → endTime or now). */
export function chainElapsedSeconds(chain: Chain, nowMs: number = Date.now()): number {
  if (!chain.startTime) return 0;
  const start = Date.parse(chain.startTime);
  if (Number.isNaN(start)) return 0;
  const end = chain.endTime ? Date.parse(chain.endTime) : nowMs;
  if (Number.isNaN(end)) return 0;
  return Math.max(0, (end - start) / 1000);
}

/** Sum message.usage across a chain. */
export function sumChainUsage(chain: Pick<Chain, 'messages'>): Usage | null {
  return sumMessageUsages(chain.messages);
}

// ── Orphan tool result reconciliation ───────────────────────────────────────

/**
 * Prune TOOL_RESULT messages whose tool_call_id has no preceding assistant
 * tool_calls partner in this list.
 *
 * Also drops duplicate TOOL_RESULT messages for the same tool_call_id.
 */
export function reconcileOrphanToolResults(messages: Message[]): Message[] {
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

// ── Storage helpers ─────────────────────────────────────────────────────────

export function parseChainStatus(raw: unknown): ChainStatus {
  if (typeof raw !== 'string') return ChainStatus.COMPLETED;
  if (raw === 'active') return ChainStatus.ACTIVE;
  if (raw === 'completed') return ChainStatus.COMPLETED;
  if (raw === 'interrupted') return ChainStatus.INTERRUPTED;
  if (raw === 'failed') return ChainStatus.FAILED;
  return ChainStatus.COMPLETED;
}
