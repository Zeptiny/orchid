/**
 * SubagentRecord types for the Orchid domain.
 *
 * Key restore behavior:
 * - fromStorageDict() migrates PENDING/RUNNING → INTERRUPTED
 * - INTERRUPTED records without end_time get end_time set to now
 */

import { z } from 'zod';
import type { Chain } from './chain';
import type { Usage } from './message';
import { sumMessageUsages } from '../usage';
import type {
  CanonicalToolResult,
  TerminalToolResultStatus,
} from './tool-result';

// ── Enums as const objects ──────────────────────────────────────────────────

export const SubagentStatus = {
  /** Parked in the admission queue; runtime-only, never persisted. */
  QUEUED: 'queued',
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

// ── Live delta events ───────────────────────────────────────────────────────

/**
 * Delta-event taxonomy for subagent live updates. Replaces per-change full
 * `SubagentLiveProjection` broadcasts with incremental typed deltas, batched
 * into one `SubagentEvent` envelope per IPC flush (see `shared/types/ipc.ts`).
 */
export const SubagentDeltaEventType = {
  SPAWNED: 'spawned',
  STATUS_CHANGED: 'status_changed',
  TEXT_DELTA: 'text_delta',
  THINKING_DELTA: 'thinking_delta',
  TOOL_START: 'tool_start',
  TOOL_ARGS_DELTA: 'tool_args_delta',
  TOOL_RESULT: 'tool_result',
  USAGE: 'usage',
  TERMINAL: 'terminal',
} as const;

export type SubagentDeltaEventType = (typeof SubagentDeltaEventType)[keyof typeof SubagentDeltaEventType];

/** Terminal states a subagent run can settle into (subset of SubagentStatus). */
export type SubagentTerminalState =
  | typeof SubagentStatus.COMPLETED
  | typeof SubagentStatus.FAILED
  | typeof SubagentStatus.INTERRUPTED;

/**
 * Identity and ordering fields carried by every live delta event.
 *
 * `sequence` is monotonic per run (the renderer drops regressions);
 * `sessionRevision` comes from the manager's per-session counter and is the
 * single freshness primitive for events, snapshots, and reseed floors.
 */
export interface SubagentDeltaEventBase {
  readonly sessionId: string;
  readonly subagentId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly sessionRevision: number;
}

/**
 * Lightweight row seed emitted once at spawn. One of only two summary
 * carriers (the other is `terminal`), so transcript data stays off this wire.
 */
export interface SubagentSpawnedEvent extends SubagentDeltaEventBase {
  readonly type: typeof SubagentDeltaEventType.SPAWNED;
  readonly record: SubagentSummary;
  readonly usage: Usage | null;
}

/**
 * Non-terminal status transition (queued→pending→running). Carries only the
 * new status so the renderer can update its durable record without a snapshot.
 */
export interface SubagentStatusChangedEvent extends SubagentDeltaEventBase {
  readonly type: typeof SubagentDeltaEventType.STATUS_CHANGED;
  readonly status: SubagentStatus;
}

/** Append to a text live segment (`SubagentLiveSegment` kind `text`). */
export interface SubagentTextDeltaEvent extends SubagentDeltaEventBase {
  readonly type: typeof SubagentDeltaEventType.TEXT_DELTA;
  readonly segmentId: string;
  readonly append: string;
}

/** Append to a thinking live segment (`SubagentLiveSegment` kind `thinking`). */
export interface SubagentThinkingDeltaEvent extends SubagentDeltaEventBase {
  readonly type: typeof SubagentDeltaEventType.THINKING_DELTA;
  readonly segmentId: string;
  readonly append: string;
}

/**
 * Tool snapshot upsert; field names mirror `SubagentToolSnapshot`. The first
 * emission for a `toolCallId` creates the tool entry and its `tool` live
 * segment; a later `running` emission delivers the finalized args.
 */
export interface SubagentToolStartEvent extends SubagentDeltaEventBase {
  readonly type: typeof SubagentDeltaEventType.TOOL_START;
  /** Identity of the tool's `SubagentLiveSegment` (kind `tool`). */
  readonly segmentId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: 'generating' | 'running';
  /** Finalized args JSON once `status` is `running`; empty while generating. */
  readonly args: string;
  readonly startedAt: string;
}

/** Append streamed tool-call input to `SubagentToolSnapshot.partialArgs`. */
export interface SubagentToolArgsDeltaEvent extends SubagentDeltaEventBase {
  readonly type: typeof SubagentDeltaEventType.TOOL_ARGS_DELTA;
  readonly toolCallId: string;
  readonly append: string;
}

/**
 * Terminal tool update; field names mirror the terminal `SubagentToolSnapshot`
 * patch. `content` is the agent projection bounded by the tool-output offload
 * layer; `toolResult` is the canonical terminal authority.
 */
export interface SubagentToolResultEvent extends SubagentDeltaEventBase {
  readonly type: typeof SubagentDeltaEventType.TOOL_RESULT;
  readonly toolCallId: string;
  readonly status: TerminalToolResultStatus;
  readonly content: string;
  readonly toolResult: CanonicalToolResult;
  readonly finishedAt: string;
}

/** Cumulative usage, emitted at the usage cadence — not per provider event. */
export interface SubagentUsageEvent extends SubagentDeltaEventBase {
  readonly type: typeof SubagentDeltaEventType.USAGE;
  readonly usage: Usage;
}

/**
 * Authoritative list handoff emitted once when the run settles. Carries the
 * final summary so no post-terminal snapshot is required.
 */
export interface SubagentTerminalEvent extends SubagentDeltaEventBase {
  readonly type: typeof SubagentDeltaEventType.TERMINAL;
  readonly record: SubagentSummary;
  readonly state: SubagentTerminalState;
  readonly usage: Usage | null;
}

/** Typed incremental subagent live update; the unit of the live protocol. */
export type SubagentDeltaEvent =
  | SubagentSpawnedEvent
  | SubagentStatusChangedEvent
  | SubagentTextDeltaEvent
  | SubagentThinkingDeltaEvent
  | SubagentToolStartEvent
  | SubagentToolArgsDeltaEvent
  | SubagentToolResultEvent
  | SubagentUsageEvent
  | SubagentTerminalEvent;

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
   * Index of the parent session chain this subagent was spawned from.
   * Used to attribute sub token usage to the correct chain footer.
   */
  readonly parentChainIndex: number | null;
  /**
   * Resolved reasoning effort for this subagent's turn (agent field → tier
   * config → connection default). Undefined when the model lacks reasoning.
   */
  readonly reasoning_effort?: string | number;
  /**
   * Hidden from the dynamic system prompt while the durable record, chain,
   * and terminal state stay intact. Missing on old rows (treated as false).
   */
  readonly closed: boolean;
  /** The full chain associated with this subagent (persisted). */
  readonly chain: Chain;
}

/**
 * Lightweight renderer list row. Full transcripts remain in SubagentRecord
 * and cross IPC only through the selected-record detail request.
 */
export interface SubagentSummary {
  readonly id: string;
  readonly agent_name: string;
  readonly agent_type: string;
  readonly agent_tier: string;
  readonly agentRole: string;
  readonly task: string;
  readonly status: SubagentStatus;
  readonly chain_id: string;
  readonly start_time: string;
  readonly end_time: string | null;
  readonly parentChainIndex: number | null;
  readonly usage: Usage | null;
}

/** Collapse a durable record into the bounded list/delta wire representation. */
export function summarizeSubagentRecord(record: SubagentRecord): SubagentSummary {
  return {
    id: record.id,
    agent_name: record.agent_name,
    agent_type: record.agent_type,
    agent_tier: record.agent_tier,
    agentRole: record.chain.agentName,
    task: record.task,
    status: record.status,
    chain_id: record.chain_id,
    start_time: record.start_time,
    end_time: record.end_time,
    parentChainIndex: record.parentChainIndex,
    usage: sumMessageUsages(record.chain.messages),
  };
}

// ── Wire size estimation ────────────────────────────────────────────────────

/**
 * Coarse per-result constant so a canonical `toolResult` payload contributes
 * to the byte budget without a per-event JSON.stringify. Covers the envelope
 * fields and bounded structured data the offload layer leaves inline.
 */
const TOOL_RESULT_PAYLOAD_PROXY_BYTES = 256;

function estimateSummaryBytes(record: SubagentSummary): number {
  return record.id.length + record.agent_name.length + record.agent_type.length
    + record.agent_tier.length + record.agentRole.length + record.task.length;
}

/**
 * Cheap serialized-length estimate for a delta payload: the sum of its
 * string-field lengths, never a per-event JSON.stringify. Used by the main
 * batcher's per-flush budget and the renderer's hydration buffer bound.
 */
export function estimateDeltaBytes(event: SubagentDeltaEvent): number {
  let bytes = event.sessionId.length + event.subagentId.length + event.runId.length + event.type.length;
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta':
      bytes += event.segmentId.length + event.append.length;
      break;
    case 'tool_start':
      bytes += event.segmentId.length + event.toolCallId.length + event.toolName.length
        + event.args.length + event.startedAt.length;
      break;
    case 'tool_args_delta':
      bytes += event.toolCallId.length + event.append.length;
      break;
    case 'tool_result':
      bytes += event.toolCallId.length + event.content.length + event.finishedAt.length;
      // Cheap proxy for the canonical payload (no JSON.stringify): status +
      // the error message when present, plus a coarse constant for the
      // bounded structured data the offload layer leaves inline.
      bytes += event.toolResult.status.length
        + (event.toolResult.status === 'error' ? event.toolResult.error.message.length : 0)
        + TOOL_RESULT_PAYLOAD_PROXY_BYTES;
      break;
    case 'spawned':
    case 'terminal':
      bytes += estimateSummaryBytes(event.record);
      break;
    case 'status_changed':
      bytes += event.status.length;
      break;
    case 'usage':
      break;
  }
  return bytes;
}

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const subagentStatusSchema = z.enum([
  SubagentStatus.QUEUED,
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
  reasoning_effort: z.union([z.string(), z.number()]).optional(),
  closed: z.boolean().default(false),
});

// ── Storage dict ────────────────────────────────────────────────────────────

export interface SubagentRecordStorageDict {
  id: string;
  agent_name?: string;
  agent_type?: string;
  agent_tier?: string;
  task?: string;
  status?: string;
  chain_id?: string;
  start_time?: string;
  end_time?: string | null;
  result?: string | null;
  error?: string | null;
  parentChainIndex?: number | null;
  reasoning_effort?: string | number;
  closed?: boolean;
  chain?: unknown;
  [key: string]: unknown;
}
