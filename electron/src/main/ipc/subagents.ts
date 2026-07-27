/** Session-affine subagent snapshot and live projection IPC. */
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { SubagentEvent, SubagentSnapshot } from '../../shared/types/ipc';
import type {
  SubagentRecord as DomainSubagentRecord,
  SubagentLiveChange,
  LegacySubagentEvent,
  SubagentDeltaEvent,
  SubagentTextDeltaEvent,
  SubagentThinkingDeltaEvent,
} from '../../shared/types/subagent';
import { getSubagentManager } from '../tools';
import { getSessionManager } from './session';
import { subagentSnapshotSchema } from './payload-schemas';
import { runtimeToDomain } from '../agents/manager';

export function mergeSubagentRecords(stored: readonly DomainSubagentRecord[], runtime: readonly DomainSubagentRecord[]) {
  const merged = new Map(stored.map((record) => [record.id, record]));
  for (const record of runtime) merged.set(record.id, record);
  return [...merged.values()];
}

export function createSubagentSnapshot(sessionId: string): SubagentSnapshot {
  const manager = getSubagentManager();
  const session = getSessionManager().getSession(sessionId);
  const runtime = manager.allRecords()
    .filter((record) => record.sessionId === sessionId)
    .map((record) => runtimeToDomain(record, { includeLiveTail: false }));
  const records = mergeSubagentRecords(session?.subagentChains ?? [], runtime);
  return {
    sessionId,
    sessionRevision: manager.getSessionRevision(sessionId),
    records,
    live: manager.getLiveProjections(sessionId),
  };
}

export function isEligibleSubagentRecipient(contents: WebContents, sessionId: string): boolean {
  if (contents.isDestroyed()) return false;
  return getSessionManager().getActive(String(contents.id))?.id === sessionId;
}

export function deliverSubagentChange(
  change: SubagentLiveChange,
  windows: readonly BrowserWindow[] = BrowserWindow.getAllWindows(),
): void {
  if (!change.sessionId) return;
  const event: LegacySubagentEvent = {
    sessionId: change.sessionId,
    subagentId: change.subagentId,
    runId: change.runId,
    sequence: change.sequence,
    type: 'projection',
    projection: change.projection,
    record: (() => {
      const record = getSubagentManager().getRecord(change.subagentId);
      return record ? runtimeToDomain(record, { includeLiveTail: false }) : undefined;
    })(),
  };
  for (const win of windows) {
    try {
      if (!win.isDestroyed() && isEligibleSubagentRecipient(win.webContents, change.sessionId)) {
        win.webContents.send(IPC_CHANNELS.SUBAGENTS_EVENT, event);
      }
    } catch { /* window closed between targeting and send */ }
  }
}

export interface EventTimerApi {
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Shared delivery cadence: a 16ms frame flush with a 50ms max-latency backstop. */
const FLUSH_FRAME_MS = 16;
const FLUSH_MAX_MS = 50;

export function createSubagentEventCoalescer(
  deliver: (change: SubagentLiveChange) => void,
  timers: EventTimerApi = { setTimeout, clearTimeout },
) {
  let pending = new Map<string, SubagentLiveChange>();
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (frameTimer) timers.clearTimeout(frameTimer);
    if (maxTimer) timers.clearTimeout(maxTimer);
    frameTimer = maxTimer = null;
    const changes = [...pending.values()];
    pending = new Map();
    for (const change of changes) deliver(change);
  };
  return {
    queue(change: SubagentLiveChange): void {
      pending.set(`${change.sessionId}:${change.subagentId}`, change);
      if (!frameTimer) frameTimer = timers.setTimeout(flush, FLUSH_FRAME_MS);
      if (!maxTimer) maxTimer = timers.setTimeout(flush, FLUSH_MAX_MS);
    },
    flush,
  };
}

let wired = false;
const eventCoalescer = createSubagentEventCoalescer((change) => deliverSubagentChange(change));
export function queueSubagentEvent(change: SubagentLiveChange): void { eventCoalescer.queue(change); }

// ── Delta batcher (U3) ──────────────────────────────────────────────────────

function isAppendDelta(
  event: SubagentDeltaEvent,
): event is SubagentTextDeltaEvent | SubagentThinkingDeltaEvent {
  return event.type === 'text_delta' || event.type === 'thinking_delta';
}

/**
 * Collapse every text/thinking append sharing `(type, subagentId, segmentId)`
 * within one flush window into a single delta. The merged delta is emitted at
 * the position of the LAST occurrence and keeps that event's
 * sequence/sessionRevision, so batch order stays strictly monotonic while all
 * same-segment appends concatenate in their original order.
 */
export function mergeAppendDeltas(events: readonly SubagentDeltaEvent[]): SubagentDeltaEvent[] {
  const lastIndexByKey = new Map<string, number>();
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (isAppendDelta(event)) {
      lastIndexByKey.set(`${event.type}:${event.subagentId}:${event.segmentId}`, i);
    }
  }
  const appendedByKey = new Map<string, string>();
  const merged: SubagentDeltaEvent[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!isAppendDelta(event)) {
      merged.push(event);
      continue;
    }
    const key = `${event.type}:${event.subagentId}:${event.segmentId}`;
    const append = (appendedByKey.get(key) ?? '') + event.append;
    appendedByKey.set(key, append);
    if (lastIndexByKey.get(key) === i) merged.push({ ...event, append });
  }
  return merged;
}

function estimateRecordBytes(record: DomainSubagentRecord): number {
  return record.id.length + record.agent_name.length + record.agent_type.length
    + record.agent_tier.length + record.task.length
    + (record.result?.length ?? 0) + (record.error?.length ?? 0);
}

/**
 * Cheap serialized-length estimate for a delta payload: the sum of its
 * string-field lengths, never a per-event JSON.stringify. `spawned`/`terminal`
 * are budget-exempt, so their record estimate only nudges the running total.
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
      break;
    case 'spawned':
    case 'terminal':
      bytes += estimateRecordBytes(event.record);
      break;
    case 'usage':
      break;
  }
  return bytes;
}

export interface SubagentDeltaBudgets {
  maxPerFlush: number;
  byteBudgetKb: number;
}

/**
 * Resolve per-flush delta budgets from the live process-wide config so a
 * runtime settings change takes effect on the next flush. Falls back to the
 * schema defaults when config is not loaded.
 */
export function resolveSubagentDeltaBudgets(): SubagentDeltaBudgets {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require('../config/loader') as typeof import('../config/loader');
    const { event_max_per_flush, event_byte_budget_kb } = getConfig().subagents;
    return { maxPerFlush: event_max_per_flush, byteBudgetKb: event_byte_budget_kb };
  } catch {
    return { maxPerFlush: 200, byteBudgetKb: 64 };
  }
}

export interface SubagentDeltaBatcherOptions {
  timers?: EventTimerApi;
  budgets?: () => SubagentDeltaBudgets;
  /** Session gate; no envelope is built for an ineligible session. */
  isEligible?: (sessionId: string) => boolean;
}

/**
 * Budgeted batcher over typed subagent deltas. Merges same-segment text and
 * thinking appends per flush, caps each flush at a global event count and byte
 * budget, and defers (never drops) overflowing non-terminal deltas to the next
 * flush in order. `spawned`/`terminal` are budget-exempt and always flush.
 * Delivers one `SubagentEvent` envelope per eligible session per flush; records
 * ride only the `spawned`/`terminal` deltas the manager already built.
 */
export function createSubagentDeltaBatcher(
  deliver: (envelope: SubagentEvent) => void,
  options: SubagentDeltaBatcherOptions = {},
) {
  const timers: EventTimerApi = options.timers ?? { setTimeout, clearTimeout };
  const budgets = options.budgets ?? resolveSubagentDeltaBudgets;
  const isEligible = options.isEligible ?? ((): boolean => true);
  let queue: SubagentDeltaEvent[] = [];
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleFlush = (): void => {
    if (!frameTimer) frameTimer = timers.setTimeout(flush, FLUSH_FRAME_MS);
    if (!maxTimer) maxTimer = timers.setTimeout(flush, FLUSH_MAX_MS);
  };

  const flush = (): void => {
    if (frameTimer) timers.clearTimeout(frameTimer);
    if (maxTimer) timers.clearTimeout(maxTimer);
    frameTimer = maxTimer = null;
    if (queue.length === 0) return;

    const { maxPerFlush, byteBudgetKb } = budgets();
    const byteBudget = byteBudgetKb * 1024;
    const merged = mergeAppendDeltas(queue);
    const batch: SubagentDeltaEvent[] = [];
    const deferred: SubagentDeltaEvent[] = [];
    let bytes = 0;
    for (const event of merged) {
      const exempt = event.type === 'spawned' || event.type === 'terminal';
      const size = estimateDeltaBytes(event);
      const overCount = batch.length >= maxPerFlush;
      const overBytes = batch.length > 0 && bytes + size > byteBudget;
      if (!exempt && (overCount || overBytes)) {
        deferred.push(event);
        continue;
      }
      batch.push(event);
      bytes += size;
    }
    queue = deferred;

    const envelopes = new Map<string, SubagentDeltaEvent[]>();
    for (const event of batch) {
      if (!isEligible(event.sessionId)) continue;
      let events = envelopes.get(event.sessionId);
      if (!events) {
        events = [];
        envelopes.set(event.sessionId, events);
      }
      events.push(event);
    }
    for (const [sessionId, events] of envelopes) {
      deliver({ sessionId, events });
    }

    if (queue.length > 0) scheduleFlush();
  };

  return {
    queue(event: SubagentDeltaEvent): void {
      queue.push(event);
      scheduleFlush();
    },
    flush,
  };
}

/** Deliver one batched delta envelope to the windows owning its session. */
export function deliverSubagentDeltaEvent(
  envelope: SubagentEvent,
  windows: readonly BrowserWindow[] = BrowserWindow.getAllWindows(),
): void {
  for (const win of windows) {
    try {
      if (!win.isDestroyed() && isEligibleSubagentRecipient(win.webContents, envelope.sessionId)) {
        win.webContents.send(IPC_CHANNELS.SUBAGENTS_EVENT, envelope);
      }
    } catch { /* window closed between targeting and send */ }
  }
}

function hasEligibleSubagentRecipient(sessionId: string): boolean {
  return BrowserWindow.getAllWindows().some(
    (win) => !win.isDestroyed() && isEligibleSubagentRecipient(win.webContents, sessionId),
  );
}

const deltaBatcher = createSubagentDeltaBatcher(
  (envelope) => deliverSubagentDeltaEvent(envelope),
  { isEligible: hasEligibleSubagentRecipient },
);
export function queueSubagentDelta(event: SubagentDeltaEvent): void { deltaBatcher.queue(event); }
export function flushSubagentDeltas(): void { deltaBatcher.flush(); }

export function registerSubagentIPC(): void {
  if (wired) return;
  wired = true;
  ipcMain.handle(IPC_CHANNELS.SUBAGENTS_SNAPSHOT, (_event, raw: unknown) => {
    const parsed = subagentSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid subagent snapshot request: ${parsed.error.message}`);
    return createSubagentSnapshot(parsed.data.sessionId);
  });
}

export function unregisterSubagentIPC(): void {
  if (!wired) return;
  wired = false;
  ipcMain.removeHandler(IPC_CHANNELS.SUBAGENTS_SNAPSHOT);
  eventCoalescer.flush();
  deltaBatcher.flush();
}

export function flushSubagentEvents(): void { eventCoalescer.flush(); }
