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

import {
  copyModelSelection,
  modelSelectionSchema,
  type ModelSelection,
} from './provider';
import type { Message, Usage } from './message';
import { messageFromStorageDict, messageToStorageDict, MessageRole } from './message';
import { sumMessageUsages } from '../usage';
import type { SubagentRecord } from './subagent';
import { subagentRecordFromStorageDict, subagentRecordToStorageDict } from './subagent';

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

// ── Serialization ───────────────────────────────────────────────────────────

export function chainToStorageDict(chain: Chain): ChainStorageDict {
  const dict: ChainStorageDict = {
    messages: chain.messages.map(messageToStorageDict),
    status: chain.status,
    selection: copyModelSelection(chain.selection),
    modelLabel: chain.modelLabel ?? null,
  };
  if (chain.id) dict.id = chain.id;
  if (chain.sessionId) dict.sessionId = chain.sessionId;
  if (chain.agentName) dict.agentName = chain.agentName;
  if (chain.agentType) dict.agentType = chain.agentType;
  if (chain.agentTier) dict.agentTier = chain.agentTier;
  if (chain.subagentRecord) {
    dict.subagentRecord = subagentRecordToStorageDict(chain.subagentRecord);
  }
  if (chain.startTime) dict.startTime = chain.startTime;
  if (chain.endTime != null) dict.endTime = chain.endTime;
  return dict;
}

export function parseChainStatus(raw: unknown): ChainStatus {
  if (typeof raw !== 'string') return ChainStatus.COMPLETED;
  if (raw === 'active') return ChainStatus.ACTIVE;
  if (raw === 'completed') return ChainStatus.COMPLETED;
  if (raw === 'interrupted') return ChainStatus.INTERRUPTED;
  if (raw === 'failed') return ChainStatus.FAILED;
  return ChainStatus.COMPLETED;
}

function parseTimeField(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}

function parseEndTime(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw.length > 0 ? raw : null;
  return null;
}

export function chainFromStorageDict(data: unknown): Chain {
  const raw = data as Record<string, unknown>;
  const parsedSelection = modelSelectionSchema.safeParse(raw.selection);
  const selection: ModelSelection | null = parsedSelection.success ? parsedSelection.data : null;
  const modelLabel: string | null =
    typeof raw.modelLabel === 'string' ? raw.modelLabel : null;

  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  let messages = rawMessages.map((m) => messageFromStorageDict(m));
  messages = reconcileOrphanToolResults(messages);

  let status = parseChainStatus(raw.status);

  let subagentRecord: SubagentRecord | null = null;
  const srData = raw.subagentRecord;
  if (srData && typeof srData === 'object') {
    subagentRecord = subagentRecordFromStorageDict(srData);
  }

  const startTime = parseTimeField(raw.startTime);
  let endTime = parseEndTime(raw.endTime);

  if (status === ChainStatus.ACTIVE) {
    status = ChainStatus.INTERRUPTED;
    if (!endTime) {
      endTime = new Date().toISOString();
    }
  }

  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    messages,
    status,
    selection,
    modelLabel,
    agentName: typeof raw.agentName === 'string' ? raw.agentName : '',
    agentType: typeof raw.agentType === 'string' ? raw.agentType : '',
    agentTier: typeof raw.agentTier === 'string' ? raw.agentTier : '',
    subagentRecord,
    startTime,
    endTime,
  };
}
