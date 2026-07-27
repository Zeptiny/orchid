import type { SubagentSnapshot } from '../../shared/types/ipc';
import type {
  LegacySubagentEvent,
  SubagentLiveProjection,
  SubagentRecord,
  SubagentStatus,
} from '../../shared/types/subagent';

export type SubagentHydrationState = 'loading' | 'ready' | 'empty' | 'error';

export interface SubagentStreamState {
  readonly sessionId: string | null;
  readonly hydration: SubagentHydrationState;
  readonly records: readonly SubagentRecord[];
  readonly live: ReadonlyMap<string, SubagentLiveProjection>;
  readonly highWater: ReadonlyMap<string, number>;
  readonly runs: ReadonlyMap<string, string>;
  readonly buffered: readonly LegacySubagentEvent[];
  readonly error: string | null;
  readonly generation: number;
}

const isRunning = (status: SubagentStatus): boolean =>
  status === 'pending' || status === 'running';

function compareNewest(a: SubagentRecord, b: SubagentRecord): number {
  const time = Date.parse(b.start_time) - Date.parse(a.start_time);
  return time || b.id.localeCompare(a.id);
}

export function createSubagentStreamState(): SubagentStreamState {
  return {
    sessionId: null,
    hydration: 'empty',
    records: [],
    live: new Map(),
    highWater: new Map(),
    runs: new Map(),
    buffered: [],
    error: null,
    generation: 0,
  };
}

/** Rebind before IPC hydration starts; this synchronously removes old-session data. */
export function bindSubagentSession(
  state: SubagentStreamState,
  sessionId: string | null,
): SubagentStreamState {
  if (state.sessionId === sessionId && state.hydration === 'loading') return state;
  return {
    sessionId,
    hydration: sessionId ? 'loading' : 'empty',
    records: [],
    live: new Map(),
    highWater: new Map(),
    runs: new Map(),
    buffered: [],
    error: null,
    generation: state.generation + 1,
  };
}

/**
 * Start another snapshot for the already-bound session without clearing its
 * visible data. The generation change supersedes every older response while
 * loading makes intervening events replayable after the new snapshot seeds.
 */
export function beginSubagentSnapshotRefresh(
  state: SubagentStreamState,
  sessionId: string,
): SubagentStreamState {
  if (state.sessionId !== sessionId) return bindSubagentSession(state, sessionId);
  return {
    ...state,
    hydration: 'loading',
    buffered: [...state.buffered],
    error: null,
    generation: state.generation + 1,
  };
}

/** Guard a response from a previous hydration/retry attempt. */
export function isSubagentSnapshotAffine(
  state: Pick<SubagentStreamState, 'sessionId' | 'generation' | 'hydration'>,
  snapshot: Pick<SubagentSnapshot, 'sessionId'>,
  expectedGeneration: number,
): boolean {
  return state.hydration === 'loading' &&
    state.sessionId === snapshot.sessionId &&
    state.generation === expectedGeneration;
}

export interface SubagentSelectionOptions {
  sessionId: string | null;
  requestedId?: string | null;
  existingId?: string | null;
  existingSessionId?: string | null;
}

export function groupSubagents(records: readonly SubagentRecord[]): {
  running: readonly SubagentRecord[];
  ended: readonly SubagentRecord[];
} {
  const sorted = [...records].sort(compareNewest);
  return {
    running: sorted.filter((record) => isRunning(record.status)),
    ended: sorted.filter((record) => !isRunning(record.status)),
  };
}

export function resolveSubagentSelection(
  records: readonly SubagentRecord[],
  options: SubagentSelectionOptions,
): string | null {
  const ids = new Set(records.map((record) => record.id));
  if (options.requestedId && ids.has(options.requestedId)) return options.requestedId;
  if (
    options.existingId &&
    options.existingSessionId === options.sessionId &&
    ids.has(options.existingId)
  ) return options.existingId;
  return null;
}

function recordWithProjection(record: SubagentRecord, projection: SubagentLiveProjection): SubagentRecord {
  const status = projection.state;
  return {
    ...record,
    status,
    result: projection.result ?? record.result,
    error: projection.error ?? record.error,
    end_time: isRunning(status) ? record.end_time : (record.end_time ?? new Date().toISOString()),
  };
}

function applyEvent(state: SubagentStreamState, event: LegacySubagentEvent): SubagentStreamState {
  if (state.sessionId !== event.sessionId || event.projection.sessionId && event.projection.sessionId !== event.sessionId) {
    return state;
  }
  const knownRun = state.runs.get(event.subagentId);
  const lastSequence = state.highWater.get(event.subagentId);
  if ((!knownRun || lastSequence === undefined) && !event.record) return state;
  if (knownRun && (knownRun !== event.runId || event.sequence <= (lastSequence ?? -1))) return state;
  if (!knownRun && event.record?.id !== event.subagentId) return state;

  const seededRuns = new Map(state.runs);
  seededRuns.set(event.subagentId, event.runId);
  const seededRecords = knownRun || !event.record
    ? state.records
    : [...state.records, event.record];
  const highWater = new Map(state.highWater).set(event.subagentId, event.sequence);
  const live = new Map(state.live);
  const records = seededRecords.map((record) =>
    record.id === event.subagentId
      ? recordWithProjection(event.record ?? record, event.projection)
      : record,
  );
  if (isRunning(event.projection.state)) live.set(event.subagentId, event.projection);
  else live.delete(event.subagentId);
  return { ...state, records, live, highWater, runs: seededRuns };
}

/** Accept one event, or retain it for replay after snapshot seeding. */
export function acceptSubagentEvent(
  state: SubagentStreamState,
  event: LegacySubagentEvent,
): SubagentStreamState {
  if (state.sessionId !== event.sessionId) return state;
  if (state.hydration === 'loading') {
    return state.buffered.some((item) => item.subagentId === event.subagentId && item.runId === event.runId && item.sequence === event.sequence)
      ? state
      : { ...state, buffered: [...state.buffered, event] };
  }
  return applyEvent(state, event);
}

function seedSnapshotNow(state: SubagentStreamState, snapshot: SubagentSnapshot): SubagentStreamState {
  const live = new Map<string, SubagentLiveProjection>();
  const highWater = new Map<string, number>();
  const runs = new Map<string, string>();
  for (const projection of snapshot.live) {
    if (projection.sessionId && projection.sessionId !== snapshot.sessionId) continue;
    runs.set(projection.subagentId, projection.runId);
    highWater.set(projection.subagentId, projection.sequence);
    if (isRunning(projection.state)) live.set(projection.subagentId, projection);
  }
  return {
    ...state,
    hydration: snapshot.records.length ? 'ready' : 'empty',
    records: [...snapshot.records].sort(compareNewest),
    live,
    highWater,
    runs,
    buffered: [],
    error: null,
  };
}

/** Seed high-water marks, then replay only newer buffered events for this session. */
export function seedSubagentSnapshot(
  state: SubagentStreamState,
  snapshot: SubagentSnapshot,
): SubagentStreamState {
  if (state.sessionId !== snapshot.sessionId || state.hydration !== 'loading') return state;
  let next = seedSnapshotNow(state, snapshot);
  const buffered = [...state.buffered].sort((a, b) => a.sequence - b.sequence);
  for (const event of buffered) next = applyEvent(next, event);
  return next;
}

export function failSubagentSnapshot(state: SubagentStreamState, error: string): SubagentStreamState {
  return { ...state, hydration: 'error', error, buffered: [] };
}

/** Apply session-loaded durable records without disturbing a live projection. */
export function replaceSubagentRecords(
  state: SubagentStreamState,
  records: readonly SubagentRecord[],
): SubagentStreamState {
  // ChatView may hand us the session-load result while the richer snapshot is
  // still in flight. Keep loading affinity intact so the response can seed
  // high-water marks and replay buffered events over these durable records.
  return {
    ...state,
    records: [...records].sort(compareNewest),
    hydration: state.hydration === 'loading' ? 'loading' : records.length ? 'ready' : 'empty',
  };
}
