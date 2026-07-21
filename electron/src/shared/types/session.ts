/**
 * Session types for the Orchid domain.
 *
 * Ported from src/orchid/domain/session.py.
 *
 * Differences from Python:
 * - Timestamps are ISO strings (createdAt/updatedAt) instead of
 *   monotonic floats (Python's start_time/end_time).
 * - No SubagentManager or TodoStore runtime objects on the Session
 *   interface — those are runtime-only. The session stores
 *   subagentChains (SubagentRecord[]) and todoStore (TodoStoreData)
 *   for persistence.
 * - Version 2 JSON stores a connection-scoped model selection plus a
 *   display-only model label. Version 1 string model aliases remain readable
 *   as historical labels, never as executable selections.
 */

import {
  copyModelSelection,
  modelSelectionSchema,
  type ModelSelection,
} from './provider';
import type { Chain } from './chain';
import { chainFromStorageDict, chainToStorageDict } from './chain';
import type { Message } from './message';
import type { SubagentRecord } from './subagent';
import { subagentRecordFromStorageDict, subagentRecordToStorageDict } from './subagent';
import type { TodoStoreData } from './todo';
import { todoStoreFromStorageDict, todoStoreToStorageDict } from './todo';

// ── Session ─────────────────────────────────────────────────────────────────

/** Flatten all chain messages for UI + continue-chat history (chronological). */
export function flattenSessionMessages(session: Session): Message[] {
  return session.chains.flatMap((chain) => [...chain.messages]);
}

export interface Session {
  readonly id: string;
  readonly name: string;
  /** Executable model identity, scoped to one provider connection. */
  readonly selection: ModelSelection | null;
  /** Historical/display snapshot only; never used to resolve a model. */
  readonly modelLabel: string | null;
  /**
   * Absolute working/project directory for this session.
   * `null` = unbound (legacy sessions without cwd, or intentionally unbound).
   */
  readonly cwd: string | null;
  readonly chains: readonly Chain[];
  readonly activeChainId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly subagentChains: readonly SubagentRecord[];
  readonly todoStore: TodoStoreData;
  readonly reasoningEffortOverride: string | number | null;
}

// ── Storage dict ────────────────────────────────────────────────────────────

export interface SessionStorageDict {
  version: number;
  id: string;
  name: string;
  selection?: ModelSelection | null;
  modelLabel?: string | null;
  /** Version 1 only: preserved as a historical label on restore. */
  model?: string;
  /** Absolute working directory; missing/null on legacy sessions. */
  cwd?: string | null;
  chains?: unknown[];
  activeChainId?: string | null;
  active_chain_id?: string | null;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  subagent_chains?: unknown[];
  subagentChains?: unknown[];
  todo_store?: unknown;
  todoStore?: unknown;
  reasoningEffortOverride?: string | number | null;
  // Forward-compat: extra keys tolerated on restore
  [key: string]: unknown;
}

// ── Serialization ───────────────────────────────────────────────────────────

export function sessionToStorageDict(session: Session): SessionStorageDict {
  // Serialize selection/label/cwd near the top so partial list reads
  // can extract it without a full JSON parse.
  return {
    version: 2,
    id: session.id,
    name: session.name,
    selection: copyModelSelection(session.selection),
    modelLabel: session.modelLabel ?? null,
    cwd: session.cwd,
    chains: session.chains.map(chainToStorageDict),
    activeChainId: session.activeChainId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    subagent_chains: session.subagentChains.map(subagentRecordToStorageDict),
    todo_store: todoStoreToStorageDict(session.todoStore),
    reasoningEffortOverride: session.reasoningEffortOverride,
  };
}

export function sessionFromStorageDict(data: unknown): Session {
  const raw = data as Record<string, unknown>;
  const isLegacyV1 = typeof raw.version !== 'number' || raw.version < 2;
  const parsedSelection = modelSelectionSchema.safeParse(raw.selection);
  // A v1 `model` string is a historical display snapshot only. Do not turn it
  // back into an executable selection: it lacks the required connection ID.
  const selection: ModelSelection | null =
    !isLegacyV1 && parsedSelection.success ? parsedSelection.data : null;
  const modelLabel: string | null = isLegacyV1
    ? typeof raw.model === 'string'
      ? raw.model
      : null
    : typeof raw.modelLabel === 'string'
      ? raw.modelLabel
      : null;

  // Parse chains with per-chain error isolation (matching Python)
  const rawChains = Array.isArray(raw.chains) ? raw.chains : [];
  const chains: Chain[] = [];
  for (let i = 0; i < rawChains.length; i++) {
    try {
      chains.push(chainFromStorageDict(rawChains[i]));
    } catch {
      // Per-chain error isolation: other chains survive
      console.warn(`Failed to restore chain at index ${i}, skipping`);
    }
  }

  // Parse todo store
  const todoStoreData = raw.todo_store ?? raw.todoStore ?? {};
  const todoStore = todoStoreFromStorageDict(todoStoreData);

  // Parse subagent chains
  const rawSubagentChains = raw.subagent_chains ?? raw.subagentChains;
  const subagentChains: SubagentRecord[] = [];
  if (Array.isArray(rawSubagentChains)) {
    for (const sd of rawSubagentChains) {
      try {
        subagentChains.push(subagentRecordFromStorageDict(sd));
      } catch {
        console.warn('Failed to restore subagent record, skipping');
      }
    }
  }

  const now = new Date().toISOString();

  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : 'Unnamed',
    selection,
    modelLabel,
    // Legacy sessions without cwd → null (R9); never invent process.cwd().
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    chains,
    activeChainId:
      typeof raw.activeChainId === 'string'
        ? raw.activeChainId
        : typeof raw.active_chain_id === 'string'
          ? raw.active_chain_id
          : null,
    createdAt:
      typeof raw.createdAt === 'string'
        ? raw.createdAt
        : typeof raw.created_at === 'string'
          ? raw.created_at
          : now,
    updatedAt:
      typeof raw.updatedAt === 'string'
        ? raw.updatedAt
        : typeof raw.updated_at === 'string'
          ? raw.updated_at
          : now,
    subagentChains,
    todoStore,
    reasoningEffortOverride:
      typeof raw.reasoningEffortOverride === 'string' ||
      typeof raw.reasoningEffortOverride === 'number'
        ? raw.reasoningEffortOverride
        : null,
  };
}
