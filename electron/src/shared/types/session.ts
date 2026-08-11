/**
 * Session types for the Orchid domain.
 */

import {
  copyModelSelection,
  modelSelectionSchema,
  type ModelSelection,
} from './provider';
import type { Chain } from './chain';
import type { Message } from './message';
import type { SubagentRecord } from './subagent';
import {
  chainFromStorageDict,
  chainToStorageDict,
  subagentRecordFromStorageDict,
  subagentRecordToStorageDict,
} from '../serialization/chain-subagent';
import type { TodoStoreData } from './todo';
import { todoStoreFromStorageDict, todoStoreToStorageDict } from './todo';
import { PERMISSION_MODE_VALUES, type PermissionMode } from './permission';

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
  /** Per-session service tier override for the active model (R21). */
  readonly tierOverride: string | null;
  readonly permissionMode: PermissionMode | null;
}

/**
 * Session DTO for renderer navigation. Historical subagent transcripts are
 * fetched through the selected-subagent detail endpoint instead.
 */
export function sessionForRenderer(session: Session): Session {
  return session.subagentChains.length === 0
    ? session
    : { ...session, subagentChains: [] };
}

// ── Storage dict ────────────────────────────────────────────────────────────

export interface SessionStorageDict {
  version: number;
  id: string;
  name: string;
  selection?: ModelSelection | null;
  modelLabel?: string | null;
  /** Absolute working directory; missing/null on legacy sessions. */
  cwd?: string | null;
  chains?: unknown[];
  activeChainId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  subagentChains?: unknown[];
  todoStore?: unknown;
  reasoningEffortOverride?: string | number | null;
  tierOverride?: string | null;
  permissionMode?: string | null;
  [key: string]: unknown;
}

// ── Serialization ───────────────────────────────────────────────────────────

export function sessionToStorageDict(session: Session): SessionStorageDict {
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
    subagentChains: session.subagentChains.map(subagentRecordToStorageDict),
    todoStore: todoStoreToStorageDict(session.todoStore),
    reasoningEffortOverride: session.reasoningEffortOverride,
    tierOverride: session.tierOverride,
    permissionMode: session.permissionMode,
  };
}

export function sessionFromStorageDict(data: unknown): Session {
  const raw = data as Record<string, unknown>;
  const parsedSelection = modelSelectionSchema.safeParse(raw.selection);
  const selection: ModelSelection | null =
    parsedSelection.success ? parsedSelection.data : null;
  const modelLabel: string | null =
    typeof raw.modelLabel === 'string' ? raw.modelLabel : null;

  const rawChains = Array.isArray(raw.chains) ? raw.chains : [];
  const chains: Chain[] = [];
  for (let i = 0; i < rawChains.length; i++) {
    try {
      chains.push(chainFromStorageDict(rawChains[i]));
    } catch {
      console.warn(`Failed to restore chain at index ${i}, skipping`);
    }
  }

  const todoStoreData = raw.todoStore ?? {};
  const todoStore = todoStoreFromStorageDict(todoStoreData);

  const rawSubagentChains = raw.subagentChains;
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
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    chains,
    activeChainId:
      typeof raw.activeChainId === 'string' ? raw.activeChainId : null,
    createdAt:
      typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt:
      typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    subagentChains,
    todoStore,
    reasoningEffortOverride:
      typeof raw.reasoningEffortOverride === 'string' ||
      typeof raw.reasoningEffortOverride === 'number'
        ? raw.reasoningEffortOverride
        : null,
    tierOverride:
      typeof raw.tierOverride === 'string' && raw.tierOverride.trim() !== ''
        ? raw.tierOverride
        : null,
    permissionMode: parsePermissionMode(raw.permissionMode),
  };
}

function parsePermissionMode(value: unknown): PermissionMode | null {
  if (typeof value !== 'string') return null;
  return (PERMISSION_MODE_VALUES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : null;
}
