import type { SubagentEvent, SubagentSnapshot } from '../../shared/types/ipc';
import type { Usage } from '../../shared/types/message';
import type {
  SubagentCompactionProgressEvent,
  SubagentDeltaEvent,
  SubagentLiveProjection,
  SubagentLiveSegment,
  SubagentSummary,
  SubagentSpawnedEvent,
  SubagentStatus,
  SubagentStatusChangedEvent,
  SubagentTerminalEvent,
  SubagentToolSnapshot,
} from '../../shared/types/subagent';
import { estimateDeltaBytes } from '../../shared/types/subagent';

export type SubagentHydrationState = 'loading' | 'ready' | 'empty' | 'error';

export interface SubagentStreamState {
  readonly sessionId: string | null;
  readonly hydration: SubagentHydrationState;
  readonly records: readonly SubagentSummary[];
  readonly live: ReadonlyMap<string, SubagentLiveProjection>;
  readonly highWater: ReadonlyMap<string, number>;
  readonly runs: ReadonlyMap<string, string>;
  readonly buffered: readonly SubagentDeltaEvent[];
  readonly bufferedBytes: number;
  /**
   * Lowest snapshot revision that may reseed after a hydration-buffer
   * overflow. Set (and only ever raised) on overflow; cleared on seed.
   */
  readonly reseedFloor: number | null;
  readonly error: string | null;
  readonly generation: number;
}

/** Fallback bound for the hydration buffer (config `subagents.hydration_buffer_kb`, 256 KB). */
export const DEFAULT_HYDRATION_BUFFER_BYTES = 256 * 1024;

export interface SubagentDeltaBatchOptions {
  /** Byte bound for buffered events while hydration is loading. */
  readonly hydrationBufferBytes?: number;
}

const isRunning = (status: SubagentStatus): boolean =>
  status === 'pending' || status === 'running';

// Timestamp-descending only: sort is stable, so equal timestamps keep input
// order (spawn/insertion order) — the ordering callers like the Sidebar
// partition expect when delegating their bucketing to groupSubagents.
function compareNewest(a: SubagentSummary, b: SubagentSummary): number {
  return Date.parse(b.start_time) - Date.parse(a.start_time);
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
    bufferedBytes: 0,
    reseedFloor: null,
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
    bufferedBytes: 0,
    reseedFloor: null,
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

export function groupSubagents(records: readonly SubagentSummary[]): {
  queued: readonly SubagentSummary[];
  running: readonly SubagentSummary[];
  ended: readonly SubagentSummary[];
} {
  const sorted = [...records].sort(compareNewest);
  return {
    queued: sorted.filter((record) => record.status === 'queued'),
    running: sorted.filter((record) => isRunning(record.status)),
    ended: sorted.filter((record) => !isRunning(record.status) && record.status !== 'queued'),
  };
}

export function resolveSubagentSelection(
  records: readonly SubagentSummary[],
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

// ── Delta application ───────────────────────────────────────────────────────

type ToolDraft = { -readonly [K in keyof SubagentToolSnapshot]: SubagentToolSnapshot[K] };

/** Freeze the trailing open text/thinking segment at a segment transition. */
function closeOpenSegment(segments: SubagentLiveSegment[], at: string): void {
  const last = segments.at(-1);
  if (!last || last.kind === 'tool' || last.endedAt != null) return;
  last.endedAt = at;
}

/** Mutable per-subagent projection draft; one rebuild per subagent per batch. */
interface LiveDraft {
  sessionId: string | null;
  subagentId: string;
  runId: string;
  sequence: number;
  state: SubagentStatus;
  segments: SubagentLiveSegment[];
  toolCalls: ToolDraft[];
  usage: Usage | null;
  result: string | null;
  error: string | null;
  compactionProgress: SubagentCompactionProgressEvent | null;
}

function draftFromProjection(projection: SubagentLiveProjection): LiveDraft {
  return {
    sessionId: projection.sessionId,
    subagentId: projection.subagentId,
    runId: projection.runId,
    sequence: projection.sequence,
    state: projection.state,
    segments: projection.segments.map((segment) => ({ ...segment })),
    toolCalls: projection.toolCalls.map((tool) => ({ ...tool })),
    usage: projection.usage,
    result: projection.result,
    error: projection.error,
    compactionProgress: projection.compactionProgress,
  };
}

function draftFromSpawn(event: SubagentSpawnedEvent): LiveDraft {
  return {
    sessionId: event.sessionId,
    subagentId: event.subagentId,
    runId: event.runId,
    sequence: event.sequence,
    // The wire carries no pending→running transition: the manager marks a run
    // running before its first stream event, so a spawned seed is live at once.
    // A queued seed keeps its queued state until its first content delta.
    state: event.record.status === 'queued' ? 'queued' : 'running',
    segments: [],
    toolCalls: [],
    usage: event.usage,
    result: null,
    error: null,
    compactionProgress: null,
  };
}

type ContentDelta = Exclude<SubagentDeltaEvent, SubagentSpawnedEvent | SubagentStatusChangedEvent | SubagentTerminalEvent>;

function applyDeltaToDraft(draft: LiveDraft, event: ContentDelta): void {
  // Any content delta proves the queued run was admitted and started: the
  // wire carries no explicit queued→running transition.
  if (draft.state === 'queued') draft.state = 'running';
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta': {
      const kind = event.type === 'text_delta' ? 'text' : 'thinking';
      const segment = draft.segments.find((item) => item.id === event.segmentId);
      if (!segment) {
        const startedAt = event.startedAt ?? new Date().toISOString();
        closeOpenSegment(draft.segments, startedAt);
        draft.segments.push({ kind, id: event.segmentId, content: event.append, startedAt, endedAt: null });
      } else if (segment.kind !== 'tool') {
        segment.content += event.append;
      }
      break;
    }
    case 'tool_start': {
      let tool = draft.toolCalls.find((item) => item.toolCallId === event.toolCallId);
      if (tool) {
        tool.status = event.status;
        tool.args = event.args;
        tool.startedAt = event.startedAt;
        // The manager overwrites partialArgs with the finalized args at running.
        if (event.status === 'running') tool.partialArgs = event.args;
      } else {
        tool = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: event.status,
          partialArgs: event.status === 'running' ? event.args : '',
          args: event.args,
          content: null,
          toolResult: null,
          startedAt: event.startedAt,
          finishedAt: null,
        };
        draft.toolCalls.push(tool);
      }
      if (!draft.segments.some((item) => item.kind === 'tool' && item.toolCallId === event.toolCallId)) {
        closeOpenSegment(draft.segments, event.startedAt);
        draft.segments.push({ kind: 'tool', id: event.segmentId, toolCallId: event.toolCallId });
      }
      break;
    }
    case 'tool_args_delta': {
      const tool = draft.toolCalls.find((item) => item.toolCallId === event.toolCallId);
      if (tool) tool.partialArgs += event.append;
      break;
    }
    case 'tool_result': {
      const tool = draft.toolCalls.find((item) => item.toolCallId === event.toolCallId);
      if (tool) {
        tool.status = event.status;
        tool.content = event.content;
        tool.toolResult = event.toolResult;
        tool.finishedAt = event.finishedAt;
      }
      break;
    }
    case 'usage':
      draft.usage = event.usage;
      break;
    case 'compaction_progress':
      draft.compactionProgress = event;
      break;
  }
}

/**
 * Apply one flush of deltas in order. `records` identity changes on
 * `spawned` (append, or replace on run rotation), `status_changed` (status
 * field update), and `terminal` (replace); projection-only deltas rebuild
 * one live projection per touched subagent and leave records untouched.
 */
function applyDeltaEvents(
  state: SubagentStreamState,
  events: readonly SubagentDeltaEvent[],
): SubagentStreamState {
  if (events.length === 0) return state;
  const bySubagent = new Map<string, SubagentDeltaEvent[]>();
  for (const event of events) {
    const list = bySubagent.get(event.subagentId);
    if (list) list.push(event);
    else bySubagent.set(event.subagentId, [event]);
  }

  let records = state.records;
  let live: Map<string, SubagentLiveProjection> | null = null;
  let highWater: Map<string, number> | null = null;
  let runs: Map<string, string> | null = null;

  for (const [subagentId, deltas] of bySubagent) {
    const knownRun = (runs ?? state.runs).get(subagentId);
    let high = (highWater ?? state.highWater).get(subagentId);

    const applicable: SubagentDeltaEvent[] = [];
    let runId = knownRun;
    for (const event of deltas) {
      if ((event.type === 'spawned' || event.type === 'terminal') && event.record.id !== subagentId) {
        continue;
      }
      if (runId !== undefined) {
        // Run rotation: a resumed subagent re-emits spawned under a fresh
        // runId. Let the seed through without the stale-run sequence filter;
        // the high-water mark resets to this seed's sequence below, so the new
        // run's low sequence numbers are not dropped on later events.
        const isRotation = event.type === 'spawned' && event.runId !== runId;
        if (!isRotation && (event.runId !== runId || event.sequence <= (high ?? -1))) {
          continue;
        }
      } else if (event.type !== 'spawned') {
        // Only a spawned seed can open an unknown run.
        continue;
      }
      applicable.push(event);
      runId = event.runId;
      high = event.sequence;
    }
    if (applicable.length === 0) continue;

    if (runId !== undefined && runId !== knownRun) {
      runs ??= new Map(state.runs);
      runs.set(subagentId, runId);
    }
    highWater ??= new Map(state.highWater);
    highWater.set(subagentId, high as number);

    const existing = state.live.get(subagentId);
    let draft: LiveDraft | null =
      existing && existing.runId === runId ? draftFromProjection(existing) : null;
    let settled = false;
    for (const event of applicable) {
      if (event.type === 'spawned') {
        // Upsert: append on first spawn, replace on run rotation (the
        // resumed record carries reopened state — status back to
        // running/queued, result/error cleared).
        records = records.some((item) => item.id === event.record.id)
          ? records.map((item) => (item.id === event.record.id ? event.record : item))
          : [...records, event.record];
        draft = draftFromSpawn(event);
      } else if (event.type === 'status_changed') {
        records = records.map((item) => (
          item.id === subagentId ? { ...item, status: event.status } : item
        ));
        if (draft) draft.state = event.status;
      } else if (event.type === 'terminal') {
        records = records.some((item) => item.id === event.record.id)
          ? records.map((item) => (item.id === event.record.id ? event.record : item))
          : [...records, event.record];
        draft = null;
        settled = true;
      } else if (draft) {
        draft.sequence = event.sequence;
        applyDeltaToDraft(draft, event);
      }
    }

    if (settled) {
      live ??= new Map(state.live);
      live.delete(subagentId);
    } else if (draft) {
      live ??= new Map(state.live);
      live.set(subagentId, draft);
    }
  }

  if (records === state.records && live === null && highWater === null && runs === null) {
    return state;
  }
  return {
    ...state,
    records,
    live: live ?? state.live,
    highWater: highWater ?? state.highWater,
    runs: runs ?? state.runs,
  };
}

function deltaKey(event: SubagentDeltaEvent): string {
  return `${event.subagentId}:${event.runId}:${event.sequence}`;
}

/** Retain deltas while hydration is loading; overflow discards intermediates and raises the reseed floor. */
function bufferDeltaEvents(
  state: SubagentStreamState,
  events: readonly SubagentDeltaEvent[],
  boundBytes: number,
): SubagentStreamState {
  const seen = new Set(state.buffered.map(deltaKey));
  const fresh: SubagentDeltaEvent[] = [];
  for (const event of events) {
    const key = deltaKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(event);
  }
  if (fresh.length === 0) return state;
  let addedBytes = 0;
  for (const event of fresh) addedBytes += estimateDeltaBytes(event);
  if (state.bufferedBytes + addedBytes > boundBytes) {
    // Discarded intermediates are unrecoverable; only a snapshot at or above
    // the newest seen revision may reseed without rolling state back.
    let floor = state.reseedFloor ?? 0;
    for (const event of state.buffered) floor = Math.max(floor, event.sessionRevision);
    for (const event of fresh) floor = Math.max(floor, event.sessionRevision);
    return { ...state, buffered: [], bufferedBytes: 0, reseedFloor: floor };
  }
  return {
    ...state,
    buffered: [...state.buffered, ...fresh],
    bufferedBytes: state.bufferedBytes + addedBytes,
  };
}

/** Accept one batched flush, or retain it for replay after snapshot seeding. */
export function applyDeltaBatch(
  state: SubagentStreamState,
  batch: SubagentEvent,
  options: SubagentDeltaBatchOptions = {},
): SubagentStreamState {
  if (state.sessionId !== batch.sessionId) return state;
  if (state.hydration === 'loading') {
    return bufferDeltaEvents(
      state,
      batch.events,
      options.hydrationBufferBytes ?? DEFAULT_HYDRATION_BUFFER_BYTES,
    );
  }
  return applyDeltaEvents(state, batch.events);
}

function seedSnapshotNow(state: SubagentStreamState, snapshot: SubagentSnapshot): SubagentStreamState {
  const live = new Map<string, SubagentLiveProjection>();
  const highWater = new Map<string, number>();
  const runs = new Map<string, string>();
  for (const projection of snapshot.live) {
    if (projection.sessionId && projection.sessionId !== snapshot.sessionId) continue;
    runs.set(projection.subagentId, projection.runId);
    highWater.set(projection.subagentId, projection.sequence);
    // Queued projections seed the live map too so post-admission deltas apply.
    if (isRunning(projection.state) || projection.state === 'queued') {
      live.set(projection.subagentId, projection);
    }
  }
  return {
    ...state,
    hydration: snapshot.records.length ? 'ready' : 'empty',
    records: [...snapshot.records].sort(compareNewest),
    live,
    highWater,
    runs,
    buffered: [],
    bufferedBytes: 0,
    reseedFloor: null,
    error: null,
  };
}

/**
 * Seed high-water marks, then replay only newer buffered events for this
 * session. A snapshot below the recorded reseed floor is stale and rejected
 * without state change; a successful seed clears the floor.
 */
export function seedSubagentSnapshot(
  state: SubagentStreamState,
  snapshot: SubagentSnapshot,
): SubagentStreamState {
  if (state.sessionId !== snapshot.sessionId || state.hydration !== 'loading') return state;
  if (state.reseedFloor !== null && snapshot.sessionRevision < state.reseedFloor) return state;
  const buffered = [...state.buffered].sort((a, b) => a.sequence - b.sequence);
  return applyDeltaEvents(seedSnapshotNow(state, snapshot), buffered);
}

export function failSubagentSnapshot(state: SubagentStreamState, error: string): SubagentStreamState {
  return { ...state, hydration: 'error', error, buffered: [], bufferedBytes: 0 };
}
