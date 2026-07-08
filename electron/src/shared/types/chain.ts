/**
 * Chain types for the Orchid domain.
 *
 * Ported from src/orchid/domain/chain.py.
 *
 * Key restore behavior (matching Python):
 * - fromStorageDict() runs orphan tool result reconciliation:
 *   TOOL_RESULT with no preceding assistant tool_calls → dropped
 */

import { z } from 'zod';
import type { Message } from './message';
import {
  messageFromStorageDict,
  messageToStorageDict,
  MessageRole,
} from './message';
import type { SubagentRecord } from './subagent';
import {
  subagentRecordFromStorageDict,
  subagentRecordToStorageDict,
} from './subagent';

// ── Enums as const objects ──────────────────────────────────────────────────

export const ChainStatus = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
} as const;

export type ChainStatus = (typeof ChainStatus)[keyof typeof ChainStatus];

// ── Chain ───────────────────────────────────────────────────────────────────

export interface Chain {
  readonly id: string;
  readonly sessionId: string;
  readonly messages: readonly Message[];
  readonly status: ChainStatus;
  readonly model: string;
  readonly agentName: string;
  readonly agentType: string;
  readonly agentTier: string;
  readonly subagentRecord: SubagentRecord | null;
}

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const chainStatusSchema = z.enum([
  ChainStatus.ACTIVE,
  ChainStatus.COMPLETED,
  ChainStatus.INTERRUPTED,
]);

// Lazy schemas to handle circular dependency between Chain ↔ SubagentRecord
export const chainSchema: z.ZodType<Chain> = z.lazy(() =>
  z.object({
    id: z.string(),
    sessionId: z.string(),
    messages: z.array(z.object({}).passthrough()),
    status: chainStatusSchema,
    model: z.string(),
    agentName: z.string(),
    agentType: z.string(),
    agentTier: z.string(),
    subagentRecord: z.nullable(z.object({}).passthrough()),
  }) as unknown as z.ZodType<Chain>,
);

// ── Storage dict ────────────────────────────────────────────────────────────

export interface ChainStorageDict {
  id?: string;
  sessionId?: string;
  session_id?: string;
  messages?: unknown[];
  status?: string;
  model?: string;
  agentName?: string;
  agent_name?: string;
  agentType?: string;
  agent_type?: string;
  agentTier?: string;
  agent_tier?: string;
  subagentRecord?: unknown;
  subagent_record?: unknown;
  // Forward-compat: extra keys tolerated on restore
  [key: string]: unknown;
}

// ── Orphan tool result reconciliation ───────────────────────────────────────

/**
 * Prune TOOL_RESULT messages whose tool_call_id has no preceding assistant
 * tool_calls partner in this list. Matches Python's
 * `_reconcile_orphan_tool_results`.
 *
 * Also drops duplicate TOOL_RESULT messages for the same tool_call_id.
 */
function reconcileOrphanToolResults(messages: Message[]): Message[] {
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
    model: chain.model,
  };
  if (chain.id) dict.id = chain.id;
  if (chain.sessionId) dict.sessionId = chain.sessionId;
  if (chain.agentName) dict.agentName = chain.agentName;
  if (chain.agentType) dict.agentType = chain.agentType;
  if (chain.agentTier) dict.agentTier = chain.agentTier;
  if (chain.subagentRecord) {
    dict.subagentRecord = subagentRecordToStorageDict(chain.subagentRecord);
  }
  return dict;
}

export function chainFromStorageDict(data: unknown): Chain {
  const raw = data as Record<string, unknown>;

  // Parse messages and run orphan tool result reconciliation
  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  let messages = rawMessages.map((m) => messageFromStorageDict(m));
  messages = reconcileOrphanToolResults(messages);

  // Parse status with fallback
  let status: ChainStatus = ChainStatus.COMPLETED;
  const rawStatus = raw.status;
  if (
    typeof rawStatus === 'string' &&
    (rawStatus === 'active' || rawStatus === 'completed' ||
      rawStatus === 'interrupted')
  ) {
    status = rawStatus;
  }

  // Parse subagentRecord if present
  let subagentRecord: SubagentRecord | null = null;
  const srData = raw.subagentRecord ?? raw.subagent_record;
  if (srData && typeof srData === 'object') {
    subagentRecord = subagentRecordFromStorageDict(srData);
  }

  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    sessionId:
      typeof raw.sessionId === 'string'
        ? raw.sessionId
        : typeof raw.session_id === 'string'
          ? raw.session_id
          : '',
    messages,
    status,
    model: typeof raw.model === 'string' ? raw.model : '',
    agentName:
      typeof raw.agentName === 'string'
        ? raw.agentName
        : typeof raw.agent_name === 'string'
          ? raw.agent_name
          : '',
    agentType:
      typeof raw.agentType === 'string'
        ? raw.agentType
        : typeof raw.agent_type === 'string'
          ? raw.agent_type
          : '',
    agentTier:
      typeof raw.agentTier === 'string'
        ? raw.agentTier
        : typeof raw.agent_tier === 'string'
          ? raw.agent_tier
          : '',
    subagentRecord,
  };
}
