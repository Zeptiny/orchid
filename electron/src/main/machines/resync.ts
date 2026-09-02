/**
 * Remote reconnect resync (issue #112, plan unit U10, requirement R6).
 *
 * After a remote machine's client (re)handshakes, the app must land on the
 * same complete state as a fresh open — no duplicate events, no lost
 * messages. The per-connection protocol `seq` resets on every new connection
 * (`remote-clients.ts` attaches a fresh `HostClient` per transport), so
 * events from before the gap are never replayed; this snapshot IS the
 * catch-up.
 *
 * Division of labor:
 * - The renderer re-fetches everything it can ask for itself through its
 *   machine-scoped refresh + forced session re-open (session list, workspace,
 *   providers, messages, live snapshot).
 * - This module pushes the pieces a reconnecting window CANNOT re-fetch:
 *   pending approvals/questions (their owner-scoped snapshots answer [] for
 *   the fresh connection id a remote host assigned) plus reload signals for
 *   the background-command fleet and live subagents. Every push reuses an
 *   existing channel with its existing payload shape — the renderer reducers
 *   are idempotent by design, so a re-broadcast is indistinguishable from
 *   the first delivery and cannot duplicate UI state.
 */
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type {
  AskQuestionAskedEvent,
  PermissionApprovalRequestedEvent,
} from '../../shared/types/ipc';
import type { HostClient } from '../host/client';
import { deliverToMachineWindows } from './remote-clients';

/** Live (non-terminal) subagent statuses — mirrors useSubagents' tick gate. */
const LIVE_SUBAGENT_STATUSES = new Set(['running', 'pending', 'queued']);

/** The `host.pending_state` view resync consumes (#19). */
interface PendingStateView {
  readonly approvals?: PermissionApprovalRequestedEvent[];
  readonly questions?: AskQuestionAskedEvent[];
  /**
   * Caller client's active session + live-turn presence. Absent on an older
   * host — resync degrades to "no active session" rather than fetching a
   * full chat.snapshot (whole-history serialization) to learn it.
   */
  readonly activeSession?: {
    readonly sessionId: string | null;
    readonly live: {
      readonly state: string;
      readonly startedAt: number | null;
    } | null;
  };
}

interface SubagentSnapshotView {
  readonly records: ReadonlyArray<{ status: string }>;
}

interface BgCommandListItem {
  readonly running?: boolean;
}

/** The resync snapshot fetched from a remote host after (re)handshake. */
export interface RemoteResyncSnapshot {
  /** Every session id the host reports (validated, not re-broadcast). */
  readonly sessionIds: readonly string[];
  /** The host's active session for this machine client, if any. */
  readonly activeSessionId: string | null;
  /** Live (non-terminal) main-agent turn on the active session, if any. */
  readonly liveTurn: { readonly state: string; readonly startedAt: number | null } | null;
  /** Live (non-terminal) subagents on the active session. */
  readonly liveSubagentCount: number;
  /** The active session has background commands (running or exited). */
  readonly hasBackgroundCommands: boolean;
  /** Pending approvals, owner-stripped to the live event payload. */
  readonly approvals: readonly PermissionApprovalRequestedEvent[];
  /** Pending questions, owner-stripped to the live event payload. */
  readonly questions: readonly AskQuestionAskedEvent[];
}

/**
 * One piece of the catch-up; a failure degrades to the fallback and NEVER
 * aborts the remaining pieces or the approvals/questions re-broadcast (#22) —
 * one unreachable datum (e.g. an older agent without `host.pending_state`)
 * must not starve the rest of the resync.
 */
async function fetchPiece<T>(run: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.warn(`[machine-resync] '${label}' failed (non-fatal):`, error);
    return fallback;
  }
}

/**
 * Fetch the reconnect catch-up from a remote host. Every piece degrades to
 * its empty value on failure; `session.list` enumerates the host's sessions
 * and `host.pending_state` returns every pending approval/question (the
 * owner-scoped snapshots cannot serve a reconnected client whose connection
 * id changed) PLUS the caller's active session and live-turn presence (#19)
 * — the bounded facts the old full `chat.snapshot` round-trip was fetched
 * for. `subagents.snapshot` and `bgcmd.list` scope to that active session.
 */
export async function fetchRemoteResyncSnapshot(
  client: HostClient,
): Promise<RemoteResyncSnapshot> {
  const sessions = await fetchPiece(
    () => client.request<Array<{ id: string }>>('session.list'),
    [] as Array<{ id: string }>,
    'session.list',
  );

  const pending = await fetchPiece(
    () => client.request<PendingStateView>('host.pending_state', {}),
    {} as PendingStateView,
    'host.pending_state',
  );
  const activeSessionId = pending.activeSession?.sessionId ?? null;
  const liveTurn = pending.activeSession?.live
    ? {
      state: pending.activeSession.live.state,
      startedAt: pending.activeSession.live.startedAt ?? null,
    }
    : null;

  let liveSubagentCount = 0;
  let hasBackgroundCommands = false;
  if (activeSessionId !== null) {
    const subagents = await fetchPiece(
      () => client.request<SubagentSnapshotView>('subagents.snapshot', { sessionId: activeSessionId }),
      { records: [] } as SubagentSnapshotView,
      'subagents.snapshot',
    );
    liveSubagentCount = subagents.records.filter(
      (record) => LIVE_SUBAGENT_STATUSES.has(record.status),
    ).length;

    // bgcmd.list is session-privileged: with no explicit sessionId the host
    // scopes it to the same active session.
    const background = await fetchPiece(
      () => client.request<BgCommandListItem[]>('bgcmd.list', {}),
      [] as BgCommandListItem[],
      'bgcmd.list',
    );
    hasBackgroundCommands = background.length > 0;
  }

  return {
    sessionIds: sessions.map((session) => session.id),
    activeSessionId,
    liveTurn,
    liveSubagentCount,
    hasBackgroundCommands,
    approvals: pending.approvals ?? [],
    questions: pending.questions ?? [],
  };
}

/**
 * Re-broadcast the catch-up to every window driving this machine through the
 * existing window-broadcast path — same channels, same payload shapes a live
 * delivery (or a fresh open) produces, so the idempotent renderer reducers
 * apply them without any resync-specific code.
 */
export function broadcastRemoteResync(
  machineId: string,
  snapshot: RemoteResyncSnapshot,
): void {
  for (const approval of snapshot.approvals) {
    deliverToMachineWindows(machineId, IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED, approval);
  }
  for (const question of snapshot.questions) {
    deliverToMachineWindows(machineId, IPC_CHANNELS.ASK_QUESTION_ASKED, question);
  }
  if (snapshot.activeSessionId !== null && snapshot.hasBackgroundCommands) {
    // Pure reload signal: the owning window's fleet hook re-lists its session.
    deliverToMachineWindows(machineId, IPC_CHANNELS.BG_CMD_CHANGED, {
      sessionId: snapshot.activeSessionId,
    });
  }
  if (snapshot.activeSessionId !== null && snapshot.liveSubagentCount > 0) {
    // Void payload reload signal: the renderer refetches the subagent snapshot.
    deliverToMachineWindows(machineId, IPC_CHANNELS.SESSION_SUBAGENTS_CHANGED, undefined);
  }
}

/** Fetch and re-broadcast the reconnect catch-up for one machine. */
export async function resyncRemoteMachine(
  machineId: string,
  client: HostClient,
): Promise<RemoteResyncSnapshot> {
  const snapshot = await fetchRemoteResyncSnapshot(client);
  broadcastRemoteResync(machineId, snapshot);
  return snapshot;
}
