/**
 * useChat — manages chat state, sends messages, subscribes to IPC events.
 *
 * Provides:
 * - Messages array (accumulated from IPC events)
 * - Streaming state + partial content
 * - send(), cancel() actions
 * - Smart auto-scroll signal
 * - Usage tracking (tokens)
 * - Elapsed time tracking
 */
import { useState, useEffect, useCallback, useRef, useMemo, useReducer } from 'react';
import type { Message, Usage } from '../../shared/types/message';
import type { ModelSelection } from '../../shared/types/provider';
import { MessageRole, MessageType } from '../../shared/types/message';
import type {
  ChatChunkEvent,
  ChatThinkingEvent,
  ChatStateEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatUsageEvent,
  ChatToolCallDeltaEvent,
  ChatToolCallStartEvent,
  ChatToolCallUpdateEvent,
  ChatToolCallSnapshot,
  ChatSnapshot,
  ChatSessionSnapshot,
  ChatStreamSegmentSnapshot,
  CompactionProgressEvent,
} from '../../shared/types/ipc';
import {
  addUsage,
  hasUsage,
  latestUsageFromMessages,
  sumMessageUsages,
} from '../../shared/usage';
import type { CanonicalToolResult } from '../../shared/types/tool-result';
import {
  reduceChatTurnProjection,
  type ChatTurnCompactionProgress,
  type ChatTurnEventAction,
  type ChatTurnProjection,
  type ChatTurnProjectionAction,
  type ChatTurnToolSnapshot,
} from '../../shared/chat/turn-projection';

// ── Types ────────────────────────────────────────────────────────────────────

export type ChatStatus = 'idle' | 'streaming' | 'error';

export type InterruptState = 'idle' | 'confirmAgent' | 'confirmSubagents';

export type ToolBlockStatus =
  | 'generating'
  | 'running'
  | 'completed'
  | 'failed'
  | 'complete'
  | 'partial'
  | 'empty'
  | 'error'
  | 'cancelled';

export interface ToolBlock {
  id: string;
  toolName: string;
  status: ToolBlockStatus;
  partialArgs: string;
  args: string;
  /** Exact finalized agent projection for terminal tool calls. */
  agentProjection: string | null;
  /** Canonical terminal facts; null while generating/running. */
  toolResult: CanonicalToolResult | null;
  startedAt: string;
  finishedAt: string | null;
  /** Calibrated token estimate of `agentProjection` while generating; null when unknown. */
  estimatedTokens?: number | null;
}

/** Preserve canonical facts while adapting a main-process live snapshot. */
export function chatToolSnapshotToBlock(tool: ChatToolCallSnapshot | ChatTurnToolSnapshot): ToolBlock {
  return {
    id: tool.toolCallId,
    toolName: tool.toolName,
    status: tool.status,
    partialArgs: tool.partialArgs,
    args: tool.args,
    agentProjection: tool.content,
    toolResult: tool.toolResult,
    startedAt: tool.startedAt,
    finishedAt: tool.finishedAt,
    estimatedTokens: tool.estimatedTokens ?? null,
  };
}

/**
 * Chronological segments for the in-flight turn.
 * Preserves call order: tool → text → tool → text → …
 */
export type StreamSegment = ChatStreamSegmentSnapshot;

export interface ChatState {
  /** All messages in the current chain. */
  messages: Message[];
  /** Current streaming status. */
  status: ChatStatus;
  /** Partial content being streamed (before commit). */
  streamingContent: string;
  /** Thinking content being streamed. */
  streamingThinking: string;
  /** Tool calls generated or run during the current turn. */
  toolBlocks: ToolBlock[];
  /**
   * Ordered live segments for the current stream (tools + text in call order).
   * Empty when idle / after commit.
   */
  streamSegments: StreamSegment[];
  /** Monotonic signal for bounded auto-scroll updates. */
  streamRevision: number;
  /** Error message if status is 'error'. */
  error: string | null;
  /** Latest usage data from the stream. */
  usage: Usage | null;
  /**
   * In-flight turn usage only (cleared on send/done). Use for live chain-footer
   * token lines so a new turn does not flash the previous turn's counters.
   */
  currentTurnUsage: Usage | null;
  /**
   * Stream start time (ms epoch) for elapsed tracking.
   * Footers tick locally from this; history memos must not depend on a ticker.
   */
  streamStartTime: number | null;
  /** Current interrupt confirmation phase. */
  interruptState: InterruptState;
  /** Whether the last completed chain was interrupted by the user. */
  interrupted: boolean;
  /** Cumulative usage summed across all messages in the session. */
  cumulativeUsage: Usage;
  /** Active workspace cwd (session → draft → sticky); empty when unbound. */
  cwd: string;
  /**
   * Live main-scope compaction progress from `compaction_progress` turn
   * events; null when no compaction is in flight. Replay derives the terminal
   * widget from the persisted `compacted` marker instead.
   */
  compactionProgress: ChatTurnCompactionProgress | null;
}

export interface ChatSendOptions {
  /** Preferred model when main lazy-creates a session from draft mode. */
  model?: ModelSelection;
  /** Explicit session owner; omitted only while composing an unsaved draft. */
  sessionId?: string;
  /** Current draft navigation generation, echoed with lazy SESSION_CREATED. */
  draftGeneration?: number;
}

export interface UseChatOptions {
  /**
   * Invoked when chat:send fails with `untrusted_project`. When present the
   * structured failure opens the trust dialog instead of pushing a raw error
   * bubble; when absent the generic error behavior is kept.
   */
  onUntrustedProject?: () => void;
  /** Durable session total derived from chain summaries, including unloaded pages. */
  persistedSessionUsage?: Usage | null;
  /** Newest durable turn usage, including its context snapshot when available. */
  latestPersistedUsage?: Usage | null;
}

export interface UseChatReturn extends ChatState {
  /**
   * Send a message to the chat. Resolves `true` only when a turn actually
   * started; gate failures (busy, switching, structured send errors) resolve
   * `false` instead of rejecting.
   */
  send: (message: string, options?: ChatSendOptions) => Promise<boolean>;
  /** Cancel the current stream. */
  cancel: () => Promise<void>;
  /** Immediately stop one session from a global activity control. */
  stop: (sessionId: string) => Promise<void>;
  /** Clear the error state. */
  clearError: () => void;
  /**
   * Replace messages and wipe all live/stale chat UI state (session switch /
   * new session). Clears tools, streaming, usage, errors, interrupt flags.
   */
  setMessages: (messages: Message[]) => void;
  /** Read live state for a session without changing selection. */
  getSnapshot: (sessionId: string) => Promise<ChatSessionSnapshot | null>;
  /**
   * Bind event affinity immediately and buffer the target while it hydrates.
   * Keeps previous messages/usage painted until hydrate so sidebar/footer
   * do not flash zeros during the async session load.
   */
  beginSessionSwitch: (sessionId: string | null) => void;
  /** Apply a snapshot after the caller has committed a session selection. */
  hydrateSnapshot: (snapshot: ChatSessionSnapshot | null) => void;
  /**
   * Drop the live tail (segments, tools, streaming text) after a compaction
   * rewrote the durable chains: flagged content must not keep rendering below
   * the compacted stub, and preserved content re-renders from the reloaded
   * chains. Keeps turn identity, status, and the sequence watermark.
   */
  resetLiveTail: () => void;
  /** True while a session switch is in flight (affinity rebound, not yet hydrated). */
  isSwitchingSession: boolean;
}

export interface ChatEventAffinity {
  selectedSessionId: string | null;
  streamSessionId: string | null;
  streamTurnId: string | null;
  lastSequence: number;
}

export function acceptChatEvent(
  affinity: ChatEventAffinity,
  event: { sessionId: string; turnId: string; sequence: number },
  isSending: boolean,
  rebindTurnWhenIdle = false,
): boolean {
  if (affinity.selectedSessionId && event.sessionId !== affinity.selectedSessionId) return false;
  if (!affinity.selectedSessionId && affinity.streamSessionId && event.sessionId !== affinity.streamSessionId) return false;
  if (!affinity.selectedSessionId && !affinity.streamSessionId) {
    if (!isSending) return false;
    affinity.streamSessionId = event.sessionId;
  }
  if (affinity.streamTurnId && affinity.streamTurnId !== event.turnId) {
    // A manual /compact emits progress outside any turn with its own synthetic
    // turnId. While the renderer holds no live stream the mismatch rebinds
    // (with a fresh sequence watermark); while streaming, a mismatched turnId
    // is a foreign or stale event and stays rejected.
    if (!(rebindTurnWhenIdle && !isSending)) return false;
    affinity.streamTurnId = event.turnId;
    affinity.lastSequence = event.sequence;
    return true;
  }
  if (affinity.streamTurnId === event.turnId && event.sequence <= affinity.lastSequence) return false;
  affinity.streamTurnId = event.turnId;
  affinity.lastSequence = event.sequence;
  return true;
}

export function bindChatSession(
  affinity: ChatEventAffinity,
  sessionId: string | null,
): void {
  affinity.selectedSessionId = sessionId;
  affinity.streamSessionId = sessionId;
  affinity.streamTurnId = null;
  affinity.lastSequence = -1;
}

export function shouldBufferChatEvent(
  hydratingSessionId: string | null,
  event: { sessionId: string },
): boolean {
  return hydratingSessionId != null && event.sessionId === hydratingSessionId;
}

/** Cache persisted totals independently from high-frequency live-turn usage. */
export function useCumulativeUsage(
  messages: readonly Message[],
  currentTurnUsage: Usage | null,
  persistedSessionUsage?: Usage | null,
): Usage {
  const persistedUsage = useMemo(
    () => persistedSessionUsage ?? sumMessageUsages(messages),
    [messages, persistedSessionUsage],
  );
  return useMemo(
    () => addUsage(persistedUsage, currentTurnUsage),
    [persistedUsage, currentTurnUsage],
  );
}

/**
 * Seed stream affinity from a live snapshot so replayed buffered events are
 * sequence-gated against the snapshot high-water mark.
 */
export function seedAffinityFromLive(
  affinity: ChatEventAffinity,
  live: Pick<ChatSnapshot, 'sessionId' | 'turnId' | 'sequence'>,
): void {
  affinity.streamSessionId = live.sessionId;
  affinity.streamTurnId = live.turnId;
  affinity.lastSequence = live.sequence;
}

// ── Cancel queue (multi-phase Esc) ────────────────────────────────────────────

/**
 * Serialize chat.cancel IPC while still allowing a second Esc to stage the next
 * interrupt phase. Concurrent cancel invokes are unsafe (phase races); a single
 * pending flag coalesces rapid Esc into one follow-up after the in-flight RTT.
 */
export type CancelQueueState = {
  inFlight: boolean;
  pending: boolean;
};

/** Start a cancel IPC, or stage one if another cancel is already awaiting. */
export function beginCancelRequest(state: CancelQueueState): 'run' | 'queued' {
  if (state.inFlight) {
    state.pending = true;
    return 'queued';
  }
  state.inFlight = true;
  state.pending = false;
  return 'run';
}

/**
 * After one cancel IPC settles: clear in-flight, or keep ownership and signal
 * that a staged Esc should run the next phase immediately.
 */
export function consumePendingCancel(state: CancelQueueState): boolean {
  if (!state.pending) {
    state.inFlight = false;
    return false;
  }
  state.pending = false;
  return true;
}

export function resetCancelQueue(state: CancelQueueState): void {
  state.inFlight = false;
  state.pending = false;
}

/** Drop the optimistic user bubble when send never started on the main side. */
export function dropOptimisticUserMessageIfLast<T extends { id: string }>(
  messages: ReadonlyArray<T>,
  optimisticId: string,
): T[] {
  const last = messages[messages.length - 1];
  if (last && last.id === optimisticId) {
    return messages.slice(0, -1);
  }
  return messages.slice();
}

/** Merge one authoritative terminal turn without rematerializing full model history. */
export function mergeTerminalTurnMessages(
  current: readonly Message[],
  terminal: readonly Message[],
): Message[] {
  if (terminal.length === 0) return [...current];
  const terminalIds = new Set(terminal.map((message) => message.id));
  const base = current.filter((message) => !terminalIds.has(message.id));
  const firstUser = terminal.find((message) => message.role === MessageRole.USER);
  if (firstUser) {
    for (let index = base.length - 1; index >= 0; index -= 1) {
      const candidate = base[index];
      if (
        candidate?.role === MessageRole.USER
        && candidate.content === firstUser.content
      ) {
        base.splice(index, 1);
        break;
      }
    }
  }
  return [...base, ...terminal];
}

// ── Elapsed display (footer-local; never feed history memos) ─────────────────

/**
 * 1s-resolution elapsed seconds from a stream start timestamp.
 * Kept out of chat history memos so a ticker cannot rebuild O(n) stream items.
 */
export function useElapsedSeconds(
  streamStartTime: number | null | undefined,
  active: boolean,
): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active || streamStartTime == null) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed((Date.now() - streamStartTime) / 1000);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [active, streamStartTime]);
  return elapsed;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

type ProjectionState = { projection: ChatTurnProjection | null; revision: number };
type AffinityController = { activeSessionId: string | null; value: ChatEventAffinity };
type BufferedProjectionEvent = { event: ChatTurnEventAction };

function isProjectionLifecycleEvent(event: ChatTurnEventAction): boolean {
  return 'state' in event
    || event.type === 'tool_call_start'
    || event.type === 'tool_call_update'
    || event.type === 'done'
    || event.type === 'error';
}

function reduceProjectionState(state: ProjectionState, action: ChatTurnProjectionAction): ProjectionState {
  const projection = reduceChatTurnProjection(state.projection, action);
  return projection === state.projection ? state : { projection, revision: state.revision + 1 };
}

export function useChat(
  activeSessionId: string | null = null,
  options: UseChatOptions = {},
): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  // Ref-mirror the optional callback so `send` keeps a stable identity and a
  // new closure from the caller never rebuilds every streaming token.
  const onUntrustedProjectRef = useRef<(() => void) | undefined>(options.onUntrustedProject);
  onUntrustedProjectRef.current = options.onUntrustedProject;
  const [projectionState, dispatchProjectionState] = useReducer(reduceProjectionState, { projection: null, revision: 0 });
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);
  const pendingFrameActionsRef = useRef<ChatTurnEventAction[]>([]);
  const streamFrameIdRef = useRef<number | null>(null);
  const isSendingRef = useRef(false);
  const cancelQueueRef = useRef<CancelQueueState>({ inFlight: false, pending: false });
  const affinityRef = useRef<AffinityController>({
    activeSessionId,
    value: { selectedSessionId: activeSessionId, streamSessionId: activeSessionId, streamTurnId: null, lastSequence: -1 },
  });
  const hydrationRef = useRef<{ sessionId: string; events: BufferedProjectionEvent[] } | null>(null);

  const dispatchProjection = useCallback((action: ChatTurnProjectionAction) => {
    dispatchProjectionState(action);
  }, []);
  const projection = projectionState.projection;
  const persistedUsage = useMemo(
    () => latestUsageFromMessages(messages) ?? options.latestPersistedUsage ?? null,
    [messages, options.latestPersistedUsage],
  );
  const status: ChatStatus = projection?.status ?? 'idle';
  const streamingContent = projection?.response ?? '';
  const streamingThinking = projection?.thinking ?? '';
  const toolBlocks = useMemo(() => projection?.toolCalls.map(chatToolSnapshotToBlock) ?? [], [projection?.toolCalls]);
  const streamSegments = projection?.streamSegments ?? [];
  const usage = projection?.usage ?? persistedUsage;
  const currentTurnUsage = status === 'streaming' && projection?.usage && hasUsage(projection.usage) ? projection.usage : null;
  const streamStartTime = status === 'streaming' ? projection?.startedAt ?? null : null;
  const interruptState: InterruptState = projection?.interruptState ?? 'idle';
  const interrupted = projection?.interrupted ?? false;
  const cwd = projection?.cwd ?? '';
  const error = projection?.terminal?.type === 'error' && projection.terminal.title && !projection.terminal.error.startsWith(projection.terminal.title)
    ? `${projection.terminal.title}: ${projection.terminal.error}`
    : projection?.error ?? null;
  const compactionProgress = projection?.compactionProgress ?? null;
  const cumulativeUsage = useCumulativeUsage(
    messages,
    currentTurnUsage,
    options.persistedSessionUsage,
  );

  useEffect(() => {
    if (isSwitchingSession) return;
    const controller = affinityRef.current;
    const switched = controller.activeSessionId !== activeSessionId;
    const belongsToSelection = controller.value.streamSessionId === activeSessionId;
    controller.activeSessionId = activeSessionId;
    controller.value.selectedSessionId = activeSessionId;
    controller.value.streamSessionId = activeSessionId;
    if (switched && !belongsToSelection) {
      controller.value.streamTurnId = null;
      controller.value.lastSequence = -1;
    }
  }, [activeSessionId, isSwitchingSession]);

  const acceptsEvent = useCallback(
    (
      event: Pick<ChatTurnEventAction, 'sessionId' | 'turnId' | 'sequence'>,
      opts?: { readonly rebindTurnWhenIdle?: boolean },
    ) => acceptChatEvent(affinityRef.current.value, event, isSendingRef.current, opts?.rebindTurnWhenIdle),
    [],
  );
  const cancelStreamFrame = useCallback(() => {
    if (streamFrameIdRef.current == null) return;
    window.cancelAnimationFrame(streamFrameIdRef.current);
    streamFrameIdRef.current = null;
  }, []);
  const flushStreamFrame = useCallback(() => {
    cancelStreamFrame();
    const actions = pendingFrameActionsRef.current;
    pendingFrameActionsRef.current = [];
    if (actions.length > 0) dispatchProjection({ type: 'events', actions });
  }, [cancelStreamFrame, dispatchProjection]);
  const scheduleStreamFrame = useCallback(() => {
    if (streamFrameIdRef.current != null) return;
    streamFrameIdRef.current = window.requestAnimationFrame(() => {
      streamFrameIdRef.current = null;
      const actions = pendingFrameActionsRef.current;
      pendingFrameActionsRef.current = [];
      if (actions.length > 0) dispatchProjection({ type: 'events', actions });
    });
  }, [dispatchProjection]);
  const discardStreamFrame = useCallback(() => {
    cancelStreamFrame();
    pendingFrameActionsRef.current = [];
  }, [cancelStreamFrame]);
  const bufferHydrationEvent = useCallback((event: ChatTurnEventAction): boolean => {
    const hydration = hydrationRef.current;
    if (!hydration || !shouldBufferChatEvent(hydration.sessionId, event)) return false;
    hydration.events.push({ event });
    return true;
  }, []);
  const applyLiveEvent = useCallback((event: ChatTurnEventAction) => {
    // Directly dispatched events advance the projection sequence watermark.
    // Publish any frame-batched deltas first so a later usage or lifecycle
    // event cannot make them stale before the next animation frame.
    flushStreamFrame();
    dispatchProjection({ type: 'events', actions: [event] });
    if ('state' in event) return;
    if (event.type === 'done') {
      setMessages((current) => mergeTerminalTurnMessages(current, event.messages));
      dispatchProjection({ type: 'clear_stream', status: 'idle' });
      isSendingRef.current = false;
    }
    if (event.type === 'error') {
      setMessages((current) => mergeTerminalTurnMessages(current, event.messages));
      dispatchProjection({ type: 'clear_stream', status: 'idle' });
      isSendingRef.current = false;
    }
  }, [dispatchProjection, flushStreamFrame]);
  const deliverEvent = useCallback((event: ChatTurnEventAction, opts?: { readonly rebindTurnWhenIdle?: boolean }) => {
    // Actor idle/interrupted snapshots can straddle the terminal event. They
    // must not end the renderer turn or claim affinity for the next queued
    // turn; done/error owns the terminal handoff and authoritative messages.
    if ('state' in event && (event.state === 'idle' || event.state === 'interrupted')) return;
    if (bufferHydrationEvent(event)) return;
    if (acceptsEvent(event, opts)) applyLiveEvent(event);
  }, [acceptsEvent, applyLiveEvent, bufferHydrationEvent]);

  // Subscribe to IPC events
  useEffect(() => {
    if (!window.orchid?.chat) {
      console.warn('window.orchid.chat not available — IPC not ready');
      return;
    }

    const normalize = <T extends ChatTurnEventAction>(event: Omit<T, 'occurredAt'>): T => ({ ...event, occurredAt: new Date().toISOString() } as T);
    const queueFrameEvent = (event: ChatTurnEventAction) => {
      if (bufferHydrationEvent(event)) return;
      if (!acceptsEvent(event)) return;
      pendingFrameActionsRef.current.push(event);
      scheduleStreamFrame();
    };
    const unsubChunk = window.orchid.chat.onChunk((event: ChatChunkEvent) => queueFrameEvent(normalize(event)));
    const unsubThinking = window.orchid.chat.onThinking?.((event: ChatThinkingEvent) => queueFrameEvent(normalize(event))) ?? (() => {});
    const unsubState = window.orchid.chat.onState((event: ChatStateEvent) => deliverEvent(normalize(event)));
    const unsubDone = window.orchid.chat.onDone((event: ChatDoneEvent) => deliverEvent(normalize(event)));
    const unsubError = window.orchid.chat.onError((event: ChatErrorEvent) => deliverEvent(normalize(event)));
    const unsubUsage = window.orchid.chat.onUsage((event: ChatUsageEvent) => deliverEvent(normalize(event)));
    const unsubToolStart = window.orchid.chat.onToolCallStart?.((event: ChatToolCallStartEvent) => deliverEvent(normalize(event))) ?? (() => {});
    const unsubToolDelta = window.orchid.chat.onToolCallDelta?.((event: ChatToolCallDeltaEvent) => queueFrameEvent(normalize(event))) ?? (() => {});
    const unsubToolUpdate = window.orchid.chat.onToolCallUpdate?.((event: ChatToolCallUpdateEvent) => deliverEvent(normalize(event))) ?? (() => {});
    // Manual /compact runs outside any turn with a synthetic turnId — the
    // rebind flag lets idle compaction progress rebind turn affinity instead
    // of being rejected as a foreign turn.
    const unsubCompactionProgress = window.orchid.chat.onCompactionProgress?.((event: CompactionProgressEvent) => deliverEvent(normalize(event), { rebindTurnWhenIdle: true })) ?? (() => {});

    return () => {
      cancelStreamFrame();
      unsubChunk();
      unsubThinking();
      unsubState();
      unsubDone();
      unsubError();
      unsubUsage();
      unsubToolStart();
      unsubToolDelta();
      unsubToolUpdate();
      unsubCompactionProgress();
    };
  }, [
    cancelStreamFrame,
    deliverEvent,
    acceptsEvent,
    bufferHydrationEvent,
    scheduleStreamFrame,
  ]);

  const send = useCallback(
    async (message: string, options?: ChatSendOptions) => {
      // isSendingRef is synchronous; status alone can be stale across rapid Enter.
      if (!message.trim() || status === 'streaming' || isSendingRef.current) return false;
      // Affinity already rebound but UI still shows previous session — do not send.
      if (isSwitchingSession) return false;
      if (!window.orchid?.chat) {
        dispatchProjection({ type: 'local_error', error: 'Chat IPC not available', status: 'error' });
        return false;
      }

      isSendingRef.current = true;
      const affinity = affinityRef.current.value;
      affinity.streamSessionId = options?.sessionId ?? affinity.selectedSessionId;
      affinity.streamTurnId = null;
      affinity.lastSequence = -1;

      const trimmed = message.trim();
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: MessageRole.USER,
        content: trimmed,
        type: MessageType.TEXT,
        tool_calls: null,
        tool_call_id: null,
        name: null,
        thinking: null,
        timestamp: new Date().toISOString(),
        usage: null,
        hidden: false,
        tool_result: null,
  };

      // On retry after error, the last user message is already in the list —
      // don't append a duplicate bubble (mock Retry action).
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (
          error &&
          last &&
          last.role === MessageRole.USER &&
          last.content === trimmed
        ) {
          return prev;
        }
        return [...prev, userMessage];
      });
      discardStreamFrame();
      dispatchProjection({ type: 'begin', sessionId: affinity.streamSessionId ?? '', startedAt: Date.now() });

      try {
        const result = await window.orchid.chat.send({
          message: trimmed,
          ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.draftGeneration != null
            ? { draftGeneration: options.draftGeneration }
            : {}),
        });
        // Structured gate failures (e.g. unbound workspace) — no stream starts.
        if (result.status === 'error') {
          isSendingRef.current = false;
          // Untrusted-project gates surface as the trust dialog, not a raw
          // error, when the mount point wired a handler.
          if (result.kind === 'untrusted_project' && onUntrustedProjectRef.current) {
            dispatchProjection({ type: 'clear_stream', status: 'idle' });
            setMessages((prev) => dropOptimisticUserMessageIfLast(prev, userMessage.id));
            onUntrustedProjectRef.current();
            return false;
          }
          dispatchProjection({ type: 'clear_stream', status: 'error' });
          dispatchProjection({
            type: 'local_error',
            error: result.error || (result.kind === 'unbound_workspace'
              ? 'No project folder selected. Choose a folder before sending a message.'
              : 'Failed to send message'),
            status: 'error',
          });
          // Drop the optimistic user bubble when send never started.
          setMessages((prev) => dropOptimisticUserMessageIfLast(prev, userMessage.id));
          return false;
        }

        // Only adopt send resolution when the user is still viewing this turn's
        // session (or still in draft). Navigation mid-send must not retarget
        // stream filters to the previous session.
        const stillViewingSendTarget =
          !affinity.selectedSessionId ||
          affinity.selectedSessionId === result.sessionId ||
          affinity.streamSessionId === result.sessionId;
        if (stillViewingSendTarget) {
          affinity.streamSessionId = result.sessionId;
          // Preserve any already-observed sequence for this same turn. Main
          // may emit its first state event before the invoke promise resolves.
          if (affinity.streamTurnId !== result.turnId) {
            affinity.streamTurnId = result.turnId;
            affinity.lastSequence = -1;
          }
        }
        return true;
      } catch (err) {
        // Drop the optimistic user bubble when send never started (throw path).
        isSendingRef.current = false;
        dispatchProjection({ type: 'clear_stream', status: 'error' });
        dispatchProjection({ type: 'local_error', error: err instanceof Error ? err.message : String(err), status: 'error' });
        setMessages((prev) => dropOptimisticUserMessageIfLast(prev, userMessage.id));
        return false;
      }
    },
    [
      status,
      error,
      isSwitchingSession,
      dispatchProjection,
      discardStreamFrame,
    ],
  );

  const cancel = useCallback(async () => {
    if (!window.orchid?.chat) return;
    // Do not cancel the target session while still painting the previous one.
    if (isSwitchingSession) return;
    // One cancel IPC at a time; a second Esc stages the next phase.
    if (beginCancelRequest(cancelQueueRef.current) === 'queued') return;

    // Loop so a staged second Esc runs immediately after the first RTT
    // without requiring another keypress after the guard drops.
    // consumePendingCancel releases inFlight when nothing is staged; do not
    // reset in a finally that races a concurrent cancel() that already began.
    try {
      let runCancelPhase = true;
      while (runCancelPhase) {
        try {
          const affinity = affinityRef.current.value;
          const sessionId = affinity.selectedSessionId ?? affinity.streamSessionId;
          const result = await window.orchid.chat.cancel(
            sessionId ? { sessionId } : undefined,
          );
          const status = result && (result as { status: string }).status;

          // First Esc only shows confirmAgent hint
          if (status === 'confirming') {
            dispatchProjection({
              type: 'interrupt',
              interruptState: 'confirmAgent',
              occurredAt: new Date().toISOString(),
              interrupted: false,
              failActiveTools: false,
            });
          } else if (status === 'confirming_subagents') {
            // Second Esc cancels the agent. Main process emits CHAT_DONE with
            // interrupted=true (partial content, no suffix). Stay in subagent phase
            // if applicable; mark in-flight tool blocks as failed.
            // Don't set status='idle' here — let onDone handle finalization to
            // avoid double-committing segments. interruptState is confirmSubagents
            // here and from onState; onDone must not reset it to idle (P1-34).
            flushStreamFrame();
            dispatchProjection({
              type: 'interrupt',
              interruptState: 'confirmSubagents',
              occurredAt: new Date().toISOString(),
              interrupted: true,
              failActiveTools: true,
            });
          } else if (status === 'cancelled') {
            // Third Esc (or full cancel with no subagents)
            isSendingRef.current = false;
            // Keep same-tick tool argument deltas before marking their tools terminal.
            flushStreamFrame();
            dispatchProjection({
              type: 'interrupt',
              interruptState: 'idle',
              status: 'idle',
              occurredAt: new Date().toISOString(),
              interrupted: true,
              failActiveTools: true,
            });
            dispatchProjection({ type: 'clear_stream', status: 'idle' });
          }
        } catch {
          // Ignore cancel errors — still release / drain the queue below.
        }

        runCancelPhase = consumePendingCancel(cancelQueueRef.current);
      }
    } catch {
      // Unexpected throw outside the per-IPC try — never leave the mutex stuck.
      resetCancelQueue(cancelQueueRef.current);
    }
  }, [dispatchProjection, flushStreamFrame, isSwitchingSession]);

  const stop = useCallback(async (sessionId: string) => {
    if (!window.orchid?.chat?.stop) return;
    try {
      await window.orchid.chat.stop({ sessionId });
    } catch {
      // Activity pushes remain authoritative; a transient IPC failure should
      // not modify whichever session is currently visible.
    }
  }, []);

  /**
   * Replace messages (session load / new session) and drop all live/stale UI
   * state so nothing from the previous session remains (tools, stream, etc.).
   * Restores context usage from the newest message that carries usage so the
   * sidebar Context panel and footer radial reflect the loaded session.
   */
  const replaceMessages = useCallback((next: Message[]) => {
    discardStreamFrame();
    setMessages(next);
    dispatchProjection({ type: 'reset' });
    isSendingRef.current = false;
    resetCancelQueue(cancelQueueRef.current);
    affinityRef.current.value.streamTurnId = null;
    affinityRef.current.value.lastSequence = -1;
    setIsSwitchingSession(false);
  }, [discardStreamFrame, dispatchProjection]);

  const beginSessionSwitch = useCallback((sessionId: string | null) => {
    const controller = affinityRef.current;
    const affinity = controller.value;
    bindChatSession(affinity, sessionId);
    controller.activeSessionId = sessionId;
    hydrationRef.current = sessionId ? { sessionId, events: [] } : null;
    // Do not clear messages/tools/usage here — keep painting the previous
    // session until hydrate/replaceMessages commits the next view in one shot.
    isSendingRef.current = false;
    resetCancelQueue(cancelQueueRef.current);
    setIsSwitchingSession(true);
  }, []);

  const getSnapshot = useCallback(async (
    sessionId: string,
  ): Promise<ChatSessionSnapshot | null> => {
    if (!window.orchid?.chat?.snapshot) return null;
    try {
      return await window.orchid.chat.snapshot({ sessionId });
    } catch {
      return null;
    }
  }, []);

  const replayHydrationBuffer = useCallback((buffered: BufferedProjectionEvent[]) => {
    let batch: ChatTurnEventAction[] = [];
    const flushBatch = () => {
      if (batch.length === 0) return;
      dispatchProjection({ type: 'events', actions: batch });
      batch = [];
    };
    for (const { event } of buffered) {
      if (!acceptsEvent(event)) continue;
      if (isProjectionLifecycleEvent(event)) {
        flushBatch();
        applyLiveEvent(event);
      } else {
        batch.push(event);
      }
    }
    flushBatch();
  }, [acceptsEvent, applyLiveEvent, dispatchProjection]);

  const hydrateSnapshot = useCallback((snapshot: ChatSessionSnapshot | null) => {
    const hydration = hydrationRef.current;
    if (!snapshot) {
      hydrationRef.current = null;
      // Snapshot IPC failed after navigation. Keep the loaded history and let
      // target-session events observed during the request advance the view —
      // still sequence-affinity gated so a previous generation cannot land.
      setIsSwitchingSession(false);
      replayHydrationBuffer(hydration?.events ?? []);
      return;
    }
    if (snapshot.sessionId !== affinityRef.current.value.selectedSessionId) {
      // Affinity moved again; drop buffer without stranding the switch flag.
      hydrationRef.current = null;
      setIsSwitchingSession(false);
      return;
    }
    hydrationRef.current = null;
    const bufferedEvents =
      hydration?.sessionId === snapshot.sessionId ? hydration.events : [];

    replaceMessages(snapshot.messages);
    const live: ChatSnapshot | null = snapshot.live;
    if (!live) {
      // No live actor: history is the base. Drain only events that pass
      // sequence affinity for the selected session so stale turn/sequence
      // leftovers from a prior generation are discarded (not blindly applied).
      replayHydrationBuffer(bufferedEvents);
      // Restore error from the last FAILED chain so the banner persists
      // across session switches and restarts.
      if (snapshot.lastChainError) {
        const errorText = snapshot.lastChainError.title && !snapshot.lastChainError.detail.startsWith(snapshot.lastChainError.title)
          ? `${snapshot.lastChainError.title}: ${snapshot.lastChainError.detail}`
          : snapshot.lastChainError.detail;
        dispatchProjection({ type: 'local_error', error: errorText, status: 'error' });
      }
      return;
    }

    seedAffinityFromLive(affinityRef.current.value, live);
    dispatchProjection({ type: 'seed', snapshot: live });
    const isLive = live.state === 'streaming';
    isSendingRef.current = isLive;

    // Snapshot is the sequence high-water mark; drain only newer events.
    replayHydrationBuffer(bufferedEvents);
  }, [dispatchProjection, replaceMessages, replayHydrationBuffer]);

  const clearError = useCallback(() => {
    dispatchProjection({ type: 'clear_error' });
  }, [dispatchProjection]);

  const resetLiveTail = useCallback(() => {
    // Flush queued deltas first so the sequence watermark covers them and a
    // late replay cannot re-append pre-compaction content after the reset.
    flushStreamFrame();
    dispatchProjection({ type: 'reset_tail' });
  }, [dispatchProjection, flushStreamFrame]);

  return {
    messages,
    status,
    streamingContent,
    streamingThinking,
    toolBlocks,
    streamSegments,
    streamRevision: projectionState.revision,
    error,
    usage,
    currentTurnUsage,
    cumulativeUsage,
    streamStartTime,
    interruptState,
    interrupted,
    cwd,
    compactionProgress,
    send,
    cancel,
    stop,
    getSnapshot,
    beginSessionSwitch,
    hydrateSnapshot,
    clearError,
    resetLiveTail,
    setMessages: replaceMessages,
    isSwitchingSession,
  };
}
