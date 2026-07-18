/**
 * Chat IPC handlers — chat:send, chat:cancel.
 *
 * Uses the orchestrator from U9 and XState agent machine from U10.
 * Streams responses back to the renderer via webContents.send.
 *
 * The chat handler manages an active agent actor per session and
 * forwards StreamEvents as IPC events to the renderer.
 */
import { ipcMain, webContents as electronWebContents, type WebContents } from 'electron';
import { createActor, type ActorRefFrom } from 'xstate';
import { z } from 'zod';
import { agentMachine, type AgentContext } from '../agents/xstate/agent-machine';
import { interruptMachine } from '../agents/xstate/interrupt-machine';
import { streamChat, type StreamEvent } from '../llm/orchestrator';
import { createMiddlewareStack } from '../llm/middleware';
import { AgentType, type Agent } from '../../shared/types/agent';
import type { ModelSelection } from '../../shared/types/provider';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { MessageRole, MessageType } from '../../shared/types/message';
import type { Message, Usage } from '../../shared/types/message';
import { ChainStatus } from '../../shared/types/chain';
import type { GenerateTitleCallback } from '../session/manager';
import {
  flattenSessionMessages,
  getSessionManager,
  resolveWindowWorkspace,
} from './session';
import { workingSetOpenOrFocus } from './session-working-set';
import { getBackgroundStore } from '../tools/process/background-store';
import { getBuiltinToolRegistryForRuntime, getSubagentManager } from '../tools';
import type {
  ChatErrorKind,
  ChatSendResult,
  ChatSnapshot,
  ChatSessionSnapshot,
  ChatSnapshotState,
  ChatStreamSegmentSnapshot,
  ChatToolCallSnapshot,
} from '../../shared/types/ipc';
import {
  clearAllChatHistory,
  getChatHistory,
  setChatHistory,
} from './chat-history';
import {
  makeAssistantMessage,
  makeThinkingMessage,
  makeToolCallMessage,
  makeToolResultMessage,
  makeUserMessage,
} from '../llm/message-factories';
import { clearDraftCwd } from '../project/workspace';
import type { ToolExecutionContext } from '../tools/types';
import {
  getProjectRuntimeRegistry,
  hydrateProjectRuntime,
  type ProjectRuntime,
} from '../project/runtime';
import {
  completeSessionActivity,
  publishSessionActivity,
} from './session-activity';
import { appendProjectPersonality } from '../project/personality';
import { buildSystemPromptContext } from '../llm/build-prompt-context';
import {
  acquireProjectMCPManager,
  releaseProjectMCPManager,
} from '../mcp/project-registry';
import { getProviderRuntime } from '../providers';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { getProviderAccountingStore } from '../providers/accounting/store';
import type { ProviderAttemptAccountingContext } from '../providers/accounting/middleware';
import { importESM } from '../utils/esm-import';
import { getTierModelSelection } from '../config/loader';
import {
  chatCancelSchema,
  chatSendSchema,
  chatSnapshotSchema,
  chatStopSchema,
} from './payload-schemas';

/** Upper bound for bgcmd:snapshot lastN (prevents unbounded payload reads). */
const BG_CMD_SNAPSHOT_MAX_LAST_N = 1000;

const bgCommandSnapshotSchema = z.object({
  commandId: z.number().int().positive(),
  lastN: z.number().int().positive().max(BG_CMD_SNAPSHOT_MAX_LAST_N).optional(),
  /** Owning session; when omitted, resolved from the calling window's active session. */
  sessionId: z.string().uuid().optional(),
});

// ── Active actor tracking ────────────────────────────────────────────────────

type ActiveAgent = {
  /** Stable execution owner; all persistence and events are addressed by it. */
  sessionId: string;
  /** Window that initiated the turn (used only as an event destination). */
  windowId: string;
  /** Chain/turn identity used to order snapshot and stream events. */
  turnId: string;
  /** Project working directory frozen when this turn began. */
  cwd: string;
  /** Epoch timestamp for live elapsed-time displays. */
  startedAt: number;
  actor: ActorRefFrom<typeof agentMachine>;
  interruptActor: ActorRefFrom<typeof interruptMachine>;
  abortController: AbortController;
  /**
   * Full conversation history for the LLM at the start of this turn
   * (prior turns flattened + current user message).
   */
  messages: Message[];
  /**
   * Count of messages from prior turns only (before this turn's user message).
   * Turn-local chain messages = messages.slice(priorMessageCount) + turnMessages.
   */
  priorMessageCount: number;
  /** Messages produced during this turn (tool calls/results + assistant). */
  turnMessages: Message[];
  /** Length of context.response already snapshotted into turnMessages as text. */
  responseCommittedLength: number;
  /** Length of context.thinking already snapshotted into turnMessages. */
  thinkingCommittedLength: number;
  agent: Agent;
  /** Connection-scoped selection frozen for this turn's chain/storage. */
  selection: ModelSelection;
  agentCancelled: boolean;
  finalized: boolean;
  /** Monotonic generation for this window; stale agents must not emit IPC. */
  generation: number;
  /** Per-turn sequence used to order live events against snapshots. */
  eventSequence: number;
  /** Current tool cards, kept outside the renderer so a session can rehydrate. */
  toolCalls: Map<string, ChatToolCallSnapshot>;
  /** Chronological live timeline (text, thinking, and tools) for rehydration. */
  streamSegments: ChatStreamSegmentSnapshot[];
  unsubscribe: () => void;
  interruptUnsubscribe: () => void;
  interruptResetTimer: ReturnType<typeof setTimeout> | null;
  /** Releases turn-scoped resources exactly once when the actor is disposed. */
  releaseResources: () => void;
};

const activeAgents = new Map<string, ActiveAgent>();
const sessionsStarting = new Set<string>();
/**
 * Single-flight draft session create per window. Concurrent first sends from
 * draft mode share one in-flight ensure promise so only one session is created.
 */
const draftEnsureByWindow = new Map<
  string,
  Promise<{
    ok: true;
    cwd: string;
    session: import('../../shared/types/session').Session;
    runtime: ProjectRuntime;
  } | { ok: false; result: ChatSendResult }>
>();

/**
 * Per-session generation counter. Incremented on every new chat:send and on
 * forceAbort so stale actor/interrupt subscriptions can drop events even if
 * they fire after the agent was replaced or torn down.
 */
const agentGenerations = new Map<string, number>();

function nextAgentGeneration(sessionId: string): number {
  const gen = (agentGenerations.get(sessionId) ?? 0) + 1;
  agentGenerations.set(sessionId, gen);
  return gen;
}

function disposeActiveAgent(sessionId: string, active: ActiveAgent): void {
  // Only clear the map slot if we still own it (a newer agent may have replaced us).
  if (activeAgents.get(sessionId) === active) {
    activeAgents.delete(sessionId);
  }
  active.unsubscribe();
  active.interruptUnsubscribe();
  if (active.interruptResetTimer) {
    clearTimeout(active.interruptResetTimer);
    active.interruptResetTimer = null;
  }
  active.abortController.abort();
  active.actor.stop();
  active.interruptActor.stop();
  active.releaseResources();
}

/**
 * Whether this agent may still stream IPC to the renderer.
 * Drops events from cancelled, finalized, replaced, or generation-stale agents.
 */
function canEmitStreamEvents(sessionId: string, active: ActiveAgent): boolean {
  return (
    !active.agentCancelled &&
    !active.finalized &&
    activeAgents.get(sessionId) === active &&
    agentGenerations.get(sessionId) === active.generation
  );
}

/** True when this agent still occupies the window's active slot (may be cancelled). */
function isCurrentAgent(sessionId: string, active: ActiveAgent): boolean {
  return (
    activeAgents.get(sessionId) === active &&
    agentGenerations.get(sessionId) === active.generation
  );
}

function nextEventIdentity(active: ActiveAgent) {
  active.eventSequence += 1;
  return {
    sessionId: active.sessionId,
    turnId: active.turnId,
    sequence: active.eventSequence,
  };
}

function sendTurnEvent(
  webContents: WebContents,
  active: ActiveAgent,
  channel: string,
  payload: Record<string, unknown>,
): void {
  const identity = nextEventIdentity(active);
  const recipients = new Map<number, WebContents>();
  recipients.set(webContents.id, webContents);
  const allWebContents = electronWebContents.getAllWebContents?.() ?? [];
  for (const candidate of allWebContents) {
    if (getSessionManager().getActive(String(candidate.id))?.id === active.sessionId) {
      recipients.set(candidate.id, candidate);
    }
  }
  for (const recipient of recipients.values()) {
    if (canSend(recipient)) {
      recipient.send(channel, { ...identity, ...payload });
    }
  }
}

function appendTextSegment(
  active: ActiveAgent,
  kind: 'text' | 'thinking',
  content: string,
): void {
  const last = active.streamSegments.at(-1);
  if (last?.kind === kind) {
    active.streamSegments[active.streamSegments.length - 1] = {
      ...last,
      content: last.content + content,
    };
    return;
  }
  active.streamSegments.push({ kind, id: crypto.randomUUID(), content });
}

function ensureToolSnapshot(
  active: ActiveAgent,
  toolCallId: string,
  toolName: string,
): ChatToolCallSnapshot {
  const existing = active.toolCalls.get(toolCallId);
  if (existing) return existing;
  const next: ChatToolCallSnapshot = {
    toolCallId,
    toolName,
    status: 'generating',
    partialArgs: '',
    args: '',
    content: null,
    toolResult: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  active.toolCalls.set(toolCallId, next);
  active.streamSegments.push({ kind: 'tool', toolCallId });
  return next;
}

function updateToolSnapshot(
  active: ActiveAgent,
  toolCallId: string,
  toolName: string,
  patch: Partial<ChatToolCallSnapshot>,
): ChatToolCallSnapshot {
  const existing = ensureToolSnapshot(active, toolCallId, toolName);
  const next = { ...existing, ...patch, toolCallId };
  active.toolCalls.set(toolCallId, next);
  return next;
}

function snapshotState(active: ActiveAgent): ChatSnapshotState {
  const state = String(active.actor.getSnapshot().value);
  if (state === 'error') return 'error';
  if (state === 'idle') return 'idle';
  return 'streaming';
}

function snapshotForAgent(active: ActiveAgent): ChatSnapshot {
  const context = active.actor.getSnapshot().context as AgentContext;
  const interruptState = active.interruptActor.getSnapshot().value as
    | 'idle'
    | 'confirmAgent'
    | 'confirmSubagents';
  return {
    sessionId: active.sessionId,
    turnId: active.turnId,
    sequence: active.eventSequence,
    state: snapshotState(active),
    response: context.response ?? '',
    thinking: context.thinking ?? '',
    toolCalls: [...active.toolCalls.values()].map((tool) => ({ ...tool })),
    streamSegments: active.streamSegments.map((segment) => ({ ...segment })),
    usage: (context.usage as Usage | null) ?? null,
    error: context.error ?? null,
    interruptState,
    cwd: active.cwd,
    startedAt: active.startedAt,
    interrupted: active.agentCancelled,
  };
}

/**
 * Flush partial stream content into turnMessages (thinking + uncommitted
 * assistant text). Shared by forceAbort, replace-on-send, and error paths.
 */
function flushPartialTurnContent(agent: ActiveAgent, context: AgentContext | undefined): void {
  const partialResponse = context?.response ?? '';
  const thinking = context?.thinking ?? '';
  const usage = (context?.usage as Usage | null) ?? null;

  if (thinking && thinking.length > agent.thinkingCommittedLength) {
    const seg = thinking.slice(agent.thinkingCommittedLength);
    if (seg.trim()) {
      agent.turnMessages.push(makeThinkingMessage(seg));
    }
    agent.thinkingCommittedLength = thinking.length;
  }

  const remaining = partialResponse.slice(agent.responseCommittedLength);
  if (remaining) {
    agent.turnMessages.push(makeAssistantMessage(remaining, usage));
    agent.responseCommittedLength = partialResponse.length;
  } else if (usage && agent.turnMessages.length > 0) {
    const last = agent.turnMessages[agent.turnMessages.length - 1];
    if (
      last &&
      last.role === MessageRole.ASSISTANT &&
      last.type === MessageType.TEXT
    ) {
      agent.turnMessages[agent.turnMessages.length - 1] = {
        ...last,
        usage,
      };
    }
  }
}

/** Resolve WebContents for a window id (forceAbort / SESSION_UPDATED). */
function webContentsForWindowId(windowId: string): WebContents | null {
  try {
    const id = Number(windowId);
    if (!Number.isFinite(id)) return null;
    const wc = electronWebContents.fromId(id);
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      return null;
    }
    return wc;
  } catch {
    return null;
  }
}

/**
 * Silently abort any in-flight chat for a window (e.g. on session switch).
 * Does not emit CHAT_DONE — the renderer is about to replace its message list.
 *
 * Dispose is synchronous: a deferred microtask left a window where the old
 * subscription could still emit CHAT_CHUNK after session:load swapped UI state
 * (or after a new chat:send started). Flags + generation bump drop any late
 * callbacks that race with stop/unsubscribe.
 *
 * Before discarding, we attempt to persist any partial turn (user message +
 * tool calls + assistant text produced so far) as INTERRUPTED so the user does
 * not lose context when switching sessions mid-stream (P2-9).
 *
 * If the agent already finalized (persist completed), only dispose — never
 * mint a duplicate INTERRUPTED chain.
 */
export function forceAbortChat(windowId: string): void {
  const sessionId = getSessionManager().getActive(windowId)?.id;
  if (sessionId) forceAbortSession(sessionId);
}

/** Abort exactly one session without affecting work in any other session. */
export function forceAbortSession(sessionId: string): void {
  getBackgroundStore().terminateSession(sessionId);
  try {
    getSubagentManager().cancelRunning(sessionId);
  } catch (err) {
    console.debug(
      'forceAbortSession subagent cancel failed (non-fatal):',
      err,
    );
  }

  const existing = activeAgents.get(sessionId);
  if (!existing) return;

  // Already finalized (done/error/cancel) — only dispose; do not re-persist.
  if (existing.finalized) {
    existing.agentCancelled = true;
    nextAgentGeneration(sessionId);
    disposeActiveAgent(sessionId, existing);
    return;
  }

  try {
    const snapshot = existing.actor.getSnapshot();
    const context = snapshot?.context as AgentContext | undefined;
    flushPartialTurnContent(existing, context);

    if (existing.messages.length > 0 || existing.turnMessages.length > 0) {
      const fullHistory = [...existing.messages, ...existing.turnMessages];
      if (fullHistory.length > 0) {
        try {
          const wc = webContentsForWindowId(existing.windowId);
          persistTurnConversation(
            sessionId,
            fullHistory,
            turnMessagesFromAgent(existing),
            ChainStatus.INTERRUPTED,
            existing.agent,
            existing.selection,
            wc ?? undefined,
          );
        } catch (err) {
          console.debug(
            'Failed to persist partial chat on forceAbort (non-fatal):',
            err,
          );
        }
      }
    }
  } catch (err) {
    console.debug(
      'forceAbortSession persistence attempt failed (non-fatal):',
      err,
    );
  }

  existing.agentCancelled = true;
  existing.finalized = true;
  completeSessionActivity(
    sessionId,
    getSessionManager().getActive(existing.windowId)?.id !== sessionId,
  );
  nextAgentGeneration(sessionId);
  disposeActiveAgent(sessionId, existing);
}

/**
 * Immediately stop one session for the global Activity surface.
 *
 * Unlike Esc cancellation, this does not require confirmation clicks. It keeps
 * all writes and terminal events on the stopped session's originating window.
 */
export function forceStopSession(sessionId: string): boolean {
  getBackgroundStore().terminateSession(sessionId);
  const existing = activeAgents.get(sessionId);
  const cancelledSubagents = getSubagentManager().cancelRunning(sessionId);
  if (!existing) {
    if (cancelledSubagents.length > 0) {
      completeSessionActivity(sessionId, true);
    }
    return cancelledSubagents.length > 0;
  }

  // Already finalized (done/error/cancel) — only dispose residual work.
  if (existing.finalized) {
    existing.agentCancelled = true;
    nextAgentGeneration(sessionId);
    disposeActiveAgent(sessionId, existing);
    return true;
  }

  const ownerWebContents =
    webContentsForWindowId(existing.windowId) ?? null;
  existing.agentCancelled = true;
  existing.finalized = true;
  const context = existing.actor.getSnapshot().context as AgentContext;
  existing.actor.send({ type: 'CANCEL' });
  flushPartialTurnContent(existing, context);
  const fullHistory = [...existing.messages, ...existing.turnMessages];
  if (fullHistory.length > 0) {
    persistTurnConversation(
      sessionId,
      fullHistory,
      turnMessagesFromAgent(existing),
      ChainStatus.INTERRUPTED,
      existing.agent,
      existing.selection,
      ownerWebContents ?? undefined,
    );
  }
  completeSessionActivity(
    sessionId,
    getSessionManager().getActive(existing.windowId)?.id !== sessionId,
  );

  if (ownerWebContents) {
    sendTurnEvent(ownerWebContents, existing, IPC_CHANNELS.CHAT_DONE, {
      type: 'done',
      response: context.response ?? '',
      interrupted: true,
      usage: context.usage ?? null,
    });
    sendTurnEvent(ownerWebContents, existing, IPC_CHANNELS.CHAT_STATE, {
      state: 'idle',
      response: context.response ?? '',
      error: null,
      interruptState: 'idle',
      cwd: existing.cwd,
    });
  }

  nextAgentGeneration(sessionId);
  disposeActiveAgent(sessionId, existing);
  return true;
}

/** Active session IDs whose frozen turn uses the given provider connection. */
export function activeSessionsForProviderConnection(connectionId: string): readonly string[] {
  return [...activeAgents.values()]
    .filter((active) => !active.finalized && active.selection.connectionId === connectionId)
    .map((active) => active.sessionId);
}

/**
 * Destructive disconnect helper. Stops only turns already attributed to this
 * connection; other connections and frozen completed turns remain untouched.
 */
export function stopActiveProviderConnectionTurns(connectionId: string): readonly string[] {
  const sessionIds = activeSessionsForProviderConnection(connectionId);
  for (const sessionId of sessionIds) forceStopSession(sessionId);
  return sessionIds;
}

function canSend(webContents: WebContents): boolean {
  return typeof webContents.isDestroyed !== 'function' || !webContents.isDestroyed();
}

type EnsureActiveSessionResult =
  | {
      ok: true;
      cwd: string;
      session: import('../../shared/types/session').Session;
      runtime: ProjectRuntime;
    }
  | { ok: false; result: ChatSendResult };

/**
 * Ensure there is a session ready before streaming/persisting.
 * Draft mode leaves no active session until the first chat:send — create
 * lazily here and notify the renderer so the sidebar gains a list entry.
 *
 * When `requestedSessionId` is set, resolves that session by id without
 * changing the window's active selection (mid-flight / background sends).
 *
 * Requires a valid workspace (draft → session → sticky default). Never uses
 * process.cwd() as the product default. If unbound, does not create a session.
 *
 * @returns ok + session cwd, or a structured failure for the send gate
 */
export function ensureActiveSession(
  webContents: WebContents,
  preferredModel?: ModelSelection | null,
  requestedSessionId?: string,
  draftGeneration?: number,
): EnsureActiveSessionResult {
  const windowId = String(webContents.id);
  const manager = getSessionManager();
  // Resolve by id without switchTo — do not steal window selection mid-flight.
  let active = requestedSessionId
    ? manager.getSession(requestedSessionId)
    : manager.getActive(windowId);
  if (requestedSessionId && !active) {
    return {
      ok: false,
      result: {
        status: 'error',
        error: 'The requested session no longer exists.',
        kind: 'session_not_found',
      },
    };
  }
  const workspace = resolveWindowWorkspace(windowId);

  const boundCwd = active?.cwd?.trim() || workspace.cwd;

  if (boundCwd == null || boundCwd === '') {
    return {
      ok: false,
      result: {
        status: 'error',
        error:
          'No project folder selected. Choose a folder before sending a message.',
        kind: 'unbound_workspace',
      },
    };
  }

  // Resolve once at turn start. The returned snapshot is independent from
  // whatever project another window selects while this turn is running.
  const runtime = getProjectRuntimeRegistry().get(boundCwd);

  const selection = preferredModel ?? active?.selection ?? runtime.config.default_model;
  if (selection == null) {
    return {
      ok: false,
      result: {
        status: 'error',
        error: 'A provider connection and model are required before sending a message.',
        kind: 'provider_required',
      },
    };
  }

  // Draft path: re-check in case a concurrent first-send just created a session.
  if (!active) {
    active = manager.getActive(windowId);
  }

  if (active) {
    const selectedNow = manager.getActive(windowId)?.id === active.id;
    // Legacy sessions may have null/empty cwd while the window workspace is
    // bound via sticky/draft. Persist that cwd only when this window has the
    // session selected (changeCwd requires selection; never switchTo to force it).
    if (selectedNow && (!active.cwd || active.cwd.trim() === '')) {
      manager.changeCwd(active.id, boundCwd);
      active = manager.getSession(active.id) ?? { ...active, cwd: boundCwd };
    }
    if (preferredModel && (
      active.selection?.connectionId !== preferredModel.connectionId
      || active.selection?.modelId !== preferredModel.modelId
    )) {
      if (selectedNow) {
        manager.changeModel(active.id, preferredModel, preferredModel.modelId);
        active = manager.getSession(active.id) ?? { ...active, selection: preferredModel };
      } else {
        // Turn-local override only — do not steal selection to persist.
        active = { ...active, selection: preferredModel };
      }
    }
    return { ok: true, cwd: boundCwd, session: active, runtime };
  }

  const session = manager.create(
    selection,
    { cwd: boundCwd },
    windowId,
    selection.modelId,
  );
  // Draft was promoted into the new session.
  clearDraftCwd(windowId);
  workingSetOpenOrFocus(session.id, windowId);
  if (canSend(webContents)) {
    webContents.send(IPC_CHANNELS.SESSION_CREATED, { session, draftGeneration });
  }
  return { ok: true, cwd: boundCwd, session, runtime };
}

/**
 * Window-level single-flight for draft first-send. Concurrent chat:send without
 * sessionId share one ensure promise so only one session is created.
 */
function ensureActiveSessionSingleFlight(
  webContents: WebContents,
  preferredModel?: ModelSelection | null,
  requestedSessionId?: string,
  draftGeneration?: number,
): EnsureActiveSessionResult | Promise<EnsureActiveSessionResult> {
  const windowId = String(webContents.id);
  const manager = getSessionManager();
  // Existing session or explicit id: no draft create race.
  if (requestedSessionId || manager.getActive(windowId)) {
    return ensureActiveSession(
      webContents,
      preferredModel,
      requestedSessionId,
      draftGeneration,
    );
  }

  const inflight = draftEnsureByWindow.get(windowId);
  if (inflight) return inflight;

  let resolveFlight!: (value: EnsureActiveSessionResult) => void;
  let rejectFlight!: (reason: unknown) => void;
  const flight = new Promise<EnsureActiveSessionResult>((resolve, reject) => {
    resolveFlight = resolve;
    rejectFlight = reject;
  });
  draftEnsureByWindow.set(windowId, flight);

  try {
    const result = ensureActiveSession(
      webContents,
      preferredModel,
      requestedSessionId,
      draftGeneration,
    );
    resolveFlight(result);
  } catch (error) {
    rejectFlight(error);
    draftEnsureByWindow.delete(windowId);
    throw error;
  } finally {
    queueMicrotask(() => {
      if (draftEnsureByWindow.get(windowId) === flight) {
        draftEnsureByWindow.delete(windowId);
      }
    });
  }
  return flight;
}

function classifyErrorKind(title: string | null | undefined, detail: string): ChatErrorKind {
  const haystack = `${title ?? ''} ${detail}`.toLowerCase();
  if (haystack.includes('rate limit') || haystack.includes('429') || haystack.includes('usage limit')) {
    return 'rate-limit';
  }
  if (
    haystack.includes('auth') ||
    haystack.includes('401') ||
    haystack.includes('403') ||
    haystack.includes('api key')
  ) {
    return 'auth';
  }
  if (
    haystack.includes('timeout') ||
    haystack.includes('timed out') ||
    haystack.includes('network') ||
    haystack.includes('connection')
  ) {
    return 'stream';
  }
  return 'generic';
}

/**
 * Build turn-local messages for multi-chain storage:
 * current user message (+ any pre-turn messages after priorMessageCount) +
 * tool/assistant messages produced during the turn.
 */
function turnMessagesFromAgent(agent: ActiveAgent): Message[] {
  const turnBase = agent.messages.slice(agent.priorMessageCount);
  return [...turnBase, ...agent.turnMessages];
}

/**
 * Persist flat LLM history + turn-local multi-chain write.
 *
 * - Window chatHistory keeps the full flattened conversation for the next send.
 * - Session storage writes only `turnMessages` onto the ACTIVE chain (or
 *   creates one via persistTurn when startChain was skipped).
 */
function persistTurnConversation(
  sessionId: string,
  fullHistory: Message[],
  turnMessages: Message[],
  status: ChainStatus,
  agent: Agent,
  selection?: ModelSelection | null,
  webContents?: WebContents,
): void {
  setChatHistory(sessionId, fullHistory);
  try {
    const sessionManager = getSessionManager();
    const updated = sessionManager.persistTurn({
      messages: turnMessages,
      status,
      selection,
      modelLabel: selection?.modelId ?? null,
      agentName: agent.name,
      agentType: agent.type,
      agentTier: agent.tier,
    }, sessionId);
    if (updated && webContents && canSend(webContents)) {
      webContents.send(IPC_CHANNELS.SESSION_UPDATED, { session: updated });
    }
  } catch (err) {
    console.debug('Failed to persist chat chain (non-fatal):', err);
  }
}

/** Flatten all session chains — never only the active/last chain. */
function historyFromSession(sessionId: string): Message[] {
  try {
    const session = getSessionManager().getSession(sessionId);
    if (!session) return [];
    return flattenSessionMessages(session);
  } catch {
    return [];
  }
}

/** Notify renderer of live session (multi-chain) state after startChain. */
function emitSessionUpdated(webContents: WebContents, sessionId: string): void {
  try {
    const session = getSessionManager().getSession(sessionId);
    if (session && canSend(webContents)) {
      webContents.send(IPC_CHANNELS.SESSION_UPDATED, { session });
    }
  } catch {
    // non-fatal
  }
}

// ── Stream function (wraps the orchestrator) ─────────────────────────────────

/**
 * Bind a turn's already-resolved adapter to the orchestrator. The typed
 * selection, project runtime, message history, and model instance are all
 * frozen before the actor starts, so a later settings change cannot redirect
 * credentials, tools, or a retry to another connection.
 */
function createProviderStreamFn(input: {
  readonly messages: Message[];
  readonly runtime: ProjectRuntime;
  readonly sessionId: string;
  readonly modelInstance: LanguageModelV4;
  readonly accounting: ProviderAttemptAccountingContext;
  readonly registry: ReturnType<typeof getBuiltinToolRegistryForRuntime>;
  readonly mcpManager: ReturnType<typeof acquireProjectMCPManager>;
}) {
  return async function* ({
    agent,
    systemPrompt,
    abortSignal,
  }: {
    message: string;
    agent: Agent;
    systemPrompt: string;
    abortSignal: AbortSignal;
  }): AsyncGenerator<StreamEvent> {
    const context = await buildSystemPromptContext({
      cwd: input.runtime.projectDir,
      config: input.runtime.config,
      sessionId: input.sessionId,
      agentScopeId: 'main',
    });
    yield* streamChat({
      messages: input.messages,
      agent,
      systemPrompt,
      context,
      config: input.runtime.config,
      registry: input.registry,
      mcpManager: input.mcpManager,
      sessionId: input.sessionId,
      projectRuntime: input.runtime,
      agentScopeId: 'main',
      abortSignal,
      modelInstance: input.modelInstance,
      accounting: input.accounting,
    });
  };
}

// ── Auto-naming callback factory ─────────────────────────────────────────────

const SESSION_NAMER_AGENT_NAME = 'session-namer';

/**
 * Creates a GenerateTitleCallback that uses the bundled internal session-namer
 * agent to produce a short title from the first user/assistant exchange.
 *
 * Non-fatal on failure — returns null so the session keeps its default name.
 */
function createGenerateTitleCallback(input: {
  runtime: ProjectRuntime;
  messages: readonly Message[];
  fallbackSelection: ModelSelection;
  accounting: Omit<ProviderAttemptAccountingContext, 'snapshot'>;
}): GenerateTitleCallback {
  return async () => {
    const userMessage = input.messages.find(
      (message) => message.role === MessageRole.USER && message.type === MessageType.TEXT,
    );
    const assistantMessage = input.messages.find(
      (message) => message.role === MessageRole.ASSISTANT && message.type === MessageType.TEXT,
    );
    if (!userMessage || !assistantMessage) {
      console.warn(
        '[auto-name] Completed exchange has no user/assistant text; keeping the default session name.',
      );
      return null;
    }

    try {
      const titleAgent = input.runtime.agents.get(SESSION_NAMER_AGENT_NAME);
      if (!titleAgent || titleAgent.type !== AgentType.INTERNAL) {
        console.warn(
          `[auto-name] Internal agent "${SESSION_NAMER_AGENT_NAME}" is unavailable; ` +
          'keeping the default session name.',
        );
        return null;
      }
      const titleSelection =
        getTierModelSelection(input.runtime.config, titleAgent.tier) ??
        input.fallbackSelection;
      const execution = await getProviderRuntime().resolveExecution(titleSelection);
      const { generateText, wrapLanguageModel } = await importESM<typeof import('ai')>('ai');
      const model = wrapLanguageModel({
        model: execution.modelInstance,
        middleware: createMiddlewareStack({
          retry: { maxRetries: input.runtime.config.llm_stream_retries },
          accounting: { ...input.accounting, snapshot: execution.snapshot },
        }),
      });
      const result = await generateText({
        model,
        instructions: titleAgent.system_prompt,
        abortSignal: AbortSignal.timeout(
          Math.max(1, input.runtime.config.llm_stream_idle_timeout * 1000),
        ),
        messages: [
          {
            role: 'user',
            content:
              `User: ${userMessage.content.slice(0, 500)}\n\n` +
              `Assistant: ${assistantMessage.content.slice(0, 500)}`,
          },
        ],
        // Orchid's accounting-aware retry middleware owns every retry attempt.
        maxRetries: 0,
      });
      return result.text.trim().split('\n')[0]?.trim() || null;
    } catch (error) {
      console.warn(
        '[auto-name] Title generation failed; keeping the default session name:',
        error,
      );
      return null;
    }
  };
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerChatIPC(): void {
  // chat:send — start a new agent conversation turn
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (event, payload: unknown) => {
    const webContents: WebContents = event.sender;

    // Validate input with zod
    const parsed = chatSendSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid chat:send payload: ${parsed.error.message}`);
    }

    const {
      message,
      model: preferredModel,
      sessionId: requestedSessionId,
    } = parsed.data;

    // Cancel any existing actor for this window
    const windowId = String(webContents.id);
    // Lazy session create + workspace gate (R2/R3): require valid workspace;
    // create with that cwd; if unbound, fail without streaming.
    // Resolves the session and captures its project runtime before actor setup.
    // Draft first-send uses window single-flight so concurrent sends do not
    // create duplicate sessions.
    const sessionGate = await Promise.resolve(
      ensureActiveSessionSingleFlight(
        webContents,
        preferredModel,
        requestedSessionId,
        parsed.data.draftGeneration,
      ),
    );
    if (!sessionGate.ok) {
      return sessionGate.result;
    }
    const sessionId = sessionGate.session.id;
    if (sessionsStarting.has(sessionId)) {
      return {
        status: 'error',
        error: 'A turn is already starting for this session.',
        kind: 'session_busy',
      };
    }
    sessionsStarting.add(sessionId);
    const existing = activeAgents.get(sessionId);

    // Freeze all project-bound definitions for the turn. Other windows may
    // navigate to different projects while this actor is still streaming.
    let runtime: ProjectRuntime;
    try {
      runtime = await hydrateProjectRuntime(sessionGate.runtime);
    } catch (error) {
      sessionsStarting.delete(sessionId);
      completeSessionActivity(sessionId, false);
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        kind: 'runtime_hydration_failed',
      };
    }
    if (existing) {
      forceAbortSession(sessionId);
    }
    publishSessionActivity(sessionId, {
      cwd: sessionGate.cwd,
      state: 'working',
      phase: 'agent',
      detail: 'Generating response',
      startedAt: Date.now(),
      completedAt: null,
      unread: false,
      canCancel: true,
    });
    const turnSelection = sessionGate.session.selection;
    if (turnSelection == null) {
      sessionsStarting.delete(sessionId);
      completeSessionActivity(sessionId, false);
      return {
        status: 'error',
        error: 'A provider connection and model are required before sending a message.',
        kind: 'provider_required',
      };
    }
    let modelInstance: LanguageModelV4;
    let providerSnapshot: ProviderAttemptAccountingContext['snapshot'];
    let accountingStore: ReturnType<typeof getProviderAccountingStore>;
    try {
      accountingStore = getProviderAccountingStore();
      const execution = await getProviderRuntime().resolveExecution(turnSelection);
      modelInstance = execution.modelInstance;
      providerSnapshot = execution.snapshot;
    } catch (error) {
      sessionsStarting.delete(sessionId);
      completeSessionActivity(sessionId, false);
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        kind: 'provider_unavailable',
      };
    }
    const agents = [...runtime.agents.values()];
    // Prefer live window history; fall back to flattened session chains.
    // If a prior agent is still streaming, forceAbort persists its partial
    // turn as INTERRUPTED (turn-local) before we open a new chain — never
    // dispose without persist (multi-chain orphan user-only INTERRUPTED).
    const existingMessages: Message[] =
      getChatHistory(sessionId) ?? historyFromSession(sessionId);

    // Build message history: existing messages + new user message
    const userMessage = makeUserMessage(message);
    const priorMessageCount = existingMessages.length;
    const messages = [...existingMessages, userMessage];

    // Get or create agent (default to "general" agent)
    const agent = agents.find((a) => a.name === 'general') ?? agents[0] ?? {
      name: 'general',
      type: 'subagent' as const,
      tier: 'bloom' as const,
      description: 'General-purpose agent',
      system_prompt: 'You are a helpful assistant.',
      allowed_tools: ['*'],
      allowed_skills: ['*'],
    };

    // Freeze turn tool/prompt context + model at send time (R6): mid-turn
    // session switch must not rebind tools, model, or working_directory.
    const sessionManager = getSessionManager();
    const activeSession = sessionGate.session;
    const turnCtx: ToolExecutionContext = {
      cwd: sessionGate.cwd,
      sessionId,
      projectRuntime: runtime,
      agentScopeId: 'main',
      selection: turnSelection,
    };

    // Multi-chain: open a new ACTIVE chain for this user turn (Python `_start_chain`).
    // Subagent parent_chain_index attributes to this chain while it is active.
    let turnId: string = crypto.randomUUID();
    let chainId: string | null = null;
    try {
      const chain = sessionManager.startChain({
        selection: turnSelection,
        modelLabel: activeSession.modelLabel ?? turnSelection.modelId,
        agentName: agent.name,
        agentType: agent.type,
        agentTier: agent.tier,
        messages: [userMessage],
      }, sessionId);
      chainId = chain?.id ?? null;
      turnId = chain?.id ?? turnId;
      emitSessionUpdated(webContents, sessionId);
    } catch (err) {
      console.debug('startChain failed (non-fatal):', err);
    }

    // Create the agent actor with message history.
    // Personality is read from the captured project snapshot, never the
    // mutable global registry used by the settings surface.
    const abortController = new AbortController();
    const baseSystemPrompt = agent.system_prompt || 'You are a helpful assistant.';
    const accounting: ProviderAttemptAccountingContext = {
      store: accountingStore,
      sessionId,
      chainId,
      turnId,
      snapshot: providerSnapshot,
    };
    const mcpManager = acquireProjectMCPManager(runtime);
    let resourcesReleased = false;
    const releaseResources = () => {
      if (resourcesReleased) return;
      resourcesReleased = true;
      releaseProjectMCPManager(runtime);
    };
    let actor: ReturnType<typeof createActor<typeof agentMachine>>;
    let interruptActor: ReturnType<typeof createActor<typeof interruptMachine>>;
    try {
      const turnRegistry = getBuiltinToolRegistryForRuntime(runtime, {
        agents: new Map(runtime.agents),
        skills: new Map(runtime.skills),
        mcpManager,
      });
      actor = createActor(agentMachine, {
        input: {
          agent,
          systemPrompt: appendProjectPersonality(baseSystemPrompt, runtime),
          streamFn: createProviderStreamFn({
            messages,
            runtime,
            sessionId,
            modelInstance,
            accounting,
            registry: turnRegistry,
            mcpManager,
          }),
        },
      });
      interruptActor = createActor(interruptMachine);
    } catch (error) {
      releaseResources();
      sessionsStarting.delete(sessionId);
      completeSessionActivity(sessionId, false);
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        kind: 'runtime_hydration_failed',
      };
    }

    // Track response for incremental updates
    let lastSentLength = 0;
    let lastThinkingLength = 0;
    let completed = false;
    let subscription: { unsubscribe: () => void } | null = null;
    let interruptSubscription: { unsubscribe: () => void } | null = null;
    let lastUsage: import('../../shared/types/message').Usage | null = null;
    let interruptResetTimer: ReturnType<typeof setTimeout> | null = null;
    let lastStreamingToolCallId: string | null = null;
    const lastStreamingToolArgLength = new Map<string, number>();
    let lastToolUpdateSequence = 0;
    let lastActivityKey = 'streaming:agent:Generating response';
    const generation = nextAgentGeneration(sessionId);
    const activeAgent: ActiveAgent = {
      sessionId,
      windowId,
      turnId,
      cwd: turnCtx.cwd,
      startedAt: Date.now(),
      actor,
      interruptActor,
      abortController,
      messages,
      priorMessageCount,
      turnMessages: [],
      // How much of context.response has already been snapshotted into turnMessages
      // as intermediate assistant text (so tools can interleave: text → tool → text).
      responseCommittedLength: 0,
      thinkingCommittedLength: 0,
      agent,
      selection: turnSelection,
      agentCancelled: false,
      finalized: false,
      generation,
      eventSequence: 0,
      toolCalls: new Map(),
      streamSegments: [],
      unsubscribe: () => subscription?.unsubscribe(),
      interruptUnsubscribe: () => interruptSubscription?.unsubscribe(),
      interruptResetTimer: null,
      releaseResources,
    };
    activeAgents.set(sessionId, activeAgent);
    sessionsStarting.delete(sessionId);

    /** Snapshot any response text that arrived before the next tool into turnMessages. */
    const flushResponseSegment = (fullResponse: string, attachUsage: Usage | null = null) => {
      if (fullResponse.length <= activeAgent.responseCommittedLength) return;
      const segment = fullResponse.slice(activeAgent.responseCommittedLength);
      activeAgent.responseCommittedLength = fullResponse.length;
      if (!segment.trim() && !attachUsage) return;
      activeAgent.turnMessages.push(makeAssistantMessage(segment, attachUsage));
    };

    /** Snapshot reasoning/thinking text into turnMessages (before tools / final text). */
    const flushThinkingSegment = (fullThinking: string) => {
      if (fullThinking.length <= activeAgent.thinkingCommittedLength) return;
      const segment = fullThinking.slice(activeAgent.thinkingCommittedLength);
      activeAgent.thinkingCommittedLength = fullThinking.length;
      if (!segment.trim()) return;
      activeAgent.turnMessages.push(makeThinkingMessage(segment));
    };

    const finalizeTurn = (opts: {
      response: string;
      usage: Usage | null;
      interrupted: boolean;
      sendDone: boolean;
    }) => {
      if (activeAgent.finalized) return;
      activeAgent.finalized = true;
      completed = true;

      // Flush any remaining thinking before the final assistant bubble.
      const ctxThinking =
        (activeAgent.actor.getSnapshot().context as AgentContext).thinking ?? '';
      flushThinkingSegment(ctxThinking);

      // Remaining text after the last tool (or the whole response if no tools).
      const remaining = opts.response.slice(activeAgent.responseCommittedLength);
      if (remaining || (opts.interrupted && activeAgent.responseCommittedLength === 0 && !opts.response)) {
        // Attach usage to the final assistant bubble when present.
        if (remaining || opts.interrupted) {
          activeAgent.turnMessages.push(
            makeAssistantMessage(remaining || opts.response || '', opts.usage),
          );
          activeAgent.responseCommittedLength = opts.response.length;
        }
      } else if (opts.usage) {
        // No remaining text — attach usage to the last assistant message if any.
        const last = activeAgent.turnMessages[activeAgent.turnMessages.length - 1];
        if (last && last.role === MessageRole.ASSISTANT && last.type === MessageType.TEXT) {
          activeAgent.turnMessages[activeAgent.turnMessages.length - 1] = {
            ...last,
            usage: opts.usage,
          };
        } else if (opts.interrupted) {
          activeAgent.turnMessages.push(makeAssistantMessage('', opts.usage));
        }
      }

      const turnExtras = [...activeAgent.turnMessages];
      const fullHistory = [...messages, ...turnExtras];
      persistTurnConversation(
        sessionId,
        fullHistory,
        turnMessagesFromAgent(activeAgent),
        opts.interrupted ? ChainStatus.INTERRUPTED : ChainStatus.COMPLETED,
        agent,
        activeAgent.selection,
        webContents,
      );
      activeAgent.messages = fullHistory;
      completeSessionActivity(
        sessionId,
        getSessionManager().getActive(windowId)?.id !== sessionId,
      );

      if (opts.sendDone) {
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_DONE, {
          type: 'done',
          response: opts.response,
          interrupted: opts.interrupted,
          usage: opts.usage,
        });
      }

      if (!opts.interrupted) {
        // Auto-name after first successful exchange (non-blocking)
        const sessionManager = getSessionManager();
        const generateTitle = createGenerateTitleCallback({
          runtime,
          messages: fullHistory,
          fallbackSelection: activeAgent.selection,
          accounting: {
            store: accountingStore,
            sessionId,
            chainId,
            turnId,
          },
        });
        sessionManager
          .autoName(sessionId, generateTitle)
          .then((updated) => {
            if (updated && canSend(webContents)) {
              webContents.send(IPC_CHANNELS.SESSION_RENAMED, {
                id: updated.id,
                name: updated.name,
              });
            }
          })
          .catch((err) => {
            console.warn('Auto-naming failed (non-fatal):', err);
          });
      }
    };

    // Track interrupt machine state changes and forward to renderer
    interruptSubscription = interruptActor.subscribe((interruptSnapshot) => {
      // Drop events from replaced/aborted agents (session switch, newer turn).
      if (!isCurrentAgent(sessionId, activeAgent)) {
        return;
      }

      const interruptState = interruptSnapshot.value as
        | 'idle'
        | 'confirmAgent'
        | 'confirmSubagents';

      // Clear any existing auto-reset timer
      if (interruptResetTimer) {
        clearTimeout(interruptResetTimer);
        interruptResetTimer = null;
        activeAgent.interruptResetTimer = null;
      }

      // Auto-reset interrupt to idle after 5s (matching Python timeout)
      if (interruptState !== 'idle') {
        interruptResetTimer = setTimeout(() => {
          interruptActor.send({ type: 'INTERRUPT_TIMEOUT' });
        }, 5000);
        activeAgent.interruptResetTimer = interruptResetTimer;
      } else if (activeAgent.agentCancelled) {
        // Interrupt TIMEOUT after Esc2 (main cancelled): always cancel
        // session-scoped subagents before dispose (M-P0-012 variant B).
        // Esc2 itself does not cancel subagents; only this path / Esc3 /
        // forceStopSession do.
        queueMicrotask(() => {
          if (activeAgents.get(sessionId) === activeAgent) {
            try {
              getSubagentManager().cancelRunning(sessionId);
            } catch (err) {
              console.debug(
                'interrupt timeout subagent cancel failed (non-fatal):',
                err,
              );
            }
            disposeActiveAgent(sessionId, activeAgent);
          }
        });
      }

      // Re-send CHAT_STATE with updated interrupt state
      const context = actor.getSnapshot().context as AgentContext;
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_STATE, {
          state: actor.getSnapshot().value,
          response: context.response,
          error: context.error,
          interruptState,
          cwd: turnCtx.cwd,
      });
    });

    // Subscribe to state changes and stream chunks to renderer
    subscription = actor.subscribe((snapshot) => {
      // Drop late events from cancelled, finalized, or generation-stale agents so
      // CHAT_CHUNK cannot leak across session switches / overlapping turns.
      if (!canEmitStreamEvents(sessionId, activeAgent)) {
        return;
      }

      const context = snapshot.context as AgentContext;
      const activityPhase = 'agent' as const;
      const activityDetail = context.streamingToolCall?.toolName
        ? `Preparing ${context.streamingToolCall.toolName}`
        : 'Generating response';
      const activityKey = `${String(snapshot.value)}:${activityPhase}:${activityDetail}`;
      if (activityKey !== lastActivityKey) {
        lastActivityKey = activityKey;
        publishSessionActivity(sessionId, {
          cwd: turnCtx.cwd,
          state: 'working',
          phase: activityPhase,
          detail: activityDetail,
          canCancel: true,
        });
      }

      // Send incremental text updates
      if (context.response.length > lastSentLength) {
        const newContent = context.response.slice(lastSentLength);
        lastSentLength = context.response.length;
        appendTextSegment(activeAgent, 'text', newContent);
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_CHUNK, {
            type: 'chunk',
            data: newContent,
        });
      }

      // Send incremental reasoning/thinking updates → Thought widgets
      const thinking = context.thinking ?? '';
      if (thinking.length > lastThinkingLength) {
        const newThinking = thinking.slice(lastThinkingLength);
        lastThinkingLength = thinking.length;
        appendTextSegment(activeAgent, 'thinking', newThinking);
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_THINKING, {
            type: 'thinking',
            data: newThinking,
        });
      }

      // Send state transitions (includes interrupt machine state)
      const interruptState = interruptActor.getSnapshot().value as
        | 'idle'
        | 'confirmAgent'
        | 'confirmSubagents';
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_STATE, {
          state: snapshot.value,
          response: context.response,
          error: context.error,
          interruptState,
          cwd: turnCtx.cwd,
      });

      // Forward usage data to renderer when it changes
      if (context.usage && context.usage !== lastUsage) {
        lastUsage = context.usage;
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_USAGE, {
            type: 'usage',
            usage: context.usage,
        });
      }

      // Forward tool call streaming events to renderer
      if (context.streamingToolCall) {
        const stc = context.streamingToolCall;
        if (stc.toolCallId !== lastStreamingToolCallId) {
          // New tool call started streaming
          lastStreamingToolCallId = stc.toolCallId;
          lastStreamingToolArgLength.set(stc.toolCallId, 0);
          ensureToolSnapshot(activeAgent, stc.toolCallId, stc.toolName);
          sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_START, {
              type: 'tool_call_start',
              toolCallId: stc.toolCallId,
              toolName: stc.toolName,
          });
        }
        // Send only the new delta. The machine stores accumulated args.
        const previousLength = lastStreamingToolArgLength.get(stc.toolCallId) ?? 0;
        const argsDelta = stc.partialArgs.slice(previousLength);
        if (argsDelta) {
          lastStreamingToolArgLength.set(stc.toolCallId, stc.partialArgs.length);
          const current = ensureToolSnapshot(activeAgent, stc.toolCallId, stc.toolName);
          updateToolSnapshot(activeAgent, stc.toolCallId, stc.toolName, {
            partialArgs: current.partialArgs + argsDelta,
          });
          sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_DELTA, {
            type: 'tool_call_delta',
            toolCallId: stc.toolCallId,
            argsDelta,
          });
        }
      } else if (lastStreamingToolCallId) {
        // Tool call streaming ended (transitioned to executing or completed)
        lastStreamingToolCallId = null;
      }

      // Forward tool lifecycle status updates to renderer + persist tool messages
      if (
        context.toolLifecycleUpdate &&
        context.toolLifecycleUpdate.sequence !== lastToolUpdateSequence
      ) {
        const update = context.toolLifecycleUpdate;
        lastToolUpdateSequence = update.sequence;

        updateToolSnapshot(activeAgent, update.toolCallId, update.toolName ?? 'unknown', {
          toolName: update.toolName ?? 'unknown',
          status: update.status,
          args: update.args ?? '',
          content: update.content ?? null,
          toolResult: update.toolResult ?? null,
          finishedAt: update.status === 'running' ? null : new Date().toISOString(),
        });
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, {
          type: 'tool_call_update',
          toolCallId: update.toolCallId,
          toolName: update.toolName,
            status: update.status,
            args: update.args,
            content: update.content,
            toolResult: update.toolResult,
        });

        // Record tool call/result messages once per lifecycle event.
        // Flush any assistant text that streamed *before* this tool so history
        // stays chronological: text → tool → text → tool → …
        if (update.status === 'running' && update.args != null) {
          const already = activeAgent.turnMessages.some(
            (m) =>
              m.type === MessageType.TOOL_CALL &&
              m.tool_call_id === update.toolCallId,
          );
          if (!already) {
            flushThinkingSegment(context.thinking ?? '');
            flushResponseSegment(context.response);
            activeAgent.turnMessages.push(
              makeToolCallMessage(
                update.toolCallId,
                update.toolName ?? 'unknown',
                update.args,
              ),
            );
          }
        }

        if (update.status !== 'running') {
          // Ensure tool-call message exists (fallback path without streaming start)
          const hasCall = activeAgent.turnMessages.some(
            (m) =>
              m.type === MessageType.TOOL_CALL &&
              m.tool_call_id === update.toolCallId,
          );
          if (!hasCall) {
            flushThinkingSegment(context.thinking ?? '');
            flushResponseSegment(context.response);
            activeAgent.turnMessages.push(
              makeToolCallMessage(
                update.toolCallId,
                update.toolName ?? 'unknown',
                update.args ?? '{}',
              ),
            );
          }

          const hasResult = activeAgent.turnMessages.some(
            (m) =>
              m.type === MessageType.TOOL_RESULT &&
              m.tool_call_id === update.toolCallId,
          );
          if (!hasResult) {
            activeAgent.turnMessages.push(
              makeToolResultMessage(
                update.toolCallId,
                update.toolName ?? 'unknown',
                update.content ?? '',
                update.toolResult!,
              ),
            );
          }
        }
      }

      // Clean up on successful terminal idle
      if (
        snapshot.value === 'idle' &&
        context.currentInput &&
        !completed &&
        !activeAgent.agentCancelled
      ) {
        finalizeTurn({
          response: context.response,
          usage: context.usage ?? null,
          interrupted: false,
          sendDone: true,
        });
        queueMicrotask(() => {
          disposeActiveAgent(sessionId, activeAgent);
        });
      }

      if (snapshot.value === 'error') {
        completed = true;
        activeAgent.finalized = true;
        const detail = context.error ?? 'Unknown error';
        const title = context.errorTitle ?? 'Stream Error';
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_ERROR, {
          type: 'error',
          error: detail,
          title,
          kind: classifyErrorKind(title, detail),
        });
        publishSessionActivity(sessionId, {
          cwd: turnCtx.cwd,
          state: 'needs_attention',
          phase: 'agent',
          detail: title || detail,
          canCancel: false,
        });
        // Persist turn so far: only uncommitted assistant text (same as cancel/finalize).
        flushPartialTurnContent(activeAgent, context);
        const fullHistory = [...messages, ...activeAgent.turnMessages];
        persistTurnConversation(
          sessionId,
          fullHistory,
          turnMessagesFromAgent(activeAgent),
          ChainStatus.FAILED,
          agent,
          activeAgent.selection,
          webContents,
        );
        queueMicrotask(() => {
          disposeActiveAgent(sessionId, activeAgent);
        });
      }
    });

    try {
      // Start the actor and send user input
      actor.start();
      interruptActor.start();

      // Immediate state so the renderer gets cwd/model chrome before first chunk
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_STATE, {
        state: 'streaming',
        response: '',
        error: null,
        interruptState: 'idle',
        cwd: turnCtx.cwd,
      });

      actor.send({ type: 'USER_INPUT', message });
    } catch (error) {
      disposeActiveAgent(sessionId, activeAgent);
      completeSessionActivity(sessionId, false);
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        kind: 'runtime_hydration_failed',
      };
    }

    return { status: 'started', sessionId, turnId };
  });

  // chat:snapshot — atomically hydrate a renderer that returns to a running session.
  // This is deliberately read-only: it never changes the sender window's selection.
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SNAPSHOT,
    async (event, payload: unknown): Promise<ChatSessionSnapshot | null> => {
      const parsed = chatSnapshotSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        throw new Error(`Invalid chat:snapshot payload: ${parsed.error.message}`);
      }
      const windowId = String(event.sender.id);
      const sessionId =
        parsed.data.sessionId ?? getSessionManager().getActive(windowId)?.id;
      if (!sessionId) return null;
      const session = getSessionManager().getSession(sessionId);
      if (!session) return null;
      const active = activeAgents.get(sessionId);
      return {
        sessionId,
        messages: flattenSessionMessages(session),
        // Finalization and persistence share one synchronous callback, so a
        // finalized actor is already represented by history when IPC observes it.
        live: active && !active.finalized ? snapshotForAgent(active) : null,
      };
    },
  );

  // chat:stop — immediate targeted cancellation from the global Activity list.
  ipcMain.handle(IPC_CHANNELS.CHAT_STOP, async (_event, payload: unknown) => {
    const parsed = chatStopSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid chat:stop payload: ${parsed.error.message}`);
    }
    return {
      status: forceStopSession(parsed.data.sessionId)
        ? 'stopped'
        : 'no_active_stream',
    };
  });

  // chat:cancel — three-phase Esc: hint → cancel agent → cancel subagents
  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL, async (event, payload: unknown) => {
    const webContents: WebContents = event.sender;
    const windowId = String(webContents.id);
    const parsed = chatCancelSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid chat:cancel payload: ${parsed.error.message}`);
    }
    const sessionId =
      parsed.data.sessionId ?? getSessionManager().getActive(windowId)?.id;
    if (!sessionId) return { status: 'no_active_stream' };
    const existing = activeAgents.get(sessionId);

    if (!existing) {
      return { status: 'no_active_stream' };
    }

    // A global activity row may stop work owned by another window. Route turn
    // events back to that session's renderer so the requester never receives
    // a different session's chunks, completion, or interrupt state.
    const streamWebContents =
      webContentsForWindowId(existing.windowId) ?? webContents;

    const interruptSnapshot = existing.interruptActor.getSnapshot();
    const interruptState = interruptSnapshot.value as
      | 'idle'
      | 'confirmAgent'
      | 'confirmSubagents';

    // First Esc while streaming → show interrupt hint (don't cancel yet)
    if (interruptState === 'idle') {
      existing.interruptActor.send({ type: 'INTERRUPT' });
      return { status: 'confirming' };
    }

    // Second Esc while confirming agent → cancel the stream and persist partial.
    if (interruptState === 'confirmAgent') {
      getBackgroundStore().terminateSession(sessionId);
      existing.agentCancelled = true;
      const context = existing.actor.getSnapshot().context as AgentContext;
      existing.actor.send({ type: 'CANCEL' });

      // Finalize immediately with partial content (no "[Interrupted by user]" suffix).
      // Only append text not already flushed into turnMessages before tools.
      if (!existing.finalized) {
        existing.finalized = true;
        const partial = context.response ?? '';
        const thinking = context.thinking ?? '';
        const usage = context.usage ?? null;
        // Flush reasoning before final text
        if (thinking.length > existing.thinkingCommittedLength) {
          const thinkSeg = thinking.slice(existing.thinkingCommittedLength);
          existing.thinkingCommittedLength = thinking.length;
          if (thinkSeg.trim()) {
            existing.turnMessages.push(makeThinkingMessage(thinkSeg));
          }
        }
        const remaining = partial.slice(existing.responseCommittedLength);
        if (remaining || existing.turnMessages.length === 0) {
          existing.turnMessages.push(
            makeAssistantMessage(remaining || partial, usage),
          );
          existing.responseCommittedLength = partial.length;
        } else if (usage) {
          const last = existing.turnMessages[existing.turnMessages.length - 1];
          if (last && last.role === MessageRole.ASSISTANT && last.type === MessageType.TEXT) {
            existing.turnMessages[existing.turnMessages.length - 1] = {
              ...last,
              usage,
            };
          }
        }
        // existing.messages already includes the user message for this turn
        const fullHistory = [...existing.messages, ...existing.turnMessages];
        persistTurnConversation(
          sessionId,
          fullHistory,
          turnMessagesFromAgent(existing),
          ChainStatus.INTERRUPTED,
          existing.agent,
          existing.selection,
          streamWebContents,
        );
        completeSessionActivity(
          sessionId,
          getSessionManager().getActive(existing.windowId)?.id !== sessionId,
        );

        sendTurnEvent(streamWebContents, existing, IPC_CHANNELS.CHAT_DONE, {
          type: 'done',
          response: partial,
          interrupted: true,
          usage,
        });
        sendTurnEvent(streamWebContents, existing, IPC_CHANNELS.CHAT_STATE, {
          state: 'idle',
          response: partial,
          error: null,
          interruptState: 'confirmSubagents',
          cwd: existing.cwd,
        });
      }

      // Future: detect running subagents. For now always expose the phase briefly
      // then allow a third Esc (or timeout dispose) to finish cleanup.
      existing.interruptActor.send({ type: 'INTERRUPT' });

      // If no subagents are tracked, complete cancel immediately so the
      // renderer gets a clean `cancelled` status after confirming_subagents.
      // Keep the actor briefly so the interrupt UI can show the third phase.
      return { status: 'confirming_subagents' };
    }

    // Third Esc while confirming subagents → cancel subagents and dispose
    if (interruptState === 'confirmSubagents') {
      getBackgroundStore().terminateSession(sessionId);
      getSubagentManager().cancelRunning(sessionId);
      disposeActiveAgent(sessionId, existing);
      sendTurnEvent(streamWebContents, existing, IPC_CHANNELS.CHAT_STATE, {
          state: 'idle',
          response: '',
          error: null,
          interruptState: 'idle',
          cwd: existing.cwd,
      });
      return { status: 'cancelled' };
    }

    return { status: 'no_active_stream' };
  });

  // bgcmd:snapshot — get background command output snapshot (session-scoped)
  ipcMain.handle(IPC_CHANNELS.BG_CMD_SNAPSHOT, async (event, payload: unknown) => {
    const parsed = bgCommandSnapshotSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid bgcmd:snapshot payload: ${parsed.error.message}`);
    }

    const { commandId, lastN, sessionId: requestedSessionId } = parsed.data;
    const windowId = String(event.sender.id);
    const sessionId =
      requestedSessionId ?? getSessionManager().getActive(windowId)?.id ?? null;
    if (!sessionId) {
      return { tail: '', exitCode: null };
    }

    const store = getBackgroundStore();
    // Session ownership only — include main and subagent-scoped bgcmds.
    const snap = store.snapshotForSession(commandId, lastN ?? 50, sessionId);
    if (!snap) {
      return { tail: '', exitCode: null };
    }

    return snap;
  });
}

/**
 * Unregister chat IPC handlers (for cleanup/testing).
 */
export function unregisterChatIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SEND);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_CANCEL);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_STOP);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_SNAPSHOT);

  // Tear down active agents via dispose so MCP project leases are released.
  for (const [sessionId, agent] of [...activeAgents.entries()]) {
    agent.agentCancelled = true;
    agent.finalized = true;
    disposeActiveAgent(sessionId, agent);
  }
  activeAgents.clear();
  sessionsStarting.clear();
  draftEnsureByWindow.clear();
  agentGenerations.clear();
  clearAllChatHistory();
}
