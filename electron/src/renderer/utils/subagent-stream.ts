import type { SubagentEvent, SubagentSnapshot } from '../../shared/types/ipc';
import type {
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
  readonly buffered: readonly SubagentEvent[];
  readonly error: string | null;
  readonly generation: number;
  readonly liveTail: (id: string) => readonly SubagentLiveProjection['segments'][number][];
}

const isRunning = (status: SubagentStatus): boolean =>
  status === 'pending' || status === 'running';

function compareNewest(a: SubagentRecord, b: SubagentRecord): number {
  const time = Date.parse(b.start_time) - Date.parse(a.start_time);
  return time || b.id.localeCompare(a.id);
}

function withTail(state: Omit<SubagentStreamState, 'liveTail'>): SubagentStreamState {
  return {
    ...state,
    liveTail: (id: string) => state.live.get(id)?.segments ?? [],
  };
}

export function createSubagentStreamState(): SubagentStreamState {
  return withTail({
    sessionId: null,
    hydration: 'empty',
    records: [],
    live: new Map(),
    highWater: new Map(),
    runs: new Map(),
    buffered: [],
    error: null,
    generation: 0,
  });
}

/** Rebind before IPC hydration starts; this synchronously removes old-session data. */
export function bindSubagentSession(
  state: SubagentStreamState,
  sessionId: string | null,
): SubagentStreamState {
  if (state.sessionId === sessionId && state.hydration === 'loading') return state;
  return withTail({
    sessionId,
    hydration: sessionId ? 'loading' : 'empty',
    records: [],
    live: new Map(),
    highWater: new Map(),
    runs: new Map(),
    buffered: [],
    error: null,
    generation: state.generation + 1,
  });
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
  return withTail({
    ...state,
    hydration: 'loading',
    buffered: [...state.buffered],
    error: null,
    generation: state.generation + 1,
  });
}

export function shouldBufferSubagentEvent(
  state: Pick<SubagentStreamState, 'sessionId' | 'hydration'>,
  event: Pick<SubagentEvent, 'sessionId'>,
): boolean {
  return state.hydration === 'loading' && !!state.sessionId && state.sessionId === event.sessionId;
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
  const groups = groupSubagents(records);
  return groups.running[0]?.id ?? groups.ended[0]?.id ?? null;
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

function applyEvent(state: SubagentStreamState, event: SubagentEvent): SubagentStreamState {
  if (state.sessionId !== event.sessionId || event.projection.sessionId && event.projection.sessionId !== event.sessionId) {
    return state;
  }
  const knownRun = state.runs.get(event.subagentId);
  const lastSequence = state.highWater.get(event.subagentId);
  if (!knownRun || knownRun !== event.runId || lastSequence === undefined || event.sequence <= lastSequence) {
    return state;
  }

  const highWater = new Map(state.highWater).set(event.subagentId, event.sequence);
  const live = new Map(state.live);
  const records = state.records.map((record) =>
    record.id === event.subagentId ? recordWithProjection(record, event.projection) : record,
  );
  if (isRunning(event.projection.state)) live.set(event.subagentId, event.projection);
  else live.delete(event.subagentId);
  return withTail({ ...state, records, live, highWater });
}

/** Accept one event, or retain it for replay after snapshot seeding. */
export function acceptSubagentEvent(
  state: SubagentStreamState,
  event: SubagentEvent,
): SubagentStreamState {
  if (state.sessionId !== event.sessionId) return state;
  if (state.hydration === 'loading') {
    return state.buffered.some((item) => item.subagentId === event.subagentId && item.runId === event.runId && item.sequence === event.sequence)
      ? state
      : withTail({ ...state, buffered: [...state.buffered, event] });
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
  return withTail({
    ...state,
    hydration: snapshot.records.length ? 'ready' : 'empty',
    records: [...snapshot.records].sort(compareNewest),
    live,
    highWater,
    runs,
    buffered: [],
    error: null,
  });
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
  return withTail({ ...state, hydration: 'error', error, buffered: [] });
}

/** Apply session-loaded durable records without disturbing a live projection. */
export function replaceSubagentRecords(
  state: SubagentStreamState,
  records: readonly SubagentRecord[],
): SubagentStreamState {
  // ChatView may hand us the session-load result while the richer snapshot is
  // still in flight. Keep loading affinity intact so the response can seed
  // high-water marks and replay buffered events over these durable records.
  return withTail({
    ...state,
    records: [...records].sort(compareNewest),
    hydration: state.hydration === 'loading' ? 'loading' : records.length ? 'ready' : 'empty',
  });
}

export function mergeSubagentRecordAndLive(
  record: SubagentRecord,
  live: SubagentLiveProjection | null | undefined,
): { record: SubagentRecord; live: SubagentLiveProjection | null } {
  return live ? { record: recordWithProjection(record, live), live: isRunning(live.state) ? live : null } : { record, live: null };
}
