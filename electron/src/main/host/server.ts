/**
 * HostServer — the electron-free host protocol server core.
 *
 * Responsibilities kept here:
 * - the connection registry (per-connection monotonic `seq`, handshake state);
 * - request dispatch (method lookup, handshake gating, params validation);
 * - the event policy: recipient-gated delivery (turn/session events reach the
 *   requesting client plus every client whose active session matches), the
 *   pending approval/question owner-promotion policy, and redelivery on
 *   reconnect — the same `getSessionManager().getActive(clientId)`
 *   information the Electron sink uses (U3/U4 of plan 2026-08-23-001);
 * - runtime hook installation (todos / subagent deltas / working set /
 *   activity / approvals / questions / bg commands / index auto-refresh).
 *
 * Method bindings live in host/bindings/* — per-family tables composed and
 * completeness-guarded by host/bindings/index.ts. Each family receives a
 * {@link HostServerSurface} (capabilities, emitters, pending-store
 * accessors) instead of a closure over this class.
 */
import {
  HOST_CAPABILITIES,
  HOST_ERROR_CODES,
  HOST_HELLO_METHOD,
  PROTOCOL_VERSION,
  HostProtocolError,
  assertProtocolVersionMatches,
  attachHostOriginalError,
  lookupHostMethod,
  type HostCapability,
  type HostEvent,
  type HostRequestId,
  type HostResponse,
} from '../../shared/host/protocol';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { IndexAutoRefreshEvent } from '../../shared/types/ipc-boundary';
import { setTodosChangedNotifier, getSubagentManager } from '../tools';
import { getSessionManager, resolveBoundProjectPath } from '../session/singleton';
import {
  approvalStore,
  type ApprovalSettledEvent,
} from '../permissions/approval-store';
import {
  questionStore,
  type QuestionSettledEvent,
} from '../tools/ask-question/store';
import {
  refreshSessionActivity,
  setSessionActivityBroadcast,
} from '../session/activity-live';
import {
  bootstrapWorkingSet,
  setWorkingSetBroadcast,
} from '../session/working-set-live';
import { sessionWorkingSet } from '../session/working-set';
import { subscribeBackgroundProcessChanges } from '../tools/process/background-store';
import { getStatus as getRagStatus } from '../rag/indexer';
import { getWorkspaceWatcherState } from '../indexing/watcher';
import { setIndexAutoRefreshNotifier } from '../indexing/refresh-coordinator';
import { ASTStore } from '../ast/store';
import { withDisposable } from '../utils/with-disposable';
import { setSubagentsChangedBroadcast } from '../agents/wire-subagents';
import { setSubagentDeltaDelivery } from '../agents/subagent-events';
import {
  setHostEventSink,
  buildSessionUpdatedEvent,
  nextEventIdentity,
  type HostClientId,
  type HostEventSink,
} from './events';
import type { ActiveAgent } from './chat/state';
import { getActiveMainTurnWindowId } from './chat/snapshot';
import { buildHostBindings } from './bindings';
import { pendingApprovalEvent, pendingQuestionEvent } from './bindings/pending-events';
import type { HostBinding, HostServerSurface } from './bindings/types';

export type { HostRequestContext } from './bindings/types';

/** Client identity advertised in `host.hello`, when the peer provides one. */
export type HostServerOptions = {
  /** Capabilities advertised in the handshake; gates capability-scoped methods. */
  readonly capabilities?: readonly HostCapability[];
  /** Server version advertised in the handshake (defaults to '0.0.0-agent'). */
  readonly serverVersion?: string;
};

/** Callback a transport installs to receive one connection's framed events. */
export type HostEventSinkCallback = (event: HostEvent) => void;

interface HostConnectionRecord {
  readonly clientId: string;
  /** Per-connection monotonic event sequence (drives reconnect resync). */
  seq: number;
  /** True once a `host.hello` with a matching protocol version succeeded. */
  helloDone: boolean;
  emit: HostEventSinkCallback;
  /** True when a transport registered the connection (not an implicit one). */
  explicit: boolean;
}

export interface HostConnectionHandle {
  readonly clientId: string;
  /** Stop treating this client as connected; events stop flowing to it. */
  dispose(): void;
}

/** Capabilities the headless `orchid-agent` daemon declares (U4). */
export const DAEMON_CAPABILITIES: readonly HostCapability[] = [
  HOST_CAPABILITIES.CONFIG_WRITE,
  HOST_CAPABILITIES.PROVIDERS_READ,
];

/**
 * Capabilities the Electron-embedded local host declares: everything the
 * daemon can do plus the credential vault (Electron safeStorage is available
 * in-process), which unlocks providers.submit_api_key and api-key-auth
 * connection intents.
 */
export const LOCAL_HOST_CAPABILITIES: readonly HostCapability[] = [
  ...DAEMON_CAPABILITIES,
  HOST_CAPABILITIES.PROVIDERS_VAULT_WRITES,
];

export class HostServer {
  private readonly capabilities: ReadonlySet<string>;
  private readonly serverVersion: string;
  private readonly connections = new Map<string, HostConnectionRecord>();
  private readonly bindings: ReadonlyMap<string, HostBinding<never>>;
  private installed = false;
  private detachHooks: Array<() => void> = [];

  constructor(options: HostServerOptions = {}) {
    this.capabilities = new Set(options.capabilities ?? DAEMON_CAPABILITIES);
    this.serverVersion = options.serverVersion ?? '0.0.0-agent';
    this.bindings = buildHostBindings(this.buildSurface());
    this.install();
  }

  // ── Connection registry ────────────────────────────────────────────────────

  /**
   * Register a connected client. `emit` receives every event this connection
   * is eligible for, already stamped with its per-connection `seq`.
   *
   * Approvals/questions still pending for this client id are re-delivered
   * immediately: a reconnecting owner (renderer reload locally, same client
   * id) resumes its pending prompts without waiting for the resync snapshot.
   */
  addConnection(clientId: string, emit: HostEventSinkCallback): HostConnectionHandle {
    const existing = this.connections.get(clientId);
    if (existing) {
      existing.emit = emit;
      existing.explicit = true;
    } else {
      this.connections.set(clientId, { clientId, seq: 0, helloDone: false, emit, explicit: true });
    }
    this.redeliverPendingTo(clientId);
    return { clientId, dispose: () => this.removeConnection(clientId) };
  }

  removeConnection(clientId: string): void {
    this.connections.delete(clientId);
  }

  listConnections(): string[] {
    return [...this.connections.keys()];
  }

  isConnected(clientId: string): boolean {
    return this.connections.has(clientId);
  }

  /** Pending approvals for reconnect resync, tagged with owner client + createdAt (U10). */
  listPendingApprovals(sessionId?: string) {
    return approvalStore.listPending(sessionId);
  }

  /** Pending questions for reconnect resync, tagged with owner client + createdAt (U10). */
  listPendingQuestions(sessionId?: string) {
    return questionStore.listPending(sessionId);
  }

  /**
   * Re-bind approvals/questions whose owner connection is gone to a
   * (re)connecting client. A remote host assigns a fresh connection id per
   * attach, so a pending entry's owner can never come back as itself; without
   * this rebind the resumed view would show prompts the window could not
   * answer. Mirrors the candidate promotion in the live delivery paths: only
   * pendings for the client's OWN active session are adopted — a client
   * viewing session T must not inherit session S's prompts, which would make
   * it the sole answerer of a prompt it cannot even see. Unmatched pendings
   * stay unbound for the next client that does view their session.
   */
  adoptOrphanedPendingFor(clientId: string): void {
    let resolvedActiveSessionId: string | null | undefined;
    const activeSessionId = (): string | null | undefined => {
      if (resolvedActiveSessionId === undefined) {
        try {
          resolvedActiveSessionId = getSessionManager().getActive(clientId)?.id ?? null;
        } catch {
          resolvedActiveSessionId = null;
        }
      }
      return resolvedActiveSessionId;
    };
    for (const approval of approvalStore.listPending()) {
      if (approval.ownerClientId == null || this.isConnected(approval.ownerClientId)) continue;
      if (activeSessionId() !== approval.sessionId) continue;
      approvalStore.rebindOwnerWindow(approval.toolCallId, clientId);
    }
    for (const question of questionStore.listPending()) {
      if (question.ownerClientId == null || this.isConnected(question.ownerClientId)) continue;
      if (activeSessionId() !== question.sessionId) continue;
      questionStore.rebindOwnerWindow(question.toolCallId, clientId);
    }
  }

  /**
   * Re-deliver approvals/questions still pending for one (re)connecting
   * client. The payloads are byte-identical to the original store events, so
   * a client cannot tell a re-delivery from the first delivery; the store
   * timeouts kept the fail-closed boundary while the client was gone.
   */
  private redeliverPendingTo(clientId: string): void {
    for (const approval of approvalStore.listPending()) {
      if (approval.ownerClientId !== clientId) continue;
      this.emitTo(clientId, IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED, pendingApprovalEvent(approval));
    }
    for (const question of questionStore.listPending()) {
      if (question.ownerClientId !== clientId) continue;
      this.emitTo(clientId, IPC_CHANNELS.ASK_QUESTION_ASKED, pendingQuestionEvent(question));
    }
  }

  /** Connection record for dispatch; an unknown caller gets an implicit one. */
  private ensureConnection(clientId: string): HostConnectionRecord {
    let record = this.connections.get(clientId);
    if (!record) {
      record = { clientId, seq: 0, helloDone: false, emit: () => {}, explicit: false };
      this.connections.set(clientId, record);
    }
    return record;
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────

  async handleRequest(
    request: { readonly id: HostRequestId; readonly method: string; readonly params?: unknown },
    clientId: HostClientId,
  ): Promise<HostResponse> {
    const { id, method } = request;
    try {
      const spec = lookupHostMethod(method);
      if (spec === undefined) {
        throw new HostProtocolError(
          HOST_ERROR_CODES.METHOD_NOT_FOUND,
          `Unknown host method '${method}'`,
        );
      }
      const connection = this.ensureConnection(clientId);
      if (method !== HOST_HELLO_METHOD && !connection.helloDone) {
        throw new HostProtocolError(
          HOST_ERROR_CODES.HANDSHAKE_REQUIRED,
          `Method '${method}' requires a successful ${HOST_HELLO_METHOD} handshake first`,
        );
      }
      let parsed = spec.params.safeParse(request.params);
      if (
        !parsed.success
        && request.params !== null
        && typeof request.params === 'object'
        && Object.keys(request.params).length === 0
      ) {
        // No-params methods are declared as `z.void()` in the registry; a
        // JSON-RPC-style client sending `{}` means "no params", not a type
        // violation. Retry with undefined so only genuinely wrong payloads
        // reject (object schemas still fail on undefined).
        parsed = spec.params.safeParse(undefined);
      }
      if (!parsed.success) {
        throw new HostProtocolError(
          HOST_ERROR_CODES.INVALID_PARAMS,
          `Invalid params for '${method}': ${parsed.error.message}`,
        );
      }
      if (method === HOST_HELLO_METHOD) {
        // Handshake state must flip synchronously during dispatch: a client
        // may pipeline the next request behind `host.hello` on the same tick,
        // and awaiting the binding would race that request's gate check.
        assertProtocolVersionMatches(PROTOCOL_VERSION, parsed.data.protocolVersion);
        connection.helloDone = true;
      }
      const binding = this.bindings.get(method);
      if (binding === undefined) {
        // Registry entries without a runtime binding are unreachable: the
        // composition guard in bindings/index.ts throws at construction for
        // any HOST_METHODS entry left unbound.
        throw new HostProtocolError(
          HOST_ERROR_CODES.METHOD_NOT_FOUND,
          `Method '${method}' has no host binding`,
        );
      }
      const result = await binding({ clientId }, parsed.data as never);
      return { id, ok: true, result: result === undefined ? null : result };
    } catch (error) {
      if (error instanceof HostProtocolError) {
        return { id, ok: false, error: error.toPayload() };
      }
      const message = error instanceof Error ? error.message : String(error);
      // U5 additive fix (error identity): carry the original thrown value on
      // the error leg (non-enumerably — wire encoders never serialize it) so
      // an in-process client rethrows exactly what the binding threw.
      return {
        id,
        ok: false,
        error: attachHostOriginalError(
          { code: HOST_ERROR_CODES.INTERNAL, message },
          error,
        ),
      };
    }
  }

  // ── Event emission (transport-facing) ──────────────────────────────────────

  emitTo(clientId: string, ev: string, params: unknown): void {
    const connection = this.connections.get(clientId);
    if (!connection) return;
    connection.seq += 1;
    try {
      connection.emit({ ev, params, seq: connection.seq });
    } catch (error) {
      console.warn(`[host] event delivery to '${clientId}' failed (non-fatal):`, error);
    }
  }

  /** Clients whose active session is `sessionId` (the pipeline's gating rule). */
  private clientsViewingSession(sessionId: string, include: Iterable<string> = []): string[] {
    const recipients = new Set<string>(include);
    for (const clientId of this.connections.keys()) {
      try {
        if (getSessionManager().getActive(clientId)?.id === sessionId) {
          recipients.add(clientId);
        }
      } catch {
        // Session manager unavailable — skip this candidate.
      }
    }
    return [...recipients];
  }

  private emitToSession(sessionId: string, ev: string, params: unknown, sourceClientId: string | null = null): void {
    for (const clientId of this.clientsViewingSession(sessionId, sourceClientId != null ? [sourceClientId] : [])) {
      this.emitTo(clientId, ev, params);
    }
  }

  emitToAll(ev: string, params: unknown): void {
    for (const clientId of this.connections.keys()) {
      this.emitTo(clientId, ev, params);
    }
  }

  /** Clients whose resolved bound project path is `projectPath` (rag/ast gating). */
  emitToProject(projectPath: string, ev: string, params: unknown): void {
    for (const clientId of this.connections.keys()) {
      if (resolveBoundProjectPath(clientId) === projectPath) {
        this.emitTo(clientId, ev, params);
      }
    }
  }

  private hasCapability(capability: HostCapability): boolean {
    return this.capabilities.has(capability);
  }

  private requireCapability(capability: HostCapability, method: string): void {
    if (!this.hasCapability(capability)) {
      throw new HostProtocolError(
        HOST_ERROR_CODES.UNSUPPORTED_ON_HOST,
        `Method '${method}' requires the '${capability}' capability, which this host does not declare`,
      );
    }
  }

  /** The typed object the binding families receive (see bindings/types.ts). */
  private buildSurface(): HostServerSurface {
    return {
      serverVersion: this.serverVersion,
      capabilities: this.capabilities,
      requireCapability: (capability, method) => this.requireCapability(capability, method),
      emitTo: (clientId, ev, params) => this.emitTo(clientId, ev, params),
      emitToAll: (ev, params) => this.emitToAll(ev, params),
      emitToProject: (projectPath, ev, params) => this.emitToProject(projectPath, ev, params),
      listConnections: () => this.listConnections(),
      adoptOrphanedPendingFor: (clientId) => this.adoptOrphanedPendingFor(clientId),
      listPendingApprovals: (sessionId) => this.listPendingApprovals(sessionId),
      listPendingQuestions: (sessionId) => this.listPendingQuestions(sessionId),
    };
  }

  // ── Runtime hook installation ──────────────────────────────────────────────

  /**
   * Install the daemon event sink and the injected-delivery hooks the agent
   * runtime exposes (todos / subagent deltas / working set / activity /
   * approvals / questions / bg commands / index auto-refresh). Idempotent.
   */
  private install(): void {
    if (this.installed) return;
    this.installed = true;

    setHostEventSink(this.buildSink());

    // Todos are session-scoped but the Electron shell broadcasts them to
    // every window unconditionally; the daemon mirrors that for clients.
    setTodosChangedNotifier((sessionId) => {
      this.emitToAll(IPC_CHANNELS.SESSION_TODOS_CHANGED, { sessionId });
    });

    setSubagentDeltaDelivery({
      deliver: (envelope) => {
        this.emitToSession(envelope.sessionId, IPC_CHANNELS.SUBAGENTS_EVENT, envelope);
      },
      hasEligibleRecipient: (sessionId) =>
        this.clientsViewingSession(sessionId).some((clientId) => this.isConnected(clientId)),
    });

    setSubagentsChangedBroadcast((sessionId) => {
      // void payload: the renderer refetches the subagent snapshot.
      this.emitToSession(sessionId, IPC_CHANNELS.SESSION_SUBAGENTS_CHANGED, undefined);
    });

    setWorkingSetBroadcast((snapshot, sourceClientId) => {
      for (const clientId of this.connections.keys()) {
        // Each client gets its own focus; open membership is shared.
        const perClient = clientId === sourceClientId
          ? snapshot
          : sessionWorkingSet.getSnapshot(clientId);
        this.emitTo(clientId, IPC_CHANNELS.SESSION_WORKING_SET_CHANGED, { snapshot: perClient });
      }
    });

    setSessionActivityBroadcast((activity) => {
      this.emitToAll(IPC_CHANNELS.SESSION_ACTIVITY_CHANGED, { activity });
    });

    this.detachHooks.push(subscribeBackgroundProcessChanges((sessionId) => {
      if (!sessionId) return;
      refreshSessionActivity(sessionId);
      this.emitToSession(sessionId, IPC_CHANNELS.BG_CMD_CHANGED, { sessionId });
    }));

    this.detachHooks.push(getSubagentManager().addOnChangeListener((records) => {
      for (const id of new Set(
        records.map((record) => record.sessionId).filter((sid): sid is string => sid !== null),
      )) {
        refreshSessionActivity(id);
      }
    }));

    this.detachHooks.push(this.subscribeApprovalStore());
    this.detachHooks.push(this.subscribeQuestionStore());

    this.detachHooks.push(this.installIndexAutoRefreshNotifier());

    try {
      bootstrapWorkingSet();
    } catch {
      // empty store — first run has no ui-state.json yet
    }
  }

  /** The daemon HostEventSink: turn/session events as protocol pushes. */
  private buildSink(): HostEventSink {
    return {
      sendTurnEvent: (clientId, active: ActiveAgent, channel: string, payload: Record<string, unknown>) => {
        const identity = nextEventIdentity(active);
        for (const recipient of this.clientsViewingSession(active.sessionId, [clientId])) {
          this.emitTo(recipient, channel, { ...identity, ...payload });
        }
      },
      sendSessionEvent: (clientId, sessionId, channel, payload) => {
        this.emitToSession(sessionId, channel, payload, clientId);
      },
      sendChatState: (clientId, active, payload) => {
        const identity = nextEventIdentity(active);
        for (const recipient of this.clientsViewingSession(active.sessionId, [clientId])) {
          this.emitTo(recipient, IPC_CHANNELS.CHAT_STATE, { ...identity, ...payload });
        }
      },
      emitSessionUpdated: (clientId, sessionId) => {
        try {
          const session = getSessionManager().getSession(sessionId);
          const update = session ? buildSessionUpdatedEvent(session) : null;
          if (update) {
            this.emitToSession(sessionId, IPC_CHANNELS.SESSION_UPDATED, update, clientId);
          }
        } catch {
          // non-fatal
        }
      },
      canDeliverTo: (clientId) => this.isConnected(clientId),
    };
  }

  /**
   * Approval forwarding (U9 offline semantics):
   * - owner client connected → deliver to it (it may answer);
   * - owner unresolvable/unconnected → promote the first connected client
   *   viewing the session (it becomes the answerable owner) and broadcast for
   *   visibility — non-owners' answers are rejected by the
   *   `permission.approval_answer` ownership check;
   * - zero connected clients → keep pending with NO abort; the approval
   *   store's `approval_timeout` timer is the fail-closed boundary (DENIED,
   *   never auto-approved; 0 = wait forever), and the requesting owner stays
   *   bound so a same-id reconnect re-delivers it.
   */
  private subscribeApprovalStore(): () => void {
    const onRequested = (payload: {
      toolCallId: string;
      sessionId: string;
      toolName: string;
      riskClass: unknown;
      args: unknown;
      cwd: string;
      scope?: unknown;
    }) => {
      const { sessionId, toolCallId } = payload;
      const entry = approvalStore.get(toolCallId);
      const ownerClientId = entry?.ownerWindowId ?? getActiveMainTurnWindowId(sessionId);
      if (ownerClientId != null && this.isConnected(ownerClientId)) {
        approvalStore.bindOwnerWindow(toolCallId, ownerClientId);
        this.emitTo(ownerClientId, IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED, payload);
        return;
      }
      // Unresolvable owner: promote the first connected client viewing the
      // session so the approval stays answerable, and notify everyone.
      // `rebind`, not `bind`: an approval is created WITH its owner set, and
      // bind refuses to move an existing binding — a plain bind here would
      // broadcast a prompt that the disconnected owner (and nobody else)
      // could answer, leaving the tool denied at the timeout.
      const candidates = this.clientsViewingSession(sessionId);
      if (candidates.length > 0) {
        approvalStore.rebindOwnerWindow(toolCallId, candidates[0]);
      } else if (ownerClientId != null) {
        // Nobody connected can take it: keep the requesting owner bound so a
        // same-id reconnect re-delivers; the store timeout settles fail-closed.
        approvalStore.bindOwnerWindow(toolCallId, ownerClientId);
      }
      this.emitToAll(IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED, payload);
    };
    const onSettled = ({ sessionId, toolCallId, ownerWindowId, result }: ApprovalSettledEvent) => {
      const payload = { sessionId, toolCallId, result };
      if (ownerWindowId != null && this.isConnected(ownerWindowId)) {
        this.emitTo(ownerWindowId, IPC_CHANNELS.PERMISSION_APPROVAL_SETTLED, payload);
        return;
      }
      this.emitToAll(IPC_CHANNELS.PERMISSION_APPROVAL_SETTLED, payload);
    };
    approvalStore.on('approval-requested', onRequested);
    approvalStore.on('approval-settled', onSettled);
    return () => {
      approvalStore.off('approval-requested', onRequested);
      approvalStore.off('approval-settled', onSettled);
    };
  }

  /** ask_question forwarding, symmetric with approvals. */
  private subscribeQuestionStore(): () => void {
    const onAsked = (payload: { sessionId: string; toolCallId: string; questions: unknown[] }) => {
      const { sessionId, toolCallId } = payload;
      const entry = questionStore.get(toolCallId);
      const ownerClientId = entry?.ownerWindowId ?? getActiveMainTurnWindowId(sessionId);
      if (ownerClientId != null && this.isConnected(ownerClientId)) {
        questionStore.bindOwnerWindow(toolCallId, ownerClientId);
        this.emitTo(ownerClientId, IPC_CHANNELS.ASK_QUESTION_ASKED, payload);
        return;
      }
      const candidates = this.clientsViewingSession(sessionId);
      if (candidates.length > 0) {
        // Unlike approvals, a question starts owner-null (questionStore.create
        // takes no owner), so a plain bind always succeeds here.
        questionStore.bindOwnerWindow(toolCallId, candidates[0]);
      } else if (ownerClientId != null) {
        questionStore.bindOwnerWindow(toolCallId, ownerClientId);
      }
      this.emitToAll(IPC_CHANNELS.ASK_QUESTION_ASKED, payload);
    };
    const onSettled = ({ sessionId, toolCallId, ownerWindowId, result }: QuestionSettledEvent) => {
      const payload = { sessionId, toolCallId, result };
      if (ownerWindowId != null && this.isConnected(ownerWindowId)) {
        this.emitTo(ownerWindowId, IPC_CHANNELS.ASK_QUESTION_SETTLED, payload);
        return;
      }
      this.emitToAll(IPC_CHANNELS.ASK_QUESTION_SETTLED, payload);
    };
    questionStore.on('question-asked', onAsked);
    questionStore.on('question-settled', onSettled);
    return () => {
      questionStore.off('question-asked', onAsked);
      questionStore.off('question-settled', onSettled);
    };
  }

  /**
   * `index:auto_refresh` lifecycle pushes, mirroring the Electron broadcast:
   * only clients bound to the flushed project receive them, and `landed` is
   * expanded into fresh post-flush status snapshots.
   */
  private installIndexAutoRefreshNotifier(): () => void {
    setIndexAutoRefreshNotifier((projectPath, event) => {
      let payload: IndexAutoRefreshEvent;
      if (event.phase === 'landed') {
        payload = { phase: 'landed' };
        if (event.rag) {
          const status = getRagStatus(projectPath);
          try {
            payload.rag = {
              ...status,
              watcher: { watching: getWorkspaceWatcherState(projectPath).watching },
            };
          } catch {
            payload.rag = status;
          }
        }
        if (event.ast) {
          payload.ast = withDisposable(
            new ASTStore(projectPath),
            (store) => store.status(),
          );
        }
      } else {
        payload = event;
      }
      this.emitToProject(projectPath, IPC_CHANNELS.INDEX_AUTO_REFRESH, payload);
    });
    return () => setIndexAutoRefreshNotifier(null);
  }

  /**
   * Graceful shutdown of the server surface: remove listeners and restore the
   * injected-delivery defaults. In-flight turns are NOT aborted — the daemon
   * keeps running them (R5); transports closing is the caller's business.
   */
  dispose(): void {
    if (!this.installed) return;
    this.installed = false;
    for (const detach of this.detachHooks.splice(0)) {
      try {
        detach();
      } catch (error) {
        console.warn('[host] detach hook failed during dispose (non-fatal):', error);
      }
    }
    setHostEventSink(null);
    setTodosChangedNotifier(() => {});
    setSubagentDeltaDelivery(null);
    setSubagentsChangedBroadcast(null);
    setWorkingSetBroadcast(null);
    setSessionActivityBroadcast(null);
    this.connections.clear();
  }
}

/** Convenience factory used by the daemon entry and tests. */
export function createHostServer(options: HostServerOptions = {}): HostServer {
  return new HostServer(options);
}
