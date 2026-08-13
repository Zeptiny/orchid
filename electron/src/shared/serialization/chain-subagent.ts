/**
 * Storage conversion for the mutually recursive Chain and SubagentRecord
 * domain models. Kept outside their type modules so they retain type-only
 * cross-references at runtime.
 */

import {
  copyModelSelection,
  modelSelectionSchema,
  type ModelSelection,
} from '../types/provider';
import {
  messageFromStorageDict,
  messageToStorageDict,
} from '../types/message';
import {
  ChainStatus,
  parseChainStatus,
  reconcileOrphanToolResults,
  type Chain,
  type ChainStorageDict,
} from '../types/chain';
import {
  SubagentStatus,
  subagentStatusSchema,
  type SubagentRecord,
  type SubagentRecordStorageDict,
} from '../types/subagent';

/** Convert a chain to its durable storage representation. */
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
  if (chain.errorDetail) dict.errorDetail = chain.errorDetail;
  if (chain.errorTitle) dict.errorTitle = chain.errorTitle;
  return dict;
}

/** Restore a chain from its durable storage representation. */
export function chainFromStorageDict(data: unknown): Chain {
  const raw = data as Record<string, unknown>;
  const parsedSelection = modelSelectionSchema.safeParse(raw.selection);
  const selection: ModelSelection | null = parsedSelection.success ? parsedSelection.data : null;
  const modelLabel: string | null =
    typeof raw.modelLabel === 'string' ? raw.modelLabel : null;

  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  const messages = reconcileOrphanToolResults(
    rawMessages.map((message) => messageFromStorageDict(message)),
  );

  let status = parseChainStatus(raw.status);

  let subagentRecord: SubagentRecord | null = null;
  const subagentRecordData = raw.subagentRecord;
  if (subagentRecordData && typeof subagentRecordData === 'object') {
    subagentRecord = subagentRecordFromStorageDict(subagentRecordData);
  }

  const startTime = parseNonEmptyString(raw.startTime);
  let endTime = parseNonEmptyString(raw.endTime);

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
    errorDetail: typeof raw.errorDetail === 'string' ? raw.errorDetail : null,
    errorTitle: typeof raw.errorTitle === 'string' ? raw.errorTitle : null,
  };
}

/** Convert a subagent record to its durable storage representation. */
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
    parentChainIndex: record.parentChainIndex,
    ...(record.reasoning_effort !== undefined
      && (typeof record.reasoning_effort !== 'number' || Number.isFinite(record.reasoning_effort))
      ? { reasoning_effort: record.reasoning_effort }
      : {}),
    closed: record.closed,
    chain: chainToStorageDict(record.chain),
  };
}

/** Restore a subagent record from its durable storage representation. */
export function subagentRecordFromStorageDict(data: unknown): SubagentRecord {
  const raw = data as Record<string, unknown>;
  const now = new Date().toISOString();

  const parsedStatus = subagentStatusSchema.safeParse(raw.status);
  let status: SubagentStatus = parsedStatus.success
    ? parsedStatus.data
    : SubagentStatus.COMPLETED;

  if (
    status === SubagentStatus.QUEUED
    || status === SubagentStatus.PENDING
    || status === SubagentStatus.RUNNING
  ) {
    status = SubagentStatus.INTERRUPTED;
  }

  const startTime = typeof raw.start_time === 'string' ? raw.start_time : now;
  let endTime = typeof raw.end_time === 'string' ? raw.end_time : null;
  if (status === SubagentStatus.INTERRUPTED && !endTime) {
    endTime = now;
  }

  const chainData = raw.chain;
  const chain = chainData && typeof chainData === 'object'
    ? chainFromStorageDict(chainData)
    : chainFromStorageDict({ messages: [] });

  let parentChainIndex: number | null = null;
  const rawParent = raw.parentChainIndex;
  if (typeof rawParent === 'number' && Number.isFinite(rawParent)) {
    parentChainIndex = rawParent;
  }

  let reasoningEffort: string | number | undefined;
  const rawEffort = raw.reasoning_effort;
  if (
    typeof rawEffort === 'string'
    || (typeof rawEffort === 'number' && Number.isFinite(rawEffort))
  ) {
    reasoningEffort = rawEffort;
  }

  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    agent_name: typeof raw.agent_name === 'string' ? raw.agent_name : '',
    agent_type: typeof raw.agent_type === 'string' ? raw.agent_type : 'subagent',
    agent_tier: typeof raw.agent_tier === 'string' ? raw.agent_tier : 'bloom',
    task: typeof raw.task === 'string' ? raw.task : '',
    status,
    chain_id: typeof raw.chain_id === 'string' ? raw.chain_id : '',
    start_time: startTime,
    end_time: endTime,
    result: typeof raw.result === 'string' ? raw.result : null,
    error: typeof raw.error === 'string' ? raw.error : null,
    parentChainIndex,
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    closed: raw.closed === true,
    chain,
  };
}

function parseNonEmptyString(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}
