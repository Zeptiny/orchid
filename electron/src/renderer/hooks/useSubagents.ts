/** Session-affine subagent snapshot/live state for the inspector and view. */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Usage } from '../../shared/types/message';
import type { SubagentEvent } from '../../shared/types/ipc';
import type { SubagentLiveProjection, SubagentRecord } from '../../shared/types/subagent';
import { sumSubagentUsage, sumSubagentsUsage, subUsageByParentChain } from '../../shared/usage';
import {
  acceptSubagentEvent,
  beginSubagentSnapshotRefresh,
  bindSubagentSession,
  createSubagentStreamState,
  failSubagentSnapshot,
  groupSubagents,
  isSubagentSnapshotAffine,
  replaceSubagentRecords,
  resolveSubagentSelection,
  seedSubagentSnapshot,
  type SubagentStreamState,
} from '../utils/subagent-stream';

export type SubagentListState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; subagents: readonly SubagentRecord[] }
  | { status: 'error'; error: string };

export interface SubagentDetail {
  readonly id: string; readonly name: string; readonly type: string; readonly tier: string;
  readonly state: string; readonly task: string; readonly elapsed: string; readonly isRunning: boolean;
  readonly result: string | null; readonly error: string | null; readonly usage: Usage | null;
}

export interface SubagentTranscript {
  readonly messages: readonly unknown[];
  readonly liveTail: readonly SubagentLiveProjection['segments'][number][];
}

export interface UseSubagentsReturn {
  state: SubagentListState;
  subagents: readonly SubagentRecord[];
  groups: { running: readonly SubagentRecord[]; ended: readonly SubagentRecord[] };
  totalUsage: Usage | null;
  usageByParentChain: ReadonlyMap<number, Usage>;
  refresh: () => Promise<void>;
  retry: () => Promise<void>;
  isRetrying: boolean;
  applyFromSession: (subagents: readonly SubagentRecord[]) => void;
  selectedId: string | null;
  select: (id: string | null) => void;
  getDetail: (id: string) => SubagentDetail | null;
  live: ReadonlyMap<string, SubagentLiveProjection>;
  getLive: (id: string) => SubagentLiveProjection | null;
  getTranscript: (id: string) => SubagentTranscript | null;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function buildDetail(record: SubagentRecord, now: number): SubagentDetail {
  const start = Date.parse(record.start_time);
  const end = record.end_time ? Date.parse(record.end_time) : now;
  const running = record.status === 'running' || record.status === 'pending';
  return {
    id: record.id, name: record.agent_name || 'Subagent', type: record.agent_type || 'subagent',
    tier: record.agent_tier || 'bloom', state: record.status, task: record.task || '',
    elapsed: formatElapsed(Math.max(0, end - start)), isRunning: running,
    result: record.result, error: record.error, usage: sumSubagentUsage(record),
  };
}

function listState(stream: SubagentStreamState): SubagentListState {
  if (stream.hydration === 'error') return { status: 'error', error: stream.error ?? 'Unable to load subagents' };
  if (stream.hydration === 'loading' && stream.records.length === 0) return { status: 'loading' };
  return stream.records.length ? { status: 'ready', subagents: stream.records } : { status: 'empty' };
}

export function useSubagents(activeSessionId: string | null): UseSubagentsReturn {
  const streamRef = useRef<SubagentStreamState>(createSubagentStreamState());
  const [stream, setStream] = useState(streamRef.current);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const requestRef = useRef(0);
  const requestedRef = useRef<string | null>(null);
  const selectedSessionRef = useRef<string | null>(null);
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  requestedRef.current = requestedId;
  selectedSessionRef.current = selectedSessionId;

  // Render-time binding closes the session-switch race before effects run.
  if (streamRef.current.sessionId !== activeSessionId) {
    streamRef.current = bindSubagentSession(streamRef.current, activeSessionId);
  }
  const current = streamRef.current.sessionId === activeSessionId ? streamRef.current : stream;

  const commit = useCallback((next: SubagentStreamState) => {
    streamRef.current = next;
    setStream(next);
  }, []);

  const hydrate = useCallback(async (sessionId: string, retry = false): Promise<void> => {
    const request = ++requestRef.current;
    const refreshed = beginSubagentSnapshotRefresh(streamRef.current, sessionId);
    commit(refreshed);
    const generation = refreshed.generation;
    if (!window.orchid?.subagents?.snapshot) {
      if (activeRef.current === sessionId && streamRef.current.generation === generation) commit(failSubagentSnapshot(streamRef.current, 'Subagent snapshot is unavailable'));
      return;
    }
    if (retry) setIsRetrying(true);
    try {
      const snapshot = await window.orchid.subagents.snapshot({ sessionId });
      if (request !== requestRef.current || activeRef.current !== sessionId || !isSubagentSnapshotAffine(streamRef.current, snapshot, generation)) return;
      const next = seedSubagentSnapshot(streamRef.current, snapshot);
      commit(next);
      setSelectedId((previous) => resolveSubagentSelection(next.records, {
        sessionId, requestedId: requestedRef.current ?? previous, existingId: previous, existingSessionId: selectedSessionRef.current,
      }));
      setSelectedSessionId(sessionId);
    } catch (error) {
      if (request === requestRef.current && activeRef.current === sessionId && streamRef.current.generation === generation) {
        commit(failSubagentSnapshot(streamRef.current, error instanceof Error ? error.message : String(error)));
      }
    } finally {
      if (request === requestRef.current) setIsRetrying(false);
    }
  }, [commit]);

  useEffect(() => {
    setSelectedId(null);
    setSelectedSessionId(activeSessionId);
    setRequestedId(null);
    if (activeSessionId) void hydrate(activeSessionId);
  }, [activeSessionId, hydrate]);

  useEffect(() => {
    const unsubscribe = window.orchid?.subagents?.onEvent?.((event: SubagentEvent) => {
      const next = acceptSubagentEvent(streamRef.current, event);
      if (next !== streamRef.current) commit(next);
    });
    return unsubscribe;
  }, [commit]);

  useEffect(() => {
    const unsubscribe = window.orchid?.session?.onSubagentsChanged?.(() => {
      if (activeRef.current) void hydrate(activeRef.current);
    });
    return unsubscribe;
  }, [hydrate]);

  useEffect(() => {
    if (!current.records.some((record) => record.status === 'running' || record.status === 'pending')) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [current.records]);

  const refresh = useCallback(async () => {
    if (!activeRef.current) {
      commit(bindSubagentSession(streamRef.current, null));
      return;
    }
    await hydrate(activeRef.current);
  }, [commit, hydrate]);

  const retry = useCallback(async () => {
    if (!activeRef.current) return;
    await hydrate(activeRef.current, true);
  }, [commit, hydrate]);

  const applyFromSession = useCallback((records: readonly SubagentRecord[]) => {
    commit(replaceSubagentRecords(streamRef.current, records));
  }, [commit]);

  const select = useCallback((id: string | null) => {
    setRequestedId(id);
    setSelectedId((previous) => previous === id ? null : id);
    setSelectedSessionId(activeRef.current);
  }, []);

  const subagents = current.records;
  const state = listState(current);
  const groups = useMemo(() => groupSubagents(subagents), [subagents]);
  const totalUsage = useMemo(() => sumSubagentsUsage(subagents), [subagents]);
  const usageByParentChain = useMemo(() => subUsageByParentChain(subagents), [subagents]);
  const getDetail = useCallback((id: string) => {
    void tick;
    const record = subagents.find((item) => item.id === id);
    return record ? buildDetail(record, Date.now()) : null;
  }, [subagents, tick]);
  const getLive = useCallback((id: string) => current.live.get(id) ?? null, [current.live]);
  const getTranscript = useCallback((id: string): SubagentTranscript | null => {
    const record = subagents.find((item) => item.id === id);
    if (!record) return null;
    return { messages: record.chain.messages, liveTail: current.live.get(id)?.segments ?? [] };
  }, [subagents, current.live]);

  return {
    state, subagents, groups, totalUsage, usageByParentChain, refresh, retry, isRetrying,
    applyFromSession, selectedId, select, getDetail, live: current.live, getLive, getTranscript,
  };
}
