/**
 * Live subagent delta batching and delivery.
 *
 * This is intentionally owned by the agent runtime rather than IPC
 * registration: the runtime wires and flushes these process-wide helpers,
 * while the IPC module only owns snapshot handler registration.
 *
 * Delivery is injected via {@link setSubagentDeltaDelivery} so the runtime
 * stays Electron-free; the Electron shell installs the window broadcast and
 * plain-Node hosts keep the no-op default.
 */
import { IPC_CHANNELS, type SubagentEvent } from '../../shared/types/ipc';
import type {
  SubagentDeltaEvent,
  SubagentTextDeltaEvent,
  SubagentThinkingDeltaEvent,
} from '../../shared/types/subagent';
import { estimateDeltaBytes } from '../../shared/types/subagent';
import { getConfig } from '../config/loader';
import { subagentsConfigSchema } from '../config/schema';
import { getSessionManager } from '../session/singleton';

/** Structural delivery target (a window's web contents). */
export interface SubagentDeliveryContents {
  id: number | string;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

/** Structural window shape targeted by the delivery helpers. */
export interface SubagentDeliveryWindow {
  isDestroyed(): boolean;
  webContents?: SubagentDeliveryContents | null;
}

export function isEligibleSubagentRecipient(contents: SubagentDeliveryContents, sessionId: string): boolean {
  if (contents.isDestroyed()) return false;
  return getSessionManager().getActive(String(contents.id))?.id === sessionId;
}

export interface EventTimerApi {
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Shared delivery cadence: a 16ms frame flush with a 50ms max-latency backstop. */
const FLUSH_FRAME_MS = 16;
const FLUSH_MAX_MS = 50;

/**
 * Flush cycles an undeliverable carry may keep the flush loop alive for
 * (~0.7s at frame cadence, ~2s on the max-latency backstop). Beyond it the
 * carried lifecycle events are dropped so a session that never regains an
 * eligible recipient cannot poll `isEligible` forever.
 */
const MAX_STALLED_CARRY_FLUSHES = 40;

const lastDropWarnAt = new Map<string, number>();

/**
 * Upper bound on throttle bookkeeping keys (`ineligible:${sessionId}` /
 * `stall-drop:${sessionId}`). Sessions are long-lived UUIDs and the store is
 * never pruned by session lifecycle, so cap it: at capacity the whole map is
 * cleared (worst case a hot key re-warns once, then throttles again).
 */
const MAX_DROP_WARN_KEYS = 128;

/** Throttled drop warning: at most one per key per five seconds. */
function warnDrop(key: string, message: string): void {
  const now = Date.now();
  const last = lastDropWarnAt.get(key) ?? 0;
  if (now - last < 5_000) return;
  if (lastDropWarnAt.size >= MAX_DROP_WARN_KEYS) lastDropWarnAt.clear();
  lastDropWarnAt.set(key, now);
  console.warn(`[subagent-events] ${message}`);
}

function isAppendDelta(
  event: SubagentDeltaEvent,
): event is SubagentTextDeltaEvent | SubagentThinkingDeltaEvent {
  return event.type === 'text_delta' || event.type === 'thinking_delta';
}

/**
 * One-shot lifecycle handoffs: budget-exempt while eligible, carried (deferred
 * in order) while their session has no eligible recipient.
 */
function isLifecycleDelta(event: SubagentDeltaEvent): boolean {
  return event.type === 'spawned' || event.type === 'terminal' || event.type === 'status_changed';
}

/**
 * Collapse every text/thinking append sharing `(sessionId, type, subagentId,
 * segmentId)` within one flush window into a single delta. The merged delta is
 * emitted at the position of the LAST occurrence and keeps that event's
 * sequence/sessionRevision, so batch order stays strictly monotonic while all
 * same-segment appends concatenate in their original order. The session key is
 * part of the merge key so same-named segments from different sessions never
 * combine.
 */
export function mergeAppendDeltas(events: readonly SubagentDeltaEvent[]): SubagentDeltaEvent[] {
  const mergeKey = (event: SubagentTextDeltaEvent | SubagentThinkingDeltaEvent): string =>
    `${event.sessionId}:${event.type}:${event.subagentId}:${event.segmentId}`;
  const lastIndexByKey = new Map<string, number>();
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (isAppendDelta(event)) {
      lastIndexByKey.set(mergeKey(event), i);
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
    const key = mergeKey(event);
    const append = (appendedByKey.get(key) ?? '') + event.append;
    appendedByKey.set(key, append);
    if (lastIndexByKey.get(key) === i) merged.push({ ...event, append });
  }
  return merged;
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
    const { event_max_per_flush, event_byte_budget_kb } = getConfig().subagents;
    return { maxPerFlush: event_max_per_flush, byteBudgetKb: event_byte_budget_kb };
  } catch {
    const defaults = subagentsConfigSchema.parse({});
    return {
      maxPerFlush: defaults.event_max_per_flush,
      byteBudgetKb: defaults.event_byte_budget_kb,
    };
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
 * flush in order. `spawned`/`terminal`/`status_changed` are budget-exempt and
 * always flush for an eligible session; while a session has no eligible
 * recipient they are CARRIED to a later flush (bounded by a stall budget) so a
 * transiently missed window still receives the one-shot queued→running→
 * terminal transitions — dropping those stranded a subagent in the wrong list
 * until the next snapshot. Content deltas for an ineligible session are
 * dropped as before; snapshots re-establish them.
 * Delivers one `SubagentEvent` envelope per eligible session per flush;
 * lightweight summaries ride only the `spawned`/`terminal` deltas.
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
  let stalledFlushes = 0;

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
    const envelopes = new Map<string, SubagentDeltaEvent[]>();
    const deferred: SubagentDeltaEvent[] = [];
    // Eligibility enumerates windows and reads the active session, so gate
    // once per distinct session per flush rather than once per event.
    const eligibility = new Map<string, boolean>();
    const envelopeFor = (sessionId: string): SubagentDeltaEvent[] => {
      let events = envelopes.get(sessionId);
      if (!events) {
        events = [];
        envelopes.set(sessionId, events);
      }
      return events;
    };
    let normalCount = 0;
    let bytes = 0;
    const droppedForSession = new Map<string, { count: number; types: Set<string> }>();
    for (const event of merged) {
      let eligible = eligibility.get(event.sessionId);
      if (eligible === undefined) {
        eligible = isEligible(event.sessionId);
        eligibility.set(event.sessionId, eligible);
      }
      if (!eligible) {
        // Carry lifecycle handoffs in order for a later flush; drop content.
        if (isLifecycleDelta(event)) {
          deferred.push(event);
        } else {
          const entry = droppedForSession.get(event.sessionId) ?? { count: 0, types: new Set<string>() };
          entry.count += 1;
          entry.types.add(event.type);
          droppedForSession.set(event.sessionId, entry);
        }
        continue;
      }
      if (isLifecycleDelta(event)) {
        envelopeFor(event.sessionId).push(event);
        continue;
      }
      const size = estimateDeltaBytes(event);
      const overCount = normalCount >= maxPerFlush;
      const overBytes = normalCount > 0 && bytes + size > byteBudget;
      if (overCount || overBytes) {
        deferred.push(event);
        continue;
      }
      envelopeFor(event.sessionId).push(event);
      normalCount += 1;
      bytes += size;
    }
    queue = deferred;

    for (const [sessionId, { count, types }] of droppedForSession) {
      warnDrop(`ineligible:${sessionId}`,
        `dropped ${count} content delta(s) for session ${sessionId} with no eligible recipient ` +
        `(types: ${[...types].join(', ')}); snapshots re-establish state but live streaming stays off ` +
        `until the session regains a viewing client`);
    }

    for (const [sessionId, events] of envelopes) {
      deliver({ sessionId, events });
    }

    // Any delivery proves liveness: restart the stall budget for the next
    // carry episode, whether or not carries remain queued (a drained flush
    // must not leak its stall count into a later episode's retry window).
    if (envelopes.size > 0) stalledFlushes = 0;

    if (queue.length > 0) {
      if (envelopes.size > 0) {
        scheduleFlush();
      } else {
        // Nothing was deliverable, so the queue is entirely carried lifecycle
        // events for currently-ineligible sessions: retry within the stall
        // budget, then drop the carry so the loop cannot run forever.
        stalledFlushes += 1;
        if (stalledFlushes > MAX_STALLED_CARRY_FLUSHES) {
          for (const event of queue) {
            warnDrop(`stall-drop:${event.sessionId}`,
              `dropped carried ${event.type} delta for ${event.subagentId} ` +
              `(session ${event.sessionId} stayed ineligible past the carry budget)`);
          }
          queue = [];
          stalledFlushes = 0;
        } else {
          scheduleFlush();
        }
      }
    }
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
  windows: readonly SubagentDeliveryWindow[] = [],
): void {
  for (const win of windows) {
    try {
      if (!win.isDestroyed() && win.webContents && isEligibleSubagentRecipient(win.webContents, envelope.sessionId)) {
        win.webContents.send(IPC_CHANNELS.SUBAGENTS_EVENT, envelope);
      }
    } catch { /* window closed between targeting and send */ }
  }
}

/** Whether any live window in the set owns the session. */
export function hasEligibleSubagentRecipientWindow(
  sessionId: string,
  windows: readonly SubagentDeliveryWindow[] = [],
): boolean {
  return windows.some(
    (win) => !win.isDestroyed() && win.webContents != null && isEligibleSubagentRecipient(win.webContents, sessionId),
  );
}

/** Injected delivery for the process-wide delta batcher. */
export interface SubagentDeltaDelivery {
  /** Deliver one batched envelope to its live recipients. */
  deliver(envelope: SubagentEvent): void;
  /** Whether any live recipient currently owns the session. */
  hasEligibleRecipient(sessionId: string): boolean;
}

const noopDeltaDelivery: SubagentDeltaDelivery = {
  deliver: () => {},
  hasEligibleRecipient: () => false,
};

let deltaDelivery: SubagentDeltaDelivery = noopDeltaDelivery;

/**
 * Install delta delivery for the process-wide batcher (the Electron shell
 * installs the window broadcast). Passing null restores the no-op default.
 */
export function setSubagentDeltaDelivery(delivery: SubagentDeltaDelivery | null): void {
  deltaDelivery = delivery ?? noopDeltaDelivery;
}

const deltaBatcher = createSubagentDeltaBatcher(
  (envelope) => deltaDelivery.deliver(envelope),
  { isEligible: (sessionId) => deltaDelivery.hasEligibleRecipient(sessionId) },
);

export function queueSubagentDelta(event: SubagentDeltaEvent): void { deltaBatcher.queue(event); }
export function flushSubagentDeltas(): void { deltaBatcher.flush(); }
