/**
 * SubagentRecord types for the Orchid domain.
 *
 * Ported from src/orchid/agents/manager.py (SubagentRecord).
 *
 * Key restore behavior (matching Python):
 * - fromStorageDict() migrates PENDING/RUNNING → INTERRUPTED
 * - INTERRUPTED records without end_time get end_time set to now
 */

import { z } from 'zod';
import type { Chain } from './chain';
import type { Usage } from './message';
import { chainFromStorageDict, chainToStorageDict } from './chain';
import type {
  CanonicalToolResult,
  TerminalToolResultStatus,
} from './tool-result';

// ── Enums as const objects ──────────────────────────────────────────────────

export const SubagentStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
} as const;

export type SubagentStatus = (typeof SubagentStatus)[keyof typeof SubagentStatus];

/** Chronological, in-memory output emitted by one subagent run. */
export type SubagentLiveSegment =
  | { kind: 'text'; id: string; content: string }
  | { kind: 'thinking'; id: string; content: string }
  | { kind: 'tool'; id: string; toolCallId: string };

/** Current state of a tool, including partially generated arguments. */
export interface SubagentToolSnapshot {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: 'generating' | 'running' | TerminalToolResultStatus;
  readonly partialArgs: string;
  readonly args: string;
  readonly content: string | null;
  readonly toolResult: CanonicalToolResult | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** Runtime-only projection; never serialized into SubagentRecord storage. */
export interface SubagentLiveProjection {
  readonly sessionId: string | null;
  readonly subagentId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly state: SubagentStatus;
  readonly segments: readonly SubagentLiveSegment[];
  readonly toolCalls: readonly SubagentToolSnapshot[];
  readonly usage: Usage | null;
  readonly result: string | null;
  readonly error: string | null;
}

/** Ordered notification emitted whenever a live projection changes. */
export interface SubagentLiveChange {
  readonly sessionId: string | null;
  readonly subagentId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly projection: SubagentLiveProjection;
}

// ── SubagentRecord ──────────────────────────────────────────────────────────

export interface SubagentRecord {
  readonly id: string;
  readonly agent_name: string;
  readonly agent_type: string;
  readonly agent_tier: string;
  readonly task: string;
  readonly status: SubagentStatus;
  readonly chain_id: string;
  readonly start_time: string;
  readonly end_time: string | null;
  readonly result: string | null;
  readonly error: string | null;
  /**
   * Index of the parent session chain this subagent was spawned from
   * (Python `parent_chain_index`). Used to attribute sub token usage
   * to the correct chain footer.
   */
  readonly parentChainIndex: number | null;
  /** The full chain associated with this subagent (persisted). */
  readonly chain: Chain;
}

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const subagentStatusSchema = z.enum([
  SubagentStatus.PENDING,
  SubagentStatus.RUNNING,
  SubagentStatus.COMPLETED,
  SubagentStatus.FAILED,
  SubagentStatus.INTERRUPTED,
]);

export const subagentRecordSchema = z.object({
  id: z.string(),
  agent_name: z.string(),
  agent_type: z.string(),
  agent_tier: z.string(),
  task: z.string(),
  status: subagentStatusSchema,
  chain_id: z.string(),
  start_time: z.string(),
  end_time: z.string().nullable().default(null),
  result: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});

// ── Storage dict ────────────────────────────────────────────────────────────

export interface SubagentRecordStorageDict {
  id: string;
  agent_name?: string;
  agent_type?: string;
  agent_tier?: string;
  task?: string;
  state?: string;
  status?: string;
  chain_id?: string;
  start_time?: string;
  end_time?: string | null;
  result?: string | null;
  error?: string | null;
  parent_chain_index?: number | null;
  parentChainIndex?: number | null;
  chain?: unknown;
  // Forward-compat: extra keys tolerated on restore
  [key: string]: unknown;
}

// ── Serialization ───────────────────────────────────────────────────────────

export function subagentRecordToStorageDict(record: SubagentRecord): SubagentRecordStorageDict {
  return {
    id: record.id,
    agent_name: record.agent_name,
    agent_type: record.agent_type,
    agent_tier: record.agent_tier,
    task: record.task,
    status: record.status,
    chain_id: record.chain_id,
    start_time: record.start_time,
    end_time: record.end_time,
    result: record.result,
    error: record.error,
    parent_chain_index: record.parentChainIndex,
    chain: chainToStorageDict(record.chain),
  };
}

export function subagentRecordFromStorageDict(data: unknown): SubagentRecord {
  const raw = data as Record<string, unknown>;
  const now = new Date().toISOString();

  // Parse status — Python uses 'state' key
  let status: SubagentStatus = SubagentStatus.COMPLETED;
  const rawStatus = (raw.state ?? raw.status) as string | undefined;
  if (
    typeof rawStatus === 'string' &&
    (rawStatus === 'pending' || rawStatus === 'running' ||
      rawStatus === 'completed' || rawStatus === 'failed' ||
      rawStatus === 'interrupted')
  ) {
    status = rawStatus;
  }

  // Migrate PENDING/RUNNING → INTERRUPTED on restore (matching Python)
  const migratedToInterrupted =
    status === SubagentStatus.PENDING || status === SubagentStatus.RUNNING;
  if (migratedToInterrupted) {
    status = SubagentStatus.INTERRUPTED;
  }

  // Parse times
  const startTime = typeof raw.start_time === 'string' ? raw.start_time : now;
  let endTime = typeof raw.end_time === 'string' ? raw.end_time : null;

  // INTERRUPTED records without end_time get end_time set to now (matching Python)
  if (status === SubagentStatus.INTERRUPTED && !endTime) {
    endTime = now;
  }

  // Restore the chain
  let chain: Chain;
  const chainData = raw.chain;
  if (chainData && typeof chainData === 'object') {
    chain = chainFromStorageDict(chainData);
  } else {
    // Legacy fallback: flat messages list
    chain = chainFromStorageDict({ messages: raw.messages ?? [] });
  }

  const chainId = typeof raw.chain_id === 'string' ? raw.chain_id : '';

  // parent_chain_index (Python) / parentChainIndex (TS)
  let parentChainIndex: number | null = null;
  const rawParent = raw.parent_chain_index ?? raw.parentChainIndex;
  if (typeof rawParent === 'number' && Number.isFinite(rawParent)) {
    parentChainIndex = rawParent;
  }

  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    agent_name: typeof raw.agent_name === 'string' ? raw.agent_name : '',
    agent_type: typeof raw.agent_type === 'string' ? raw.agent_type : 'subagent',
    agent_tier: typeof raw.agent_tier === 'string' ? raw.agent_tier : 'bloom',
    task: typeof raw.task === 'string' ? raw.task : '',
    status,
    chain_id: chainId,
    start_time: startTime,
    end_time: endTime,
    result: typeof raw.result === 'string' ? raw.result : null,
    error: typeof raw.error === 'string' ? raw.error : null,
    parentChainIndex,
    chain,
  };
}
