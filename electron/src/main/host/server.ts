/**
 * HostServer — binds the (electron-free) turn pipeline and core services to
 * the host protocol methods and pushes protocol events to connected clients.
 *
 * Each connected client (an Electron window id locally, a connection id on a
 * headless host) gets a per-connection monotonic event `seq`. Event delivery
 * replicates the Electron window-broadcast gating — turn/session events reach
 * the requesting client plus every other client whose active session matches
 * — using the same `getSessionManager().getActive(clientId)` information the
 * Electron sink uses (U3/U4 of plan 2026-08-23-001).
 *
 * Bindings are deliberately thin: every method delegates to the relocated
 * pipeline (host/chat/*, host/bgcmd.ts, host/subagents.ts, host/session-ops.ts)
 * or to a core service; nothing here reimplements pipeline policy.
 */
import {
  HOST_CAPABILITIES,
  HOST_ERROR_CODES,
  HOST_HELLO_METHOD,
  HOST_METHODS,
  PROTOCOL_VERSION,
  HostProtocolError,
  assertProtocolVersionMatches,
  attachHostOriginalError,
  lookupHostMethod,
  type HostCapability,
  type HostEvent,
  type HostHelloParams,
  type HostRequestId,
  type HostResponse,
} from '../../shared/host/protocol';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type {
  AskQuestionAskedEvent,
  PermissionApprovalRequestedEvent,
} from '../../shared/types/ipc';
import type { IndexAutoRefreshEvent } from '../../shared/types/ipc-boundary';
import type { PermissionMode } from '../../shared/types/permission';
import { flattenSessionMessages, sessionForRenderer } from '../../shared/types/session';
import { lastChainError } from '../../shared/types/chain';
import { setTodosChangedNotifier } from '../tools';
import { toolRegistry } from '../tools';
import { RENDERER_ALLOWED_TOOLS } from '../ipc/payload-schemas';
import { getSessionManager, resolveBoundProjectPath, resolveWindowWorkspace } from '../session/singleton';
import { setDraftTierOverride } from '../session/draft-tier';
import { setDraftReasoningOverride, takeDraftReasoningOverride } from '../session/draft-reasoning';
import { takeDraftPermissionOverride } from '../permissions/session-overrides';
import {
  getDraftPermissionOverride,
  setDraftPermissionOverride,
  sessionPermissionOverrides,
} from '../permissions/session-overrides';
import {
  approvalStore,
  type ApprovalSettledEvent,
  type PendingApprovalWithOwner,
} from '../permissions/approval-store';
import { hydrateSessionPermissionOverride } from '../permissions/session-overrides';
import { clearToolCallHistoryForSession } from '../permissions/history';
import {
  questionStore,
  type PendingQuestionWithOwner,
  type QuestionSettledEvent,
} from '../tools/ask-question/store';
import {
  listSessionActivity,
  markSessionActivitySeen,
  reconcileSessionActivity,
  refreshSessionActivity,
  removeSessionActivity,
  setSessionActivityBroadcast,
} from '../session/activity-live';
import {
  bootstrapWorkingSet,
  filterIfCatalogOk,
  mutateAndPersist,
  setWorkingSetBroadcast,
  tryListSessionCatalog,
  workingSetClearFocus,
  workingSetOpenOrFocus,
  workingSetRemove,
} from '../session/working-set-live';
import { sessionWorkingSet } from '../session/working-set';
import {
  getBackgroundStore,
  subscribeBackgroundProcessChanges,
} from '../tools/process/background-store';
import { clearChatHistory } from '../ipc/chat-history';
import { getSubagentManager } from '../tools';
import { getConfig } from '../config/loader';
import {
  loadHomeConfig,
  readProjectConfig,
  saveHomeConfigUpdates,
  saveProjectConfigUpdates,
} from '../config/persist';
import { resolveAuthorizedProjectDir } from '../ipc/project-target';
import { clearFunctionHashesForWorkspace, clearFunctionHashesForSession } from '../tools/ast/get-function';
import { canonicalizeProjectDirectory } from '../project/path';
import {
  clearDraftCwd,
  getDraftCwd,
  isWorkspaceBound,
  setDraftCwd,
} from '../project/workspace';
import {
  buildProjectTrustReport,
  getProjectTrustState,
  grantProjectTrust,
  listTrustedProjects,
} from '../project/trust';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { ensureWorkspaceWatcherStarted } from '../indexing/watcher';
import { setIndexAutoRefreshNotifier } from '../indexing/refresh-coordinator';
import { invalidateProjectMCPManagers, getProjectMCPManager } from '../mcp/project-registry';
import { getStatus as getRagStatus, clearIndex, cancelIndex, indexProject, isIndexing as isRagIndexing } from '../rag/indexer';
import { cancelProjectRefreshAsync } from '../indexing/refresh-coordinator';
import { getWorkspaceWatcherState } from '../indexing/watcher';
import { indexProject as indexAstProject, isIndexing as isAstIndexing } from '../ast/indexer';
import { ASTStore } from '../ast/store';
import { withDisposable } from '../utils/with-disposable';
import {
  deleteAgent,
  deletePersonality,
  deleteSharedPrompt,
  deleteSkill,
  saveAgent,
  savePersonality,
  saveSharedPrompt,
  saveSkill,
} from '../defs/manage';
import { listDefinitions } from '../defs/listing';
import { reloadDefinitionRegistries } from '../defs/reload';
import {
  executeToolCall,
  genericTerminalExecution,
} from '../llm/tool-dispatch';
import {
  setHostEventSink,
  buildSessionUpdatedEvent,
  nextEventIdentity,
  type HostClientId,
  type HostEventSink,
} from './events';
import type { ActiveAgent } from './chat/state';
import { activeAgents } from './chat/state';
import { sendSessionEvent as pipelineSendSessionEvent } from './chat/events';
import { snapshotForAgent, getLiveChatSnapshot, getActiveMainTurnWindowId } from './chat/snapshot';
import { startChatTurn } from './chat/send';
import { requestChatCancel } from './chat/cancel';
import { compactSessionNow } from './chat/compaction';
import { discardDeletedSessionRuntime, forceAbortMainTurn, forceStopSession } from './chat/abort';
import {
  bindProjectDirectory,
  reconcileClientWatcher,
  retargetWorkspaceWatcher,
  revokeProjectTrustForDir,
  seedCompleteChatHistory,
  startOpenedSessionSubagentHydration,
} from './session-ops';
import { createSubagentDetail, createSubagentSnapshot } from './subagents';
import {
  bgCommandList,
  bgCommandReleaseInput,
  bgCommandSendInput,
  bgCommandSnapshot,
  bgCommandTerminate,
} from './bgcmd';
import { setSubagentsChangedBroadcast } from '../agents/wire-subagents';
import { setSubagentDeltaDelivery } from '../agents/subagent-events';
import { requestNextRequestStop, clearNextRequestStop } from '../agents/next-request-stop';
import {
  overview as providerOverview,
  validateConnection,
  disableConnection,
  enableConnection,
  disconnectConnection,
  deleteConnection,
  discoverModels,
  listModelOptions,
  refreshQuota,
  refreshStatus,
  statusView,
  withConnectionMutationLock,
} from '../providers/views';

/** Client identity advertised in `host.hello`, when the peer provides one. */
export type HostServerOptions = {
  /** Capabilities advertised in the handshake; gates capability-scoped methods. */
  readonly capabilities?: readonly HostCapability[];
  /** Server version advertised in the handshake (defaults to '0.0.0-agent'). */
  readonly serverVersion?: string;
};

/**
 * Owner-stripped event payload for one pending approval — byte-identical to
 * the store's live `permission:approval_requested` event, so a resync
 * re-broadcast is indistinguishable from the first delivery.
 */
function pendingApprovalEvent(approval: PendingApprovalWithOwner): PermissionApprovalRequestedEvent {
  return {
    toolCallId: approval.toolCallId,
    sessionId: approval.sessionId,
    toolName: approval.toolName,
    riskClass: approval.riskClass,
    args: approval.args,
    cwd: approval.cwd,
    ...(approval.scope !== undefined ? { scope: approval.scope } : {}),
  };
}

/** Owner-stripped event payload for one pending question (see above). */
function pendingQuestionEvent(question: PendingQuestionWithOwner): AskQuestionAskedEvent {
  return {
    sessionId: question.sessionId,
    toolCallId: question.toolCallId,
    // The store keeps the tool-call's question array untyped; the wire payload
    // is exactly what the live event delivers (askQuestionAskedEventSchema).
    questions: question.questions as AskQuestionAskedEvent['questions'],
  };
}

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

/** Execution context handed to every method binding. */
export interface HostRequestContext {
  readonly clientId: HostClientId;
}

type HostBinding<P = unknown> = (ctx: HostRequestContext, params: P) => unknown | Promise<unknown>;

/** Capabilities the headless `orchid-agent` daemon declares (U4). */
export const DAEMON_CAPABILITIES: readonly HostCapability[] = [
  HOST_CAPABILITIES.CONFIG_WRITE,
  HOST_CAPABILITIES.PROVIDERS_READ,
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
    this.bindings = buildBindings(() => this);
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
  listPendingApprovals(sessionId?: string): PendingApprovalWithOwner[] {
    return approvalStore.listPending(sessionId);
  }

  /** Pending questions for reconnect resync, tagged with owner client + createdAt (U10). */
  listPendingQuestions(sessionId?: string): PendingQuestionWithOwner[] {
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

  // Public accessors for the closure-based bindings (kept minimal on purpose).

  get serverVersionPublic(): string {
    return this.serverVersion;
  }

  get capabilitiesPublic(): ReadonlySet<string> {
    return this.capabilities;
  }

  requireCapabilityPublic(capability: HostCapability, method: string): void {
    this.requireCapability(capability, method);
  }

  emitToPublic(clientId: string, ev: string, params: unknown): void {
    this.emitTo(clientId, ev, params);
  }

  emitToAllPublic(ev: string, params: unknown): void {
    this.emitToAll(ev, params);
  }

  emitToProjectPublic(projectPath: string, ev: string, params: unknown): void {
    this.emitToProject(projectPath, ev, params);
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
        // Registry entries without a runtime binding are unreachable today
        // (vault writes are absent from HOST_METHODS by construction).
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

  private emitTo(clientId: string, ev: string, params: unknown): void {
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

  private emitToAll(ev: string, params: unknown): void {
    for (const clientId of this.connections.keys()) {
      this.emitTo(clientId, ev, params);
    }
  }

  /** Clients whose resolved bound project path is `projectPath` (rag/ast gating). */
  private emitToProject(projectPath: string, ev: string, params: unknown): void {
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

// ── Method bindings ──────────────────────────────────────────────────────────

/** Params types for the methods whose bodies read them. */
type ChatSendParams = Parameters<typeof startChatTurn>[1];
type BgSnapshotParams = Parameters<typeof bgCommandSnapshot>[0];

function buildBindings(server: () => HostServer): ReadonlyMap<string, HostBinding<never>> {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  const requireCapability = (capability: HostCapability, method: string) =>
    server().requireCapabilityPublic(capability, method);

  // ── handshake ──────────────────────────────────────────────────────────────
  bind('host.hello', (_ctx, params: HostHelloParams) => {
    assertProtocolVersionMatches(PROTOCOL_VERSION, params.protocolVersion);
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: server().serverVersionPublic,
      capabilities: [...server().capabilitiesPublic],
    };
  });

  // ── chat ───────────────────────────────────────────────────────────────────
  bind('chat.send', (ctx, params: ChatSendParams) => startChatTurn(ctx.clientId, params));
  bind('chat.cancel', (ctx, params: { sessionId?: string | null }) =>
    requestChatCancel(ctx.clientId, params));
  bind('chat.queue_next', (_ctx, params: { sessionId: string }) => {
    requestNextRequestStop(params.sessionId);
    return null;
  });
  bind('chat.stop', (_ctx, params: { sessionId: string }) => ({
    status: forceStopSession(params.sessionId) ? 'stopped' : 'no_active_stream',
  }));
  bind('chat.snapshot', (ctx, params: { sessionId?: string | null }) => {
    const sessionId = params.sessionId ?? getSessionManager().getActive(ctx.clientId)?.id;
    if (!sessionId) return null;
    const session = getSessionManager().getSession(sessionId);
    if (!session) return null;
    const liveAgent = activeAgents.get(sessionId);
    const live = liveAgent && !liveAgent.finalized ? snapshotForAgent(liveAgent) : null;
    return {
      sessionId,
      messages: liveAgent && live ? [...liveAgent.messages] : flattenSessionMessages(session),
      live,
      lastChainError: live ? null : lastChainError(session.chains),
    };
  });
  bind('chat.compact', (ctx, params: { sessionId?: string | null }) => {
    const sessionId = params.sessionId ?? getSessionManager().getActive(ctx.clientId)?.id;
    if (!sessionId) {
      return { status: 'nothing_to_compact', sessionId: '', detail: 'No active session to compact.' };
    }
    const session = getSessionManager().getSession(sessionId);
    if (!session) {
      return { status: 'nothing_to_compact', sessionId, detail: 'Session not found.' };
    }
    const boundCwd = session.cwd?.trim();
    if (!boundCwd || getProjectTrustState(boundCwd) !== 'trusted') {
      return { status: 'nothing_to_compact', sessionId, detail: 'The project folder for this session is not trusted.' };
    }
    const runtime = getProjectRuntimeRegistry().get(boundCwd);
    const selection = session.selection ?? runtime.config.default_model;
    if (!selection) {
      return { status: 'nothing_to_compact', sessionId, detail: 'A provider connection and model are required before compacting.' };
    }
    return compactSessionNow(sessionId, runtime, selection);
  });

  // ── subagents ──────────────────────────────────────────────────────────────
  bind('subagents.snapshot', (_ctx, params: { sessionId: string }) =>
    createSubagentSnapshot(params.sessionId));
  bind('subagents.detail', (_ctx, params: { sessionId: string; subagentId: string }) =>
    createSubagentDetail(params.sessionId, params.subagentId));

  // ── sessions ───────────────────────────────────────────────────────────────
  const emitWorkspaceChanged = (ctx: HostRequestContext, workspace: unknown) => {
    server().emitToPublic(ctx.clientId, IPC_CHANNELS.SESSION_WORKSPACE_CHANGED, { workspace });
  };

  bind('session.list', () => getSessionManager().listSaved());

  bind('session.load', (ctx, params: { id: string; activate?: boolean }) => {
    const manager = getSessionManager();
    const { id, activate } = params;
    // Read-only peek (todos / subagents refresh) — do not switch or reseed.
    if (!activate) {
      const session = manager.load(id);
      return session ? sessionForRenderer(session) : null;
    }
    const releasedDraftCwd = getDraftCwd(ctx.clientId);
    const session = manager.switchTo(id, ctx.clientId);
    if (session) {
      workingSetOpenOrFocus(session.id, ctx.clientId);
      hydrateSessionPermissionOverride(session.id, session.permissionMode);
      startOpenedSessionSubagentHydration(session.id, ctx.clientId);
    } else {
      workingSetRemove(id, ctx.clientId);
    }
    clearDraftCwd(ctx.clientId);
    if (releasedDraftCwd) {
      // Best-effort hash cache cleanup for the released draft workspace.
      try {
        clearFunctionHashesForWorkspace(releasedDraftCwd);
      } catch {
        // non-fatal
      }
    }
    if (session) {
      seedCompleteChatHistory(session);
    } else {
      clearChatHistory(id);
    }
    const workspace = resolveWindowWorkspace(ctx.clientId);
    retargetWorkspaceWatcher(ctx.clientId, workspace.cwd);
    emitWorkspaceChanged(ctx, workspace);
    return session ? sessionForRenderer(session) : null;
  });

  bind('session.open', (ctx, params: { id: string }) => {
    const manager = getSessionManager();
    const { id } = params;
    const session = manager.switchTo(id, ctx.clientId);
    if (session) {
      workingSetOpenOrFocus(session.id, ctx.clientId);
      hydrateSessionPermissionOverride(session.id, session.permissionMode);
      startOpenedSessionSubagentHydration(session.id, ctx.clientId);
    } else {
      workingSetRemove(id, ctx.clientId);
    }
    clearDraftCwd(ctx.clientId);
    const messages = session ? flattenSessionMessages(session) : [];
    if (session) {
      seedCompleteChatHistory(session, messages);
    } else {
      clearChatHistory(id);
    }
    const workspace = resolveWindowWorkspace(ctx.clientId);
    retargetWorkspaceWatcher(ctx.clientId, workspace.cwd);
    emitWorkspaceChanged(ctx, workspace);
    const live = getLiveChatSnapshot(id);
    return {
      session: session ? sessionForRenderer(session) : null,
      messages,
      live,
      workspace,
      lastChainError: session && !live ? lastChainError(session.chains) : null,
    };
  });

  bind('session.history_page', (_ctx, params: {
    sessionId: string; chainId: string; beforeIndex?: number;
  }) => getSessionManager().getHistoryPage(params.sessionId, params.chainId, params.beforeIndex));

  bind('session.create', (ctx) => {
    const manager = getSessionManager();
    const workspace = resolveWindowWorkspace(ctx.clientId);
    if (!isWorkspaceBound(workspace) || workspace.cwd == null) {
      throw new Error('Cannot create session: no project folder selected. Choose a folder first.');
    }
    const cwd = workspace.cwd;
    if (getProjectTrustState(cwd) !== 'trusted') {
      throw new Error('Cannot create session: project folder is not trusted. Trust the project first.');
    }
    const config = getProjectRuntimeRegistry().get(cwd).config;
    const created = manager.create(config.default_model, { cwd }, ctx.clientId);
    const draftOverride = takeDraftReasoningOverride(ctx.clientId);
    if (draftOverride !== undefined) {
      manager.setReasoningEffortOverride(created.id, draftOverride);
    }
    const draftPermission = takeDraftPermissionOverride(ctx.clientId);
    if (draftPermission !== undefined) {
      manager.setPermissionMode(created.id, draftPermission);
    }
    const session = manager.getSession(created.id) ?? created;
    // Draft was promoted into the session.
    clearDraftCwd(ctx.clientId);
    clearChatHistory(session.id);
    workingSetOpenOrFocus(session.id, ctx.clientId);
    server().emitToPublic(ctx.clientId, IPC_CHANNELS.SESSION_CREATED, { session });
    emitWorkspaceChanged(ctx, resolveWindowWorkspace(ctx.clientId));
    return session;
  });

  bind('session.clear_active', (ctx) => {
    const manager = getSessionManager();
    const selected = manager.getActive(ctx.clientId);
    if (selected?.cwd) setDraftCwd(ctx.clientId, selected.cwd);
    manager.clearActive(ctx.clientId);
    workingSetClearFocus(ctx.clientId);
    const workspace = resolveWindowWorkspace(ctx.clientId);
    emitWorkspaceChanged(ctx, workspace);
    return { status: 'cleared' };
  });

  bind('session.delete', (ctx, params: { id: string }) => {
    const manager = getSessionManager();
    const wasActive = manager.getActive(ctx.clientId)?.id === params.id;
    const deleted = manager.delete(params.id);
    // A deleted background session must not keep spending provider/tool work.
    discardDeletedSessionRuntime(params.id);
    sessionPermissionOverrides.delete(params.id);
    approvalStore.cancelAllForSession(params.id);
    clearToolCallHistoryForSession(params.id);
    // U5 additive fix (parity with the Electron handler this binding replaced):
    // a deleted session must also drop its AST function-hash cache entries.
    clearFunctionHashesForSession(params.id);
    clearNextRequestStop(params.id);
    removeSessionActivity(params.id);
    const workingSet = workingSetRemove(params.id, ctx.clientId);
    clearChatHistory(params.id);
    // Durable-deletion fan-out: every connected client loses its copy, each
    // with its own working-set snapshot.
    for (const clientId of server().listConnections()) {
      const perClient = clientId === ctx.clientId
        ? workingSet
        : workingSetRemove(params.id, clientId);
      server().emitToPublic(clientId, IPC_CHANNELS.SESSION_DELETED, {
        id: params.id,
        workingSet: perClient,
      });
    }
    if (deleted && wasActive) {
      const workspace = resolveWindowWorkspace(ctx.clientId);
      retargetWorkspaceWatcher(ctx.clientId, workspace.cwd);
      emitWorkspaceChanged(ctx, workspace);
    }
    return { status: deleted ? 'deleted' : 'not_found', workingSet };
  });

  bind('session.rename', (ctx, params: { id: string; name: string }) => {
    const manager = getSessionManager();
    const existing = manager.getSession(params.id);
    if (!existing) return { status: 'not_found' };
    if (existing.name === params.name) {
      return { status: 'unchanged', name: existing.name };
    }
    manager.rename(params.id, params.name);
    const after = manager.getSession(params.id);
    if (!after || after.name !== params.name) {
      return { status: 'not_active' };
    }
    pipelineSendSessionEvent(ctx.clientId, params.id, IPC_CHANNELS.SESSION_RENAMED, {
      id: params.id,
      name: params.name,
    });
    return { status: 'renamed' };
  });

  bind('session.change_model', (_ctx, params: {
    id: string;
    selection?: { connectionId: string; modelId: string } | null;
    modelLabel?: string | null;
  }) => {
    const manager = getSessionManager();
    const selection = params.selection ?? null;
    const existing = manager.getSession(params.id);
    if (!existing) return { status: 'not_found' };
    const nextLabel = params.modelLabel ?? selection?.modelId ?? null;
    const sameSelection =
      (existing.selection === null && selection === null) ||
      (existing.selection !== null &&
        selection !== null &&
        existing.selection.connectionId === selection.connectionId &&
        existing.selection.modelId === selection.modelId);
    if (sameSelection && existing.modelLabel === nextLabel) {
      return {
        status: 'unchanged',
        selection: existing.selection,
        modelLabel: existing.modelLabel,
      };
    }
    manager.changeModel(params.id, selection, nextLabel);
    const after = manager.getSession(params.id);
    if (!after) return { status: 'not_found' };
    const afterSame =
      (after.selection === null && selection === null) ||
      (after.selection !== null &&
        selection !== null &&
        after.selection.connectionId === selection.connectionId &&
        after.selection.modelId === selection.modelId);
    if (!afterSame || after.modelLabel !== nextLabel) {
      return { status: 'not_active' };
    }
    return {
      status: 'changed',
      selection: after.selection,
      modelLabel: after.modelLabel,
    };
  });

  bind('session.get_workspace', (ctx) => {
    const workspace = resolveWindowWorkspace(ctx.clientId);
    reconcileClientWatcher(ctx.clientId, workspace);
    return workspace;
  });

  bind('session.pick_project_dir', (_ctx) => {
    requireCapability(HOST_CAPABILITIES.SESSION_PICK_PROJECT_DIR, 'session.pick_project_dir');
    // Capability declared only by an Electron-hosted transport that installs a
    // native dialog (U5); the headless daemon never declares it.
    throw new Error('session.pick_project_dir requires a host-native dialog transport.');
  });

  bind('session.set_workspace', async (ctx, params: { cwd: string }) => {
    const workspace = await bindProjectDirectory(ctx.clientId, params.cwd);
    emitWorkspaceChanged(ctx, workspace);
    return workspace;
  });

  bind('session.change_cwd', async (ctx, params: { id: string; cwd: string }) => {
    const manager = getSessionManager();
    const active = manager.getActive(ctx.clientId);
    if (!active || active.id !== params.id) {
      throw new Error('Cannot change project for a session that is not selected.');
    }
    const hadConversation = active.chains.length > 0;
    const workspace = await bindProjectDirectory(ctx.clientId, params.cwd);
    emitWorkspaceChanged(ctx, workspace);
    return hadConversation ? null : manager.getActive(ctx.clientId);
  });

  bind('session.set_reasoning_effort', (ctx, params: { effort: string | number | null }) => {
    const manager = getSessionManager();
    const active = manager.getActive(ctx.clientId);
    if (!active) {
      setDraftReasoningOverride(ctx.clientId, params.effort);
      return { status: 'ok' };
    }
    manager.setReasoningEffortOverride(active.id, params.effort);
    return { status: 'ok' };
  });

  bind('session.set_service_tier', (ctx, params: { tier: string | null }) => {
    const manager = getSessionManager();
    const active = manager.getActive(ctx.clientId);
    if (!active) {
      setDraftTierOverride(ctx.clientId, params.tier);
      return { status: 'ok' };
    }
    manager.setTierOverride(active.id, params.tier);
    return { status: 'ok' };
  });

  // ── working set ────────────────────────────────────────────────────────────
  bind('session.working_set_get', (ctx) => {
    const { snapshot, membershipChanged } = filterIfCatalogOk(ctx.clientId);
    if (membershipChanged) {
      try {
        sessionWorkingSet.saveToDisk();
      } catch (err) {
        console.error('[working-set] failed to persist ui-state.json', err);
      }
      for (const clientId of server().listConnections()) {
        const perClient = clientId === ctx.clientId
          ? snapshot
          : sessionWorkingSet.getSnapshot(clientId);
        server().emitToPublic(clientId, IPC_CHANNELS.SESSION_WORKING_SET_CHANGED, {
          snapshot: perClient,
        });
      }
    }
    return snapshot;
  });

  bind('session.working_set_open_or_focus', (ctx, params: { id: string }) => {
    const catalog = tryListSessionCatalog();
    if (catalog.status === 'ok' && !catalog.ids.has(params.id)) {
      return sessionWorkingSet.getSnapshot(ctx.clientId);
    }
    return workingSetOpenOrFocus(params.id, ctx.clientId);
  });

  bind('session.working_set_close', (ctx, params: { id: string }) =>
    mutateAndPersist(ctx.clientId, () => sessionWorkingSet.close(params.id, ctx.clientId)));

  bind('session.working_set_remove', (ctx, params: { id: string }) =>
    workingSetRemove(params.id, ctx.clientId));

  bind('session.working_set_set_focus', (ctx, params: { id: string | null }) =>
    mutateAndPersist(ctx.clientId, () => sessionWorkingSet.setFocus(params.id, ctx.clientId)));

  // ── session activity ───────────────────────────────────────────────────────
  bind('session.activity_list', () => {
    const sessionIds = new Set(listSessionActivity().map((activity) => activity.sessionId));
    try {
      for (const record of getSubagentManager().allRecords()) {
        if (record.sessionId) sessionIds.add(record.sessionId);
      }
      for (const process of getBackgroundStore().list()) {
        if (process.sessionId && process.exitCode === null) sessionIds.add(process.sessionId);
      }
    } catch {
      // Activity remains usable before optional runtime services initialize.
    }
    for (const sessionId of sessionIds) {
      reconcileSessionActivity(sessionId);
    }
    return listSessionActivity();
  });

  bind('session.activity_mark_seen', (_ctx, params: { id: string }) =>
    markSessionActivitySeen(params.id));

  // ── bgcmd ──────────────────────────────────────────────────────────────────
  bind('bgcmd.snapshot', (ctx, params: BgSnapshotParams) => bgCommandSnapshot(params, ctx.clientId));
  bind('bgcmd.list', (ctx, params: { sessionId?: string }) => bgCommandList(params, ctx.clientId));
  bind('bgcmd.send_input', (ctx, params: { commandId: number; text: string; sessionId?: string }) =>
    bgCommandSendInput(params, ctx.clientId));
  bind('bgcmd.terminate', (ctx, params: { commandId: number; sessionId?: string }) =>
    bgCommandTerminate(params, ctx.clientId));
  bind('bgcmd.release_input', (ctx, params: { commandId: number; sessionId?: string }) =>
    bgCommandReleaseInput(params, ctx.clientId));

  // ── ask_question ───────────────────────────────────────────────────────────
  bind('ask_question.snapshot', (ctx) => {
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    return {
      questions: sessionId == null
        ? []
        : questionStore.listForOwner(sessionId, ctx.clientId),
    };
  });

  bind('ask_question.answer', (ctx, params: {
    toolCallId: string;
    answers: Array<{ selected: string[]; text: string | null; skipped: boolean }>;
  }) => {
    const entry = questionStore.get(params.toolCallId);
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    const owns = entry != null
      && entry.ownerWindowId === ctx.clientId
      && entry.sessionId === sessionId;
    if (!owns) return { ok: false };
    return { ok: questionStore.answer(params.toolCallId, params.answers) };
  });

  bind('ask_question.cancel', (ctx, params: { toolCallId: string }) => {
    const entry = questionStore.get(params.toolCallId);
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    const owns = entry != null
      && entry.ownerWindowId === ctx.clientId
      && entry.sessionId === sessionId;
    if (!owns) return { ok: false };
    const ok = questionStore.cancel(params.toolCallId);
    if (ok && entry) {
      setImmediate(() => forceAbortMainTurn(entry.sessionId, { emitTerminalEvents: true }));
    }
    return { ok };
  });

  // ── permissions ────────────────────────────────────────────────────────────
  bind('permission.snapshot', (ctx) => {
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    return {
      approvals: sessionId == null
        ? []
        : approvalStore.listForOwner(sessionId, ctx.clientId),
    };
  });

  // ── reconnect resync (U10, R6) ─────────────────────────────────────────────
  // Owner-scoped snapshots answer [] for a reconnected remote client (fresh
  // connection id), so resync goes through this machine-wide accessor instead
  // and re-binds orphaned pendings to the requester so it can answer them.
  bind('host.pending_state', (ctx, params: { sessionId?: string }) => {
    server().adoptOrphanedPendingFor(ctx.clientId);
    return {
      approvals: server().listPendingApprovals(params?.sessionId).map(pendingApprovalEvent),
      questions: server().listPendingQuestions(params?.sessionId).map(pendingQuestionEvent),
    };
  });

  bind('permission.approval_answer', (ctx, params: {
    toolCallId: string; decision: 'approved' | 'denied'; reason?: string;
  }) => {
    const entry = approvalStore.get(params.toolCallId);
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    const owns = entry != null
      && entry.ownerWindowId === ctx.clientId
      && entry.sessionId === sessionId;
    if (!owns) return { ok: false };
    return { ok: approvalStore.answer(params.toolCallId, params.decision, params.reason) };
  });

  bind('permission.set_session_mode', (ctx, params: {
    mode: PermissionMode | null; expectedSessionId: string | null;
  }) => {
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    if (sessionId == null) {
      // Draft mode (no session file yet): stash in the per-client draft store.
      if (params.expectedSessionId !== null) {
        return { ok: false, sessionId: null };
      }
      setDraftPermissionOverride(ctx.clientId, params.mode);
      return { ok: true, sessionId: null };
    }
    if (sessionId !== params.expectedSessionId) {
      return { ok: false, sessionId };
    }
    getSessionManager().setPermissionMode(sessionId, params.mode);
    return { ok: true, sessionId };
  });

  bind('permission.get_session_mode', (ctx, params: { expectedSessionId: string | null }) => {
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    if (sessionId == null) {
      if (params.expectedSessionId !== null) {
        return { ok: false, sessionId: null, mode: null };
      }
      return {
        ok: true,
        sessionId: null,
        mode: getDraftPermissionOverride(ctx.clientId) ?? null,
      };
    }
    if (sessionId !== params.expectedSessionId) {
      return { ok: false, sessionId, mode: null };
    }
    const session = getSessionManager().getSession(sessionId);
    return {
      ok: true,
      sessionId,
      mode: session?.permissionMode ?? null,
    };
  });

  // ── project trust ──────────────────────────────────────────────────────────
  const trustInfoFor = (dir: string) => {
    const canonical = canonicalizeProjectDirectory(dir);
    if (canonical == null) {
      return { projectDir: dir, state: 'untrusted', report: null };
    }
    const state = getProjectTrustState(canonical);
    let report: ReturnType<typeof buildProjectTrustReport> | null;
    try {
      report = buildProjectTrustReport(canonical);
    } catch (error) {
      console.warn(`Failed to build trust report for '${canonical}':`, error);
      report = null;
    }
    return { projectDir: canonical, state, report };
  };

  bind('project.trust_get', (_ctx, params: { cwd: string }) => trustInfoFor(params.cwd));

  bind('project.trust_set', async (_ctx, params: { cwd: string; trusted: boolean }) => {
    const { cwd, trusted } = params;
    let canonical: string;
    if (trusted) {
      const resolved = canonicalizeProjectDirectory(cwd);
      if (resolved == null) {
        throw new Error('Cannot trust an invalid project directory.');
      }
      canonical = resolved;
      grantProjectTrust(canonical);
      getProjectRuntimeRegistry().invalidate(canonical);
      invalidateProjectMCPManagers(canonical);
      ensureWorkspaceWatcherStarted(canonical);
    } else {
      await revokeProjectTrustForDir(cwd);
      canonical = canonicalizeProjectDirectory(cwd) ?? cwd;
    }
    const info = trustInfoFor(canonical);
    server().emitToAllPublic(IPC_CHANNELS.PROJECT_TRUST_CHANGED, {
      projectDir: info.projectDir,
      state: info.state,
    });
    for (const clientId of server().listConnections()) {
      const workspace = resolveWindowWorkspace(clientId);
      if (workspace.cwd !== canonical) continue;
      server().emitToPublic(clientId, IPC_CHANNELS.SESSION_WORKSPACE_CHANGED, { workspace });
    }
    return info;
  });

  bind('project.trust_list', () => listTrustedProjects());

  // ── definitions ────────────────────────────────────────────────────────────
  bind('definitions.list', (ctx) => listDefinitions(resolveBoundProjectPath(ctx.clientId)));

  const withDefinitionMutation = <T>(ctx: HostRequestContext, mutate: (projectDir: string | null) => T): T => {
    const projectDir = resolveBoundProjectPath(ctx.clientId);
    const result = mutate(projectDir);
    reloadDefinitionRegistries(projectDir);
    return result;
  };

  bind('skill.save', (ctx, params: Parameters<typeof saveSkill>[0]) =>
    withDefinitionMutation(ctx, (projectDir) => saveSkill(params, projectDir)));
  bind('skill.delete', (ctx, params: { scope: 'global' | 'project'; name: string }) =>
    withDefinitionMutation(ctx, (projectDir) => {
      deleteSkill(params.scope, params.name, projectDir);
      return { status: 'deleted' as const };
    }));
  bind('agent.save', (ctx, params: Parameters<typeof saveAgent>[0]) =>
    withDefinitionMutation(ctx, (projectDir) => saveAgent(params, projectDir)));
  bind('agent.delete', (ctx, params: { scope: 'global' | 'project'; name: string }) =>
    withDefinitionMutation(ctx, (projectDir) => {
      deleteAgent(params.scope, params.name, projectDir);
      return { status: 'deleted' as const };
    }));
  bind('personality.save', (ctx, params: Parameters<typeof savePersonality>[0]) =>
    withDefinitionMutation(ctx, (projectDir) => savePersonality(params, projectDir)));
  bind('personality.delete', (ctx, params: { scope: 'global' | 'project'; name: string }) =>
    withDefinitionMutation(ctx, (projectDir) => {
      deletePersonality(params.scope, params.name, projectDir);
      return { status: 'deleted' as const };
    }));
  bind('shared_prompt.save', (ctx, params: Parameters<typeof saveSharedPrompt>[0]) =>
    withDefinitionMutation(ctx, (projectDir) => saveSharedPrompt(params, projectDir)));
  bind('shared_prompt.delete', (ctx, params: { scope: 'global' | 'project'; slot: 'all-agents' | 'subagents' }) =>
    withDefinitionMutation(ctx, (projectDir) => {
      deleteSharedPrompt(params.scope, params.slot, projectDir);
      return { status: 'deleted' as const };
    }));

  bind('definition.reveal', (_ctx) => {
    requireCapability(HOST_CAPABILITIES.DEFINITIONS_REVEAL, 'definition.reveal');
    // Capability declared only by the Electron host (shell.showItemInFolder);
    // the headless daemon never declares it.
    throw new Error('definition.reveal requires a host-native shell transport.');
  });

  // ── mcp / rag / ast / tools ────────────────────────────────────────────────
  bind('mcp.status', (ctx) => {
    const cwd = resolveBoundProjectPath(ctx.clientId);
    if (cwd == null) return [];
    const runtime = getProjectRuntimeRegistry().get(cwd);
    return getProjectMCPManager(runtime).getStatus();
  });

  bind('rag.status', (ctx) => {
    const projectPath = resolveBoundProjectPath(ctx.clientId);
    if (projectPath == null || getProjectTrustState(projectPath) !== 'trusted') {
      return {
        totalChunks: 0,
        totalFiles: 0,
        lastIndexed: null,
        lastIndexDuration: null,
        lastAutoRefresh: null,
      };
    }
    const status = getRagStatus(projectPath);
    try {
      return {
        ...status,
        watcher: { watching: getWorkspaceWatcherState(projectPath).watching },
      };
    } catch {
      return status;
    }
  });

  bind('rag.index', async (ctx, params: { force?: boolean }) => {
    const projectPath = resolveBoundProjectPath(ctx.clientId);
    const emptyResult = (errors: string[]) => ({
      filesScanned: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      filesDeleted: 0,
      chunksCreated: 0,
      errors,
      durationSeconds: 0,
    });
    if (!projectPath) return emptyResult(['No project folder selected']);
    if (getProjectTrustState(projectPath) !== 'trusted') {
      return emptyResult(['Project folder is not trusted']);
    }
    if (isRagIndexing(projectPath)) {
      return emptyResult(['Indexing already in progress']);
    }
    return indexProject(
      projectPath,
      undefined,
      params.force,
      undefined,
      (progress) => server().emitToProjectPublic(projectPath, IPC_CHANNELS.RAG_PROGRESS, progress),
      {
        config: getProjectRuntimeRegistry().get(projectPath).config,
      },
    );
  });

  bind('rag.clear', async (ctx) => {
    const projectPath = resolveBoundProjectPath(ctx.clientId);
    // Untrusted projects keep their index untouched (no-op clear).
    if (projectPath != null && getProjectTrustState(projectPath) === 'trusted') {
      await cancelIndex(projectPath);
      await cancelProjectRefreshAsync(projectPath);
      clearIndex(projectPath);
    }
    return { status: 'cleared' };
  });

  bind('ast.status', (ctx) => {
    const projectPath = resolveBoundProjectPath(ctx.clientId);
    if (projectPath == null || getProjectTrustState(projectPath) !== 'trusted') {
      return {
        totalFiles: 0,
        totalSymbols: 0,
        lastIndexed: null,
        lastIndexDuration: null,
        lastAutoRefresh: null,
      };
    }
    return withDisposable(
      new ASTStore(projectPath),
      (store) => store.status(),
    );
  });

  bind('ast.index', async (ctx, params: { force?: boolean }) => {
    const projectPath = resolveBoundProjectPath(ctx.clientId);
    const emptyResult = (errors: string[]) => ({
      filesScanned: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      filesDeleted: 0,
      symbolsExtracted: 0,
      errors,
      durationSeconds: 0,
    });
    if (!projectPath) return emptyResult(['No project folder selected']);
    if (getProjectTrustState(projectPath) !== 'trusted') {
      return emptyResult(['Project folder is not trusted']);
    }
    if (isAstIndexing(projectPath)) {
      return emptyResult(['Indexing already in progress']);
    }
    let runtimeConfig;
    try {
      runtimeConfig = getProjectRuntimeRegistry().get(projectPath).config;
    } catch {
      runtimeConfig = undefined;
    }
    return indexAstProject({
      force: params.force,
      projectPath,
      config: runtimeConfig,
      progressCallback: (progress) =>
        server().emitToProjectPublic(projectPath, IPC_CHANNELS.AST_PROGRESS, progress),
    });
  });

  bind('tool.execute', async (ctx, params: { name: string; args?: unknown }) => {
    const { name, args } = params;
    const toolCallId = crypto.randomUUID();
    if (!RENDERER_ALLOWED_TOOLS.has(name)) {
      return genericTerminalExecution(
        toolCallId,
        name,
        'error',
        `Tool '${name}' is not allowed on this host surface. Use the agent layer for non-read-only tools.`,
        'host_tool_not_allowed',
      );
    }
    const tool = toolRegistry.get(name);
    if (!tool) {
      return genericTerminalExecution(
        toolCallId,
        name,
        'error',
        `Tool '${name}' not found in registry`,
        'unknown_tool',
      );
    }
    let cwd: string | null;
    try {
      cwd = resolveBoundProjectPath(ctx.clientId);
    } catch {
      cwd = null;
    }
    if (cwd == null) {
      return genericTerminalExecution(
        toolCallId,
        name,
        'error',
        'No project folder selected. Choose a folder before running tools.',
        'missing_workspace',
      );
    }
    if (getProjectTrustState(cwd) !== 'trusted') {
      return genericTerminalExecution(
        toolCallId,
        name,
        'error',
        'This project folder is not trusted. Trust it before running tools.',
        'untrusted_project',
      );
    }
    const active = getSessionManager().getActive(ctx.clientId);
    return executeToolCall(
      {
        id: toolCallId,
        name,
        args: args ?? {},
      },
      toolRegistry,
      {
        cwd,
        sessionId: active?.id,
        agentScopeId: 'main',
        projectRuntime: getProjectRuntimeRegistry().get(cwd),
        windowId: ctx.clientId,
        agentsMdDisabled: true,
      },
    );
  });

  // ── config ─────────────────────────────────────────────────────────────────
  bind('config.get', () => getConfig());
  bind('config.save', (_ctx, params: { updates: Record<string, unknown> }) =>
    saveHomeConfigUpdates(params.updates));
  bind('config.get_home', () => loadHomeConfig());
  // U5 additive fix: the params schema is the IPC boundary's bare directory
  // string (configReadProjectSchema), not an object wrapper.
  bind('config.read_project', (ctx, params: string) => {
    const verifiedProjectDir = resolveAuthorizedProjectDir(ctx.clientId, params);
    return readProjectConfig(verifiedProjectDir);
  });
  bind('config.save_project', (ctx, params: { projectDir: string; updates: Record<string, unknown> }) => {
    const verifiedProjectDir = resolveAuthorizedProjectDir(ctx.clientId, params.projectDir);
    return saveProjectConfigUpdates(verifiedProjectDir, params.updates).then(() => null);
  });

  // ── providers (reads + read-side mutations; vault writes are not in HOST_METHODS) ──
  bind('providers.list', () => providerOverview());
  bind('providers.validate', (_ctx, params: { connectionId: string }) =>
    withConnectionMutationLock(params.connectionId, () => validateConnection(params.connectionId)));
  bind('providers.disable', (_ctx, params: { connectionId: string }) =>
    withConnectionMutationLock(params.connectionId, () => disableConnection(params.connectionId)));
  bind('providers.enable', (_ctx, params: { connectionId: string }) =>
    withConnectionMutationLock(params.connectionId, () => enableConnection(params.connectionId)));
  bind('providers.disconnect', (_ctx, params: { connectionId: string }) =>
    withConnectionMutationLock(params.connectionId, () => disconnectConnection(params.connectionId)));
  bind('providers.delete', (_ctx, params: { connectionId: string }) =>
    withConnectionMutationLock(params.connectionId, () => deleteConnection(params.connectionId)));
  bind('providers.model_list', (_ctx, params: { connectionId?: string; includeDisabled?: boolean }) =>
    listModelOptions(params?.connectionId, params?.includeDisabled));
  bind('providers.discover_models', (_ctx, params: { connectionId: string }) =>
    discoverModels(params.connectionId));
  bind('providers.status_refresh', async (_ctx, params: { providerId: string; connectionId?: string }) => {
    const observation = await refreshStatus(params.providerId, params.connectionId);
    return observation ? statusView(observation) : null;
  });
  bind('providers.quota_refresh', async (_ctx, params: { connectionId: string }) => {
    const observation = await refreshQuota(params.connectionId);
    return observation ? statusView(observation) : null;
  });

  // Completeness guard: every registry method must be bound (or intentionally
  // absent from both). Fail fast at server construction instead of at runtime.
  const bound = new Set(entries.map(([method]) => method));
  for (const method of Object.keys(HOST_METHODS)) {
    if (!bound.has(method)) {
      throw new Error(`HostServer is missing a binding for '${method}'`);
    }
  }

  return new Map(entries);
}
