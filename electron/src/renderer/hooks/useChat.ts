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
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
} from '../../shared/types/ipc';
import {
  addUsage,
  hasUsage,
  latestUsageFromMessages,
  sumMessageUsages,
} from '../../shared/usage';
import type { CanonicalToolResult } from '../../shared/types/tool-result';

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
}

/** Preserve canonical facts while adapting a main-process live snapshot. */
export function chatToolSnapshotToBlock(tool: ChatToolCallSnapshot): ToolBlock {
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
  };
}

/**
 * Chronological segments for the in-flight turn.
 * Preserves call order: tool → text → tool → text → …
 */
export type StreamSegment =
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'text'; id: string; content: string }
  | { kind: 'thinking'; id: string; content: string };

/** Append one canonical text/thinking delta without inventing renderer-local identity. */
export function appendStreamSegmentDelta(
  segments: readonly StreamSegment[],
  kind: 'text' | 'thinking',
  segmentId: string,
  data: string,
): StreamSegment[] {
  const last = segments.at(-1);
  if (last?.kind === kind && last.id === segmentId) {
    return [
      ...segments.slice(0, -1),
      { ...last, content: last.content + data },
    ];
  }
  return [...segments, { kind, id: segmentId, content: data }];
}

/** Buffered text/thinking delta data awaiting renderer-frame publication. */
export interface StreamSegmentDelta {
  kind: 'text' | 'thinking';
  segmentId: string;
  data: string;
}

/**
 * Apply one renderer frame of text/thinking deltas with a single array copy.
 * Existing segment objects remain immutable while a frame-local tail may be
 * extended in place before the new snapshot is published to React.
 */
export function appendStreamSegmentDeltas(
  segments: readonly StreamSegment[],
  deltas: readonly StreamSegmentDelta[],
): StreamSegment[] {
  if (deltas.length === 0) return segments.slice();

  const next = segments.slice();
  let mutableTailIndex = -1;
  for (const delta of deltas) {
    const tailIndex = next.length - 1;
    const tail = next[tailIndex];
    if (
      tail?.kind === delta.kind &&
      tail.id === delta.segmentId
    ) {
      if (mutableTailIndex !== tailIndex) {
        next[tailIndex] = { ...tail };
        mutableTailIndex = tailIndex;
      }
      const mutableTail = next[tailIndex];
      if (mutableTail.kind === 'text' || mutableTail.kind === 'thinking') {
        mutableTail.content += delta.data;
      }
      continue;
    }
    next.push({
      kind: delta.kind,
      id: delta.segmentId,
      content: delta.data,
    });
    mutableTailIndex = next.length - 1;
  }
  return next;
}

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
}

export interface ChatSendOptions {
  /** Preferred model when main lazy-creates a session from draft mode. */
  model?: ModelSelection;
  /** Explicit session owner; omitted only while composing an unsaved draft. */
  sessionId?: string;
  /** Current draft navigation generation, echoed with lazy SESSION_CREATED. */
  draftGeneration?: number;
}

export interface UseChatReturn extends ChatState {
  /** Send a message to the chat. */
  send: (message: string, options?: ChatSendOptions) => Promise<void>;
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
): boolean {
  if (affinity.selectedSessionId && event.sessionId !== affinity.selectedSessionId) return false;
  if (!affinity.selectedSessionId && affinity.streamSessionId && event.sessionId !== affinity.streamSessionId) return false;
  if (!affinity.selectedSessionId && !affinity.streamSessionId) {
    if (!isSending) return false;
    affinity.streamSessionId = event.sessionId;
  }
  if (affinity.streamTurnId && affinity.streamTurnId !== event.turnId) return false;
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

/** Prefer a live turn snapshot, but keep persisted usage for idle sessions. */
export function resolveHydratedUsage(
  messages: readonly Message[],
  liveUsage: Usage | null | undefined,
): Usage | null {
  return liveUsage && hasUsage(liveUsage)
    ? liveUsage
    : latestUsageFromMessages(messages);
}

/** Add the authoritative in-flight turn snapshot to persisted session usage. */
export function cumulativeUsageFromMessages(
  messages: readonly Message[],
  currentTurnUsage: Usage | null = null,
): Usage {
  return addUsage(sumMessageUsages(messages), currentTurnUsage);
}

/** Cache persisted totals independently from high-frequency live-turn usage. */
export function useCumulativeUsage(
  messages: readonly Message[],
  currentTurnUsage: Usage | null,
): Usage {
  const persistedUsage = useMemo(
    () => sumMessageUsages(messages),
    [messages],
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

export type BufferedHydrationEvent = {
  event: { sessionId: string; turnId: string; sequence: number };
  apply: () => void;
};

/**
 * Replay buffered hydration applies through the same sequence-affinity gate
 * used by live IPC delivery. Mutates affinity as each event is accepted so
 * stale sequences / wrong-session / wrong-turn events are discarded.
 */
export function drainBufferedHydrationEvents(
  affinity: ChatEventAffinity,
  events: ReadonlyArray<BufferedHydrationEvent>,
  isSending: boolean,
): number {
  let applied = 0;
  for (const item of events) {
    if (!acceptChatEvent(affinity, item.event, isSending)) continue;
    item.apply();
    applied += 1;
  }
  return applied;
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

// ── Send failure residual cleanup ────────────────────────────────────────────

/**
 * Residual stream fields after a pre-stream send failure (structured error or
 * throw). Shared so every failure path leaves the composer ready to send again.
 */
export type ResidualStreamAfterSendFailure = {
  isSending: false;
  status: 'error';
  streamStartTime: null;
  streamingContent: '';
  streamingThinking: '';
  accumulatedContent: '';
  accumulatedThinking: '';
};

export function residualStateAfterSendFailure(): ResidualStreamAfterSendFailure {
  return {
    isSending: false,
    status: 'error',
    streamStartTime: null,
    streamingContent: '',
    streamingThinking: '',
    accumulatedContent: '',
    accumulatedThinking: '',
  };
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

export function useChat(activeSessionId: string | null = null): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [toolBlocks, setToolBlocks] = useState<ToolBlock[]>([]);
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const [streamRevision, setStreamRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Live stream usage; also rehydrated from the last message with usage
  // when replacing messages (session switch / load).
  const [usage, setUsage] = useState<Usage | null>(null);
  const [currentTurnUsage, setCurrentTurnUsage] = useState<Usage | null>(null);
  const [streamStartTime, setStreamStartTime] = useState<number | null>(null);
  const [interruptState, setInterruptState] = useState<InterruptState>('idle');
  const [interrupted, setInterrupted] = useState(false);
  const [cwd, setCwd] = useState('');
  /** Affinity rebound but messages not yet replaced — hold previous UI. */
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);

  // Persisted session totals plus the authoritative in-flight turn snapshot.
  const cumulativeUsage = useCumulativeUsage(messages, currentTurnUsage);

  const accumulatedContentRef = useRef('');
  const accumulatedThinkingRef = useRef('');
  const usageRef = useRef<Usage | null>(null);
  const toolBlocksRef = useRef<ToolBlock[]>([]);
  const streamSegmentsRef = useRef<StreamSegment[]>([]);
  const pendingContentChunksRef = useRef<string[]>([]);
  const pendingThinkingChunksRef = useRef<string[]>([]);
  const pendingStreamDeltasRef = useRef<StreamSegmentDelta[]>([]);
  const streamFrameIdRef = useRef<number | null>(null);
  /** Sync guard against double-send before status re-render (P1-35). */
  const isSendingRef = useRef(false);
  /**
   * Serialize staged Esc/cancel so overlapping IPC cannot race phases.
   * A second Esc while in-flight is staged via `pending` and runs after RTT.
   */
  const cancelQueueRef = useRef<CancelQueueState>({ inFlight: false, pending: false });
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  const streamSessionIdRef = useRef<string | null>(activeSessionId);
  const streamTurnIdRef = useRef<string | null>(null);
  const lastSequenceRef = useRef(-1);
  const priorActiveSessionIdRef = useRef<string | null>(activeSessionId);
  const hydrationRef = useRef<{
    sessionId: string;
    events: BufferedHydrationEvent[];
  } | null>(null);

  useEffect(() => {
    // During gate-until-ready switch, beginSessionSwitch owns affinity.
    // Do not clobber refs back to the still-painted previous activeSessionId.
    if (isSwitchingSession) return;
    const switchedSession = priorActiveSessionIdRef.current !== activeSessionId;
    const streamAlreadyBelongsToSelection =
      streamSessionIdRef.current === activeSessionId;
    activeSessionIdRef.current = activeSessionId;
    streamSessionIdRef.current = activeSessionId;
    if (switchedSession && !streamAlreadyBelongsToSelection) {
      streamTurnIdRef.current = null;
      lastSequenceRef.current = -1;
    }
    priorActiveSessionIdRef.current = activeSessionId;
  }, [activeSessionId, isSwitchingSession]);

  const acceptsEvent = useCallback((event: {
    sessionId: string;
    turnId: string;
    sequence: number;
  }): boolean => {
    const affinity: ChatEventAffinity = {
      selectedSessionId: activeSessionIdRef.current,
      streamSessionId: streamSessionIdRef.current,
      streamTurnId: streamTurnIdRef.current,
      lastSequence: lastSequenceRef.current,
    };
    const accepted = acceptChatEvent(affinity, event, isSendingRef.current);
    streamSessionIdRef.current = affinity.streamSessionId;
    streamTurnIdRef.current = affinity.streamTurnId;
    lastSequenceRef.current = affinity.lastSequence;
    return accepted;
  }, []);

  const deliverEvent = useCallback((
    event: { sessionId: string; turnId: string; sequence: number },
    apply: () => void,
  ) => {
    const hydration = hydrationRef.current;
    if (shouldBufferChatEvent(hydration?.sessionId ?? null, event)) {
      hydration?.events.push({ event, apply });
      return;
    }
    if (!acceptsEvent(event)) return;
    apply();
  }, [acceptsEvent]);

  const flushPendingStreamData = useCallback((): boolean => {
    const hadPendingData =
      pendingContentChunksRef.current.length > 0 ||
      pendingThinkingChunksRef.current.length > 0 ||
      pendingStreamDeltasRef.current.length > 0;
    if (pendingContentChunksRef.current.length > 0) {
      accumulatedContentRef.current += pendingContentChunksRef.current.join('');
      pendingContentChunksRef.current = [];
    }
    if (pendingThinkingChunksRef.current.length > 0) {
      accumulatedThinkingRef.current += pendingThinkingChunksRef.current.join('');
      pendingThinkingChunksRef.current = [];
    }
    if (pendingStreamDeltasRef.current.length > 0) {
      streamSegmentsRef.current = appendStreamSegmentDeltas(
        streamSegmentsRef.current,
        pendingStreamDeltasRef.current,
      );
      pendingStreamDeltasRef.current = [];
    }
    return hadPendingData;
  }, []);

  const cancelStreamFrame = useCallback(() => {
    if (streamFrameIdRef.current == null) return;
    window.cancelAnimationFrame(streamFrameIdRef.current);
    streamFrameIdRef.current = null;
  }, []);

  const publishBufferedStream = useCallback(() => {
    streamFrameIdRef.current = null;
    flushPendingStreamData();
    setStreamingContent(accumulatedContentRef.current);
    setStreamingThinking(accumulatedThinkingRef.current);
    setStreamSegments(streamSegmentsRef.current);
    setStreamRevision((revision) => revision + 1);
  }, [flushPendingStreamData]);

  const scheduleStreamFrame = useCallback(() => {
    if (streamFrameIdRef.current != null) return;
    streamFrameIdRef.current = window.requestAnimationFrame(publishBufferedStream);
  }, [publishBufferedStream]);

  const flushStreamFrame = useCallback((publish: boolean) => {
    cancelStreamFrame();
    const hadPendingData = flushPendingStreamData();
    if (!publish || !hadPendingData) return;
    setStreamingContent(accumulatedContentRef.current);
    setStreamingThinking(accumulatedThinkingRef.current);
    setStreamSegments(streamSegmentsRef.current);
    setStreamRevision((revision) => revision + 1);
  }, [cancelStreamFrame, flushPendingStreamData]);

  const discardStreamFrame = useCallback(() => {
    cancelStreamFrame();
    pendingContentChunksRef.current = [];
    pendingThinkingChunksRef.current = [];
    pendingStreamDeltasRef.current = [];
  }, [cancelStreamFrame]);

  /**
   * Update toolBlocksRef synchronously, then mirror into React state.
   * onDone commits from the ref; useEffect/setState-updater-only sync races
   * CHAT_DONE in the same tick as the last tool event (P1-33).
   */
  const applyToolBlocks = useCallback(
    (updater: ToolBlock[] | ((prev: ToolBlock[]) => ToolBlock[])) => {
      const prev = toolBlocksRef.current;
      const next = typeof updater === 'function' ? updater(prev) : updater;
      toolBlocksRef.current = next;
      setToolBlocks(next);
      setStreamRevision((revision) => revision + 1);
    },
    [],
  );

  /**
   * Update streamSegmentsRef synchronously, then mirror into React state.
   * Mirrors applyToolBlocks so onDone never reads a stale segment timeline.
   */
  const applyStreamSegments = useCallback(
    (updater: StreamSegment[] | ((prev: StreamSegment[]) => StreamSegment[])) => {
      flushStreamFrame(true);
      const prev = streamSegmentsRef.current;
      const next = typeof updater === 'function' ? updater(prev) : updater;
      streamSegmentsRef.current = next;
      setStreamSegments(next);
      setStreamRevision((revision) => revision + 1);
    },
    [flushStreamFrame],
  );

  // Subscribe to IPC events
  useEffect(() => {
    if (!window.orchid?.chat) {
      console.warn('window.orchid.chat not available — IPC not ready');
      return;
    }

    const unsubChunk = window.orchid.chat.onChunk((event: ChatChunkEvent) => {
      deliverEvent(event, () => {
        pendingContentChunksRef.current.push(event.data);
        pendingStreamDeltasRef.current.push({
          kind: 'text',
          segmentId: event.segmentId,
          data: event.data,
        });
        scheduleStreamFrame();
      });
    });

    const unsubThinking =
      window.orchid.chat.onThinking?.((event: ChatThinkingEvent) => {
        deliverEvent(event, () => {
          pendingThinkingChunksRef.current.push(event.data);
          pendingStreamDeltasRef.current.push({
            kind: 'thinking',
            segmentId: event.segmentId,
            data: event.data,
          });
          scheduleStreamFrame();
        });
      }) ?? (() => {});

    const unsubState = window.orchid.chat.onState((event: ChatStateEvent) => {
      deliverEvent(event, () => {
        if (event.state === 'streaming') {
          setStatus('streaming');
        } else if (event.state === 'error') {
          setStatus('error');
          setError(event.error);
        } else if (event.state === 'idle') {
          setStatus('idle');
          // Stream finished from main — allow another send
          isSendingRef.current = false;
        }
        // Track interrupt confirmation phase from main process (authoritative for
        // confirmAgent / confirmSubagents; do not let onDone clobber this).
        if (event.interruptState) {
          setInterruptState(event.interruptState);
        }
        // Track working directory from main process
        if (event.cwd) {
          setCwd(event.cwd);
        }
      });
    });

    const unsubDone = window.orchid.chat.onDone((event: ChatDoneEvent) => {
      deliverEvent(event, () => {
      flushStreamFrame(false);
      if (event.usage) {
        setUsage(event.usage);
        usageRef.current = event.usage;
      }
      setCurrentTurnUsage(null);

      // toolBlocksRef / streamSegmentsRef are updated synchronously with state
      // so a CHAT_DONE right after the last tool event still sees final tools.
      const liveTools = toolBlocksRef.current;
      const segments = streamSegmentsRef.current;
      const usageForCommit = event.usage ?? usageRef.current;

      // Build commit messages in chronological segment order (tool → text → …).
      // Fall back to tools-then-response only when no segments were recorded.
      const committed = commitSegmentsToMessages({
        segments,
        liveTools,
        fallbackResponse: event.response ?? accumulatedContentRef.current,
        interrupted: Boolean(event.interrupted),
        usage: usageForCommit,
        thinking: accumulatedThinkingRef.current || null,
      });

      if (committed.length > 0) {
        setMessages((prev) => {
          const liveIds = new Set(liveTools.map((b) => b.id));
          // Drop any in-flight tool msgs already present (reload / double-done races)
          const next = prev.filter(
            (m) =>
              !(
                (m.type === MessageType.TOOL_CALL || m.type === MessageType.TOOL_RESULT) &&
                m.tool_call_id &&
                liveIds.has(m.tool_call_id)
              ),
          );

          // Avoid double-append of identical trailing assistant text
          const lastCommitted = committed[committed.length - 1];
          const lastPrev = next[next.length - 1];
          if (
            lastCommitted &&
            lastPrev &&
            lastCommitted.role === MessageRole.ASSISTANT &&
            lastPrev.role === MessageRole.ASSISTANT &&
            lastCommitted.type === MessageType.TEXT &&
            lastPrev.type === MessageType.TEXT &&
            lastCommitted.content === lastPrev.content
          ) {
            const withoutDupAssistant = committed.slice(0, -1);
            if (withoutDupAssistant.length === 0) return next;
            return [...next, ...withoutDupAssistant];
          }

          return [...next, ...committed];
        });
      }

      if (event.interrupted) {
        setInterrupted(true);
      }

      setStreamingContent('');
      setStreamingThinking('');
      applyStreamSegments([]);
      // Keep toolBlocks until next send so the last turn still renders them live;
      // messages now also contain them for multi-turn history.
      accumulatedContentRef.current = '';
      accumulatedThinkingRef.current = '';
      // P1-34: second Esc sends CHAT_DONE then CHAT_STATE(confirmSubagents).
      // Never force interruptState idle on interrupted done — onState owns it.
      if (!event.interrupted) {
        setInterruptState('idle');
      }
      isSendingRef.current = false;
      setStatus('idle');
      });
    });

    const unsubError = window.orchid.chat.onError((event: ChatErrorEvent) => {
      deliverEvent(event, () => {
      flushStreamFrame(false);
      // Prefer title + detail for banner classification when available
      const display =
        event.title && event.error && !event.error.startsWith(event.title)
          ? `${event.title}: ${event.error}`
          : event.error;
      setError(display);

      // Commit live tools/segments into flat messages so multi-chain UI length
      // stays aligned with session chain.messages after FAILED persist.
      const liveTools = toolBlocksRef.current;
      const usageForCommit = usageRef.current;
      const committed = commitSegmentsToMessages({
        segments: streamSegmentsRef.current,
        liveTools,
        fallbackResponse: accumulatedContentRef.current,
        interrupted: false,
        usage: usageForCommit,
        thinking: accumulatedThinkingRef.current || null,
      });
      if (committed.length > 0) {
        setMessages((prev) => {
          const liveIds = new Set(liveTools.map((b) => b.id));
          const next = prev.filter(
            (m) =>
              !(
                (m.type === MessageType.TOOL_CALL || m.type === MessageType.TOOL_RESULT) &&
                m.tool_call_id &&
                liveIds.has(m.tool_call_id)
              ),
          );
          return [...next, ...committed];
        });
      }

      setStatus('idle');
      isSendingRef.current = false;
      setCurrentTurnUsage(null);
      setStreamingContent('');
      setStreamingThinking('');
      applyStreamSegments([]);
      setInterruptState('idle');
      accumulatedContentRef.current = '';
      accumulatedThinkingRef.current = '';
      });
    });

    const unsubUsage = window.orchid.chat.onUsage((event: ChatUsageEvent) => {
      deliverEvent(event, () => {
        setUsage(event.usage);
        usageRef.current = event.usage;
        setCurrentTurnUsage(event.usage);
      });
    });

    const unsubToolStart = window.orchid.chat.onToolCallStart?.((event: ChatToolCallStartEvent) => {
      deliverEvent(event, () => {
      applyToolBlocks((prev) => upsertToolBlock(prev, {
        id: event.toolCallId,
        toolName: event.toolName,
        status: 'generating',
        partialArgs: '',
        args: '',
        agentProjection: null,
        toolResult: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      }));
      // Record tool position in the chronological segment timeline.
      applyStreamSegments((prev) => {
        if (prev.some((s) => s.kind === 'tool' && s.toolCallId === event.toolCallId)) {
          return prev;
        }
        return [
          ...prev,
          { kind: 'tool', toolCallId: event.toolCallId },
        ];
      });
      });
    }) ?? (() => {});

    const unsubToolDelta = window.orchid.chat.onToolCallDelta?.((event: ChatToolCallDeltaEvent) => {
      deliverEvent(event, () => {
      applyToolBlocks((prev) => prev.map((block) => {
        if (block.id !== event.toolCallId) return block;
        return {
          ...block,
          partialArgs: block.partialArgs + event.argsDelta,
          status: block.status !== 'generating' && block.status !== 'running'
            ? block.status
            : 'generating',
        };
      }));
      });
    }) ?? (() => {});

    const unsubToolUpdate = window.orchid.chat.onToolCallUpdate?.((event: ChatToolCallUpdateEvent) => {
      deliverEvent(event, () => {
      applyToolBlocks((prev) => upsertToolBlock(prev, {
        id: event.toolCallId,
        toolName: event.toolName ?? 'unknown',
        status: event.status === 'running'
          ? 'running'
          : event.status,
        partialArgs: '',
        args: event.args ?? '',
        agentProjection: event.content ?? null,
        toolResult: event.toolResult ?? null,
        startedAt: new Date().toISOString(),
        finishedAt: event.status === 'running' ? null : new Date().toISOString(),
      }, true));
      // Ensure tools that skip start events still appear in order.
      applyStreamSegments((prev) => {
        if (prev.some((s) => s.kind === 'tool' && s.toolCallId === event.toolCallId)) {
          return prev;
        }
        return [
          ...prev,
          { kind: 'tool', toolCallId: event.toolCallId },
        ];
      });
      });
    }) ?? (() => {});

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
    };
  }, [
    applyToolBlocks,
    applyStreamSegments,
    cancelStreamFrame,
    deliverEvent,
    flushStreamFrame,
    scheduleStreamFrame,
  ]);

  const send = useCallback(
    async (message: string, options?: ChatSendOptions) => {
      // isSendingRef is synchronous; status alone can be stale across rapid Enter.
      if (!message.trim() || status === 'streaming' || isSendingRef.current) return;
      // Affinity already rebound but UI still shows previous session — do not send.
      if (isSwitchingSession) return;
      if (!window.orchid?.chat) {
        setError('Chat IPC not available');
        return;
      }

      isSendingRef.current = true;
      streamSessionIdRef.current = options?.sessionId ?? activeSessionIdRef.current;
      streamTurnIdRef.current = null;
      lastSequenceRef.current = -1;

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
      setError(null);
      setStreamingContent('');
      setStreamingThinking('');
      applyToolBlocks([]);
      applyStreamSegments([]);
      setInterrupted(false);
      // Keep the last completed snapshot visible while this turn streams, but
      // do not let it attach to the new assistant message if no usage arrives.
      usageRef.current = null;
      setCurrentTurnUsage(null);
      setStreamStartTime(Date.now());
      setInterruptState('idle');
      accumulatedContentRef.current = '';
      accumulatedThinkingRef.current = '';
      setStatus('streaming');

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
          const residual = residualStateAfterSendFailure();
          isSendingRef.current = residual.isSending;
          setError(
            result.error ||
              (result.kind === 'unbound_workspace'
                ? 'No project folder selected. Choose a folder before sending a message.'
                : 'Failed to send message'),
          );
          setStatus(residual.status);
          // Drop the optimistic user bubble when send never started.
          setMessages((prev) => dropOptimisticUserMessageIfLast(prev, userMessage.id));
          setStreamStartTime(residual.streamStartTime);
          setStreamingContent(residual.streamingContent);
          setStreamingThinking(residual.streamingThinking);
          applyToolBlocks([]);
          applyStreamSegments([]);
          accumulatedContentRef.current = residual.accumulatedContent;
          accumulatedThinkingRef.current = residual.accumulatedThinking;
          return;
        }

        // Only adopt send resolution when the user is still viewing this turn's
        // session (or still in draft). Navigation mid-send must not retarget
        // stream filters to the previous session.
        const stillViewingSendTarget =
          !activeSessionIdRef.current ||
          activeSessionIdRef.current === result.sessionId ||
          streamSessionIdRef.current === result.sessionId;
        if (stillViewingSendTarget) {
          streamSessionIdRef.current = result.sessionId;
          // Preserve any already-observed sequence for this same turn. Main
          // may emit its first state event before the invoke promise resolves.
          if (streamTurnIdRef.current !== result.turnId) {
            streamTurnIdRef.current = result.turnId;
            lastSequenceRef.current = -1;
          }
        }
      } catch (err) {
        // Drop the optimistic user bubble when send never started (throw path).
        const residual = residualStateAfterSendFailure();
        isSendingRef.current = residual.isSending;
        setError(err instanceof Error ? err.message : String(err));
        setStatus(residual.status);
        setMessages((prev) => dropOptimisticUserMessageIfLast(prev, userMessage.id));
        setStreamStartTime(residual.streamStartTime);
        setStreamingContent(residual.streamingContent);
        setStreamingThinking(residual.streamingThinking);
        applyToolBlocks([]);
        applyStreamSegments([]);
        accumulatedContentRef.current = residual.accumulatedContent;
        accumulatedThinkingRef.current = residual.accumulatedThinking;
      }
    },
    [
      status,
      error,
      isSwitchingSession,
      applyToolBlocks,
      applyStreamSegments,
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
          const sessionId = activeSessionIdRef.current ?? streamSessionIdRef.current;
          const result = await window.orchid.chat.cancel(
            sessionId ? { sessionId } : undefined,
          );
          const status = result && (result as { status: string }).status;

          // First Esc only shows confirmAgent hint
          if (status === 'confirming') {
            setInterruptState('confirmAgent');
          } else if (status === 'confirming_subagents') {
            // Second Esc cancels the agent. Main process emits CHAT_DONE with
            // interrupted=true (partial content, no suffix). Stay in subagent phase
            // if applicable; mark in-flight tool blocks as failed.
            // Don't set status='idle' here — let onDone handle finalization to
            // avoid double-committing segments. interruptState is confirmSubagents
            // here and from onState; onDone must not reset it to idle (P1-34).
            setInterruptState('confirmSubagents');
            setInterrupted(true);
            applyToolBlocks((prev) =>
              prev.map((block) =>
                block.status === 'generating' || block.status === 'running'
                  ? {
                      ...block,
                      status: 'failed' as const,
                      error: 'Interrupted by user',
                      finishedAt: new Date().toISOString(),
                    }
                  : block,
              ),
            );
          } else if (status === 'cancelled') {
            // Third Esc (or full cancel with no subagents)
            setInterruptState('idle');
            setInterrupted(true);
            isSendingRef.current = false;
            applyToolBlocks((prev) =>
              prev.map((block) =>
                block.status === 'generating' || block.status === 'running'
                  ? {
                      ...block,
                      status: 'failed' as const,
                      error: 'Interrupted by user',
                      finishedAt: new Date().toISOString(),
                    }
                  : block,
              ),
            );
            discardStreamFrame();
            setStreamingContent('');
            setStreamingThinking('');
            accumulatedContentRef.current = '';
            accumulatedThinkingRef.current = '';
            setStatus('idle');
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
  }, [applyToolBlocks, discardStreamFrame, isSwitchingSession]);

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
    applyToolBlocks([]);
    applyStreamSegments([]);
    setStreamingContent('');
    setStreamingThinking('');
    setError(null);
    setInterrupted(false);
    setInterruptState('idle');
    isSendingRef.current = false;
    resetCancelQueue(cancelQueueRef.current);
    setStatus('idle');
    // Rehydrate last-turn context usage from persisted messages; empty/new
    // sessions correctly get null → 0% context until the next stream.
    const restored = latestUsageFromMessages(next);
    setUsage(restored);
    usageRef.current = restored;
    setCurrentTurnUsage(null);
    setStreamStartTime(null);
    accumulatedContentRef.current = '';
    accumulatedThinkingRef.current = '';
    streamTurnIdRef.current = null;
    lastSequenceRef.current = -1;
    setIsSwitchingSession(false);
  }, [applyToolBlocks, applyStreamSegments, discardStreamFrame]);

  const beginSessionSwitch = useCallback((sessionId: string | null) => {
    const affinity: ChatEventAffinity = {
      selectedSessionId: activeSessionIdRef.current,
      streamSessionId: streamSessionIdRef.current,
      streamTurnId: streamTurnIdRef.current,
      lastSequence: lastSequenceRef.current,
    };
    bindChatSession(affinity, sessionId);
    activeSessionIdRef.current = affinity.selectedSessionId;
    streamSessionIdRef.current = affinity.streamSessionId;
    streamTurnIdRef.current = affinity.streamTurnId;
    lastSequenceRef.current = affinity.lastSequence;
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

  const replayHydrationBuffer = useCallback((
    buffered: BufferedHydrationEvent[],
    seedLive: Pick<ChatSnapshot, 'sessionId' | 'turnId' | 'sequence'> | null,
  ) => {
    const affinity: ChatEventAffinity = {
      selectedSessionId: activeSessionIdRef.current,
      streamSessionId: streamSessionIdRef.current,
      streamTurnId: streamTurnIdRef.current,
      lastSequence: lastSequenceRef.current,
    };
    if (seedLive) {
      seedAffinityFromLive(affinity, seedLive);
    }
    drainBufferedHydrationEvents(affinity, buffered, isSendingRef.current);
    streamSessionIdRef.current = affinity.streamSessionId;
    streamTurnIdRef.current = affinity.streamTurnId;
    lastSequenceRef.current = affinity.lastSequence;
  }, []);

  const hydrateSnapshot = useCallback((snapshot: ChatSessionSnapshot | null) => {
    const hydration = hydrationRef.current;
    if (!snapshot) {
      hydrationRef.current = null;
      // Snapshot IPC failed after navigation. Keep the loaded history and let
      // target-session events observed during the request advance the view —
      // still sequence-affinity gated so a previous generation cannot land.
      setIsSwitchingSession(false);
      replayHydrationBuffer(hydration?.events ?? [], null);
      return;
    }
    if (snapshot.sessionId !== activeSessionIdRef.current) {
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
      replayHydrationBuffer(bufferedEvents, null);
      return;
    }

    streamSessionIdRef.current = live.sessionId;
    streamTurnIdRef.current = live.turnId;
    lastSequenceRef.current = live.sequence;
    const liveTools: ToolBlock[] = live.toolCalls.map(chatToolSnapshotToBlock);
    applyToolBlocks(liveTools);
    applyStreamSegments(live.streamSegments.map((segment) => ({ ...segment })));
    accumulatedContentRef.current = live.response;
    accumulatedThinkingRef.current = live.thinking;
    setStreamingContent(live.response);
    setStreamingThinking(live.thinking);
    const hydratedUsage = resolveHydratedUsage(snapshot.messages, live.usage);
    setUsage(hydratedUsage);
    usageRef.current = hydratedUsage;
    setCurrentTurnUsage(
      live.state === 'streaming' && live.usage && hasUsage(live.usage)
        ? live.usage
        : null,
    );
    setError(live.error);
    setInterruptState(live.interruptState);
    setInterrupted(live.interrupted);
    setCwd(live.cwd ?? '');
    const isLive = live.state === 'streaming';
    isSendingRef.current = isLive;
    setStatus(live.state);
    setStreamStartTime(isLive ? live.startedAt ?? Date.now() : null);

    // Snapshot is the sequence high-water mark; drain only newer events.
    replayHydrationBuffer(bufferedEvents, live);
  }, [applyToolBlocks, applyStreamSegments, replaceMessages, replayHydrationBuffer]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    messages,
    status,
    streamingContent,
    streamingThinking,
    toolBlocks,
    streamSegments,
    streamRevision,
    error,
    usage,
    currentTurnUsage,
    cumulativeUsage,
    streamStartTime,
    interruptState,
    interrupted,
    cwd,
    send,
    cancel,
    stop,
    getSnapshot,
    beginSessionSwitch,
    hydrateSnapshot,
    clearError,
    setMessages: replaceMessages,
    isSwitchingSession,
  };
}

/**
 * Convert chronological stream segments into persisted messages.
 * Order matches call order: tool pair(s) and text segments interleaved.
 */
export function commitSegmentsToMessages(opts: {
  segments: readonly StreamSegment[];
  liveTools: readonly ToolBlock[];
  fallbackResponse: string;
  interrupted: boolean;
  usage: Usage | null;
  thinking: string | null;
}): Message[] {
  const { segments, liveTools, fallbackResponse, interrupted, usage, thinking } = opts;
  const toolsById = new Map(liveTools.map((b) => [b.id, b]));
  const out: Message[] = [];
  const usedToolIds = new Set<string>();

  if (segments.length > 0) {
    // Find last text segment so usage lands on the final assistant bubble.
    let lastTextIndex = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].kind === 'text') {
        lastTextIndex = i;
        break;
      }
    }

    segments.forEach((seg, index) => {
      if (seg.kind === 'tool') {
        const block = toolsById.get(seg.toolCallId);
        if (block) {
          usedToolIds.add(block.id);
          out.push(...toolBlockToMessages(block));
        }
        return;
      }
      if (seg.kind === 'text') {
        if (!seg.content && !(interrupted && index === lastTextIndex)) return;
        out.push({
          id: seg.id || crypto.randomUUID(),
          role: MessageRole.ASSISTANT,
          content: seg.content,
          type: MessageType.TEXT,
          tool_calls: null,
          tool_call_id: null,
          name: null,
          thinking: index === lastTextIndex ? thinking : null,
          timestamp: new Date().toISOString(),
          usage: index === lastTextIndex ? usage : null,
          hidden: false,
          tool_result: null,
  });
        return;
      }
      if (seg.kind === 'thinking' && seg.content) {
        out.push({
          id: seg.id || crypto.randomUUID(),
          role: MessageRole.ASSISTANT,
          content: seg.content,
          type: MessageType.THINKING,
          tool_calls: null,
          tool_call_id: null,
          name: null,
          thinking: seg.content,
          timestamp: new Date().toISOString(),
          usage: null,
          hidden: false,
          tool_result: null,
  });
      }
    });

    // Any tools that never got a segment entry (should be rare) — append in start order.
    for (const block of liveTools) {
      if (!usedToolIds.has(block.id)) {
        out.push(...toolBlockToMessages(block));
      }
    }
    if (usage && lastTextIndex < 0) {
      out.push({
        id: crypto.randomUUID(),
        role: MessageRole.ASSISTANT,
        content: '',
        type: MessageType.TEXT,
        tool_calls: null,
        tool_call_id: null,
        name: null,
        thinking,
        timestamp: new Date().toISOString(),
        usage,
        hidden: true,
        tool_result: null,
      });
    }
    return out;
  }

  // Fallback: no segment timeline (older paths) — tools then single assistant.
  for (const block of liveTools) {
    out.push(...toolBlockToMessages(block));
  }
  if (fallbackResponse || interrupted || usage) {
    out.push({
      id: crypto.randomUUID(),
      role: MessageRole.ASSISTANT,
      content: fallbackResponse ?? '',
      type: MessageType.TEXT,
      tool_calls: null,
      tool_call_id: null,
      name: null,
      thinking,
      timestamp: new Date().toISOString(),
      usage,
      hidden: !fallbackResponse && !interrupted && usage != null,
      tool_result: null,
  });
  }
  return out;
}

/** Convert a live ToolBlock into persisted tool_call + tool_result messages. */
function toolBlockToMessages(block: ToolBlock): Message[] {
  const callId = block.id;
  const toolName = block.toolName || 'unknown';
  const args = block.args || block.partialArgs || '{}';
  const call: Message = {
    id: crypto.randomUUID(),
    role: MessageRole.ASSISTANT,
    content: '',
    type: MessageType.TOOL_CALL,
    tool_calls: [
      {
        id: callId,
        type: 'function',
        function: { name: toolName, arguments: args },
      },
    ],
    tool_call_id: callId,
    name: toolName,
    thinking: null,
    timestamp: block.startedAt,
    usage: null,
    hidden: false,
    tool_result: null,
  };

  if (!block.toolResult) return [call];
  const result: Message = {
    id: crypto.randomUUID(),
    role: MessageRole.TOOL,
    content: block.agentProjection ?? '',
    type: MessageType.TOOL_RESULT,
    tool_calls: null,
    tool_call_id: callId,
    name: toolName,
    thinking: null,
    timestamp: block.finishedAt ?? block.startedAt,
    usage: null,
    hidden: false,
    tool_result: block.toolResult,
  };

  return [call, result];
}

function upsertToolBlock(blocks: ToolBlock[], next: ToolBlock, merge = false): ToolBlock[] {
  const existing = blocks.find((block) => block.id === next.id);
  if (!existing) return [...blocks, next];

  return blocks.map((block) => {
    if (block.id !== next.id) return block;
    return merge
      ? {
          ...block,
          toolName: next.toolName === 'unknown' ? block.toolName : next.toolName,
          status: next.status,
          partialArgs: next.partialArgs || block.partialArgs,
          args: next.args || block.args || block.partialArgs,
          agentProjection: next.agentProjection ?? block.agentProjection,
          toolResult: next.toolResult ?? block.toolResult,
          finishedAt: next.finishedAt ?? block.finishedAt,
        }
      : { ...block, ...next };
  });
}
