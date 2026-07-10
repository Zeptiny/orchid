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
} from '../../shared/types/ipc';
import {
  type ContextBreakdown,
  computeContextBreakdown,
} from '../components/ContextGrid';
import { latestUsageFromMessages } from '../../shared/usage';

// ── Types ────────────────────────────────────────────────────────────────────

export type ChatStatus = 'idle' | 'streaming' | 'error';

export type InterruptState = 'idle' | 'confirmAgent' | 'confirmSubagents';

export type ToolBlockStatus = 'generating' | 'running' | 'completed' | 'failed';

export interface ToolBlock {
  id: string;
  toolName: string;
  status: ToolBlockStatus;
  partialArgs: string;
  args: string;
  result: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * Chronological segments for the in-flight turn.
 * Preserves call order: tool → text → tool → text → …
 */
export type StreamSegment =
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'text'; id: string; content: string }
  | { kind: 'thinking'; id: string; content: string };

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
  /** Error message if status is 'error'. */
  error: string | null;
  /** Latest usage data from the stream. */
  usage: Usage | null;
  /** Context token breakdown by category (computed from messages + usage). */
  contextBreakdown: ContextBreakdown | null;
  /** Stream start time (ms epoch) for elapsed tracking. */
  streamStartTime: number | null;
  /** Stream elapsed time in seconds. */
  elapsedSeconds: number;
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
  model?: string;
}

export interface UseChatReturn extends ChatState {
  /** Send a message to the chat. */
  send: (message: string, options?: ChatSendOptions) => Promise<void>;
  /** Cancel the current stream. */
  cancel: () => Promise<void>;
  /** Clear the error state. */
  clearError: () => void;
  /**
   * Replace messages and wipe all live/stale chat UI state (session switch /
   * new session). Clears tools, streaming, usage, errors, interrupt flags.
   */
  setMessages: (messages: Message[]) => void;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [toolBlocks, setToolBlocks] = useState<ToolBlock[]>([]);
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Live stream usage; also rehydrated from the last message with usage
  // when replacing messages (session switch / load).
  const [usage, setUsage] = useState<Usage | null>(null);
  const [streamStartTime, setStreamStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [interruptState, setInterruptState] = useState<InterruptState>('idle');
  const [interrupted, setInterrupted] = useState(false);
  const [cwd, setCwd] = useState('');

  // Context breakdown from messages + usage
  const contextBreakdown = useMemo(
    () => computeContextBreakdown(messages, usage),
    [messages, usage],
  );

  // Cumulative usage summed across all messages that carry usage data
  const cumulativeUsage: Usage = useMemo(() => {
    let prompt = 0;
    let completion = 0;
    let total = 0;
    let cached = 0;
    for (const msg of messages) {
      if (msg.usage) {
        prompt += msg.usage.prompt_tokens;
        completion += msg.usage.completion_tokens;
        total += msg.usage.total_tokens;
        cached += msg.usage.cached_tokens;
      }
    }
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total, cached_tokens: cached };
  }, [messages]);

  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const accumulatedContentRef = useRef('');
  const accumulatedThinkingRef = useRef('');
  const usageRef = useRef<Usage | null>(null);
  const toolBlocksRef = useRef<ToolBlock[]>([]);
  const streamSegmentsRef = useRef<StreamSegment[]>([]);
  /** Sync guard against double-send before status re-render (P1-35). */
  const isSendingRef = useRef(false);

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
    },
    [],
  );

  /**
   * Update streamSegmentsRef synchronously, then mirror into React state.
   * Mirrors applyToolBlocks so onDone never reads a stale segment timeline.
   */
  const applyStreamSegments = useCallback(
    (updater: StreamSegment[] | ((prev: StreamSegment[]) => StreamSegment[])) => {
      const prev = streamSegmentsRef.current;
      const next = typeof updater === 'function' ? updater(prev) : updater;
      streamSegmentsRef.current = next;
      setStreamSegments(next);
    },
    [],
  );

  // Elapsed time ticker
  useEffect(() => {
    if (status === 'streaming' && streamStartTime) {
      elapsedIntervalRef.current = setInterval(() => {
        setElapsedSeconds((Date.now() - streamStartTime) / 1000);
      }, 100);
    } else {
      if (elapsedIntervalRef.current) {
        clearInterval(elapsedIntervalRef.current);
        elapsedIntervalRef.current = null;
      }
    }
    return () => {
      if (elapsedIntervalRef.current) {
        clearInterval(elapsedIntervalRef.current);
      }
    };
  }, [status, streamStartTime]);

  // Subscribe to IPC events
  useEffect(() => {
    if (!window.orchid?.chat) {
      console.warn('window.orchid.chat not available — IPC not ready');
      return;
    }

    const unsubChunk = window.orchid.chat.onChunk((event: ChatChunkEvent) => {
      accumulatedContentRef.current += event.data;
      setStreamingContent(accumulatedContentRef.current);
      // Append to last text segment, or open a new one (preserves tool→text→tool order).
      applyStreamSegments((prev) => {
        const last = prev[prev.length - 1];
        if (last?.kind === 'text') {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + event.data },
          ];
        }
        return [
          ...prev,
          { kind: 'text', id: crypto.randomUUID(), content: event.data },
        ];
      });
    });

    const unsubThinking =
      window.orchid.chat.onThinking?.((event: ChatThinkingEvent) => {
        accumulatedThinkingRef.current += event.data;
        setStreamingThinking(accumulatedThinkingRef.current);
        // Chronological thinking segments → Thought widgets in ChatStream
        applyStreamSegments((prev) => {
          const last = prev[prev.length - 1];
          if (last?.kind === 'thinking') {
            return [
              ...prev.slice(0, -1),
              { ...last, content: last.content + event.data },
            ];
          }
          return [
            ...prev,
            { kind: 'thinking', id: crypto.randomUUID(), content: event.data },
          ];
        });
      }) ?? (() => {});

    const unsubState = window.orchid.chat.onState((event: ChatStateEvent) => {
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

    const unsubDone = window.orchid.chat.onDone((event: ChatDoneEvent) => {
      if (event.usage) {
        setUsage(event.usage);
        usageRef.current = event.usage;
      }

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

    const unsubError = window.orchid.chat.onError((event: ChatErrorEvent) => {
      // Prefer title + detail for banner classification when available
      const display =
        event.title && event.error && !event.error.startsWith(event.title)
          ? `${event.title}: ${event.error}`
          : event.error;
      setError(display);
      setStatus('idle');
      isSendingRef.current = false;
      setStreamingContent('');
      setStreamingThinking('');
      applyStreamSegments([]);
      setInterruptState('idle');
      accumulatedContentRef.current = '';
      accumulatedThinkingRef.current = '';
    });

    const unsubUsage = window.orchid.chat.onUsage((event: ChatUsageEvent) => {
      setUsage(event.usage);
      usageRef.current = event.usage;
    });

    const unsubToolStart = window.orchid.chat.onToolCallStart?.((event: ChatToolCallStartEvent) => {
      applyToolBlocks((prev) => upsertToolBlock(prev, {
        id: event.toolCallId,
        toolName: event.toolName,
        status: 'generating',
        partialArgs: '',
        args: '',
        result: null,
        error: null,
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
    }) ?? (() => {});

    const unsubToolDelta = window.orchid.chat.onToolCallDelta?.((event: ChatToolCallDeltaEvent) => {
      applyToolBlocks((prev) => prev.map((block) => {
        if (block.id !== event.toolCallId) return block;
        return {
          ...block,
          partialArgs: block.partialArgs + event.argsDelta,
          status: block.status === 'completed' || block.status === 'failed'
            ? block.status
            : 'generating',
        };
      }));
    }) ?? (() => {});

    const unsubToolUpdate = window.orchid.chat.onToolCallUpdate?.((event: ChatToolCallUpdateEvent) => {
      applyToolBlocks((prev) => upsertToolBlock(prev, {
        id: event.toolCallId,
        toolName: event.toolName ?? 'unknown',
        status: event.status === 'failed'
          ? 'failed'
          : event.status === 'completed'
            ? 'completed'
            : 'running',
        partialArgs: '',
        args: event.args ?? '',
        result: event.result ?? null,
        error: event.error ?? null,
        startedAt: new Date().toISOString(),
        finishedAt: event.status === 'completed' || event.status === 'failed'
          ? new Date().toISOString()
          : null,
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
    }) ?? (() => {});

    return () => {
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
  }, [applyToolBlocks, applyStreamSegments]);

  const send = useCallback(
    async (message: string, options?: ChatSendOptions) => {
      // isSendingRef is synchronous; status alone can be stale across rapid Enter.
      if (!message.trim() || status === 'streaming' || isSendingRef.current) return;
      if (!window.orchid?.chat) {
        setError('Chat IPC not available');
        return;
      }

      isSendingRef.current = true;

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
    is_error: false,
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
      setError(null);
      setStreamingContent('');
      setStreamingThinking('');
      applyToolBlocks([]);
      applyStreamSegments([]);
      setUsage(null);
      setInterrupted(false);
      usageRef.current = null;
      setStreamStartTime(Date.now());
      setElapsedSeconds(0);
      setInterruptState('idle');
      accumulatedContentRef.current = '';
      accumulatedThinkingRef.current = '';
      setStatus('streaming');

      try {
        const result = await window.orchid.chat.send({
          message: trimmed,
          ...(options?.model ? { model: options.model } : {}),
        });
        // Structured gate failures (e.g. unbound workspace) — no stream starts.
        if (result && result.status === 'error') {
          isSendingRef.current = false;
          setError(
            result.error ??
              (result.kind === 'unbound_workspace'
                ? 'No project folder selected. Choose a folder before sending a message.'
                : 'Failed to send message'),
          );
          setStatus('error');
          // Drop the optimistic user bubble when send never started.
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.id === userMessage.id) {
              return prev.slice(0, -1);
            }
            return prev;
          });
          setStreamStartTime(null);
          setElapsedSeconds(0);
        }
      } catch (err) {
        isSendingRef.current = false;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    },
    [status, error, applyToolBlocks, applyStreamSegments],
  );

  const cancel = useCallback(async () => {
    if (!window.orchid?.chat) return;
    try {
      const result = await window.orchid.chat.cancel();
      const status = result && (result as { status: string }).status;

      // First Esc only shows confirmAgent hint
      if (status === 'confirming') {
        setInterruptState('confirmAgent');
        return;
      }

      // Second Esc cancels the agent. Main process emits CHAT_DONE with
      // interrupted=true (partial content, no suffix). Stay in subagent phase
      // if applicable; mark in-flight tool blocks as failed.
      // Don't set status='idle' here — let onDone handle finalization to
      // avoid double-committing segments. interruptState is confirmSubagents
      // here and from onState; onDone must not reset it to idle (P1-34).
      if (status === 'confirming_subagents') {
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
        return;
      }

      // Third Esc (or full cancel with no subagents)
      if (status === 'cancelled') {
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
        setStreamingContent('');
        setStreamingThinking('');
        accumulatedContentRef.current = '';
        accumulatedThinkingRef.current = '';
        setStatus('idle');
        return;
      }
    } catch {
      // Ignore cancel errors
    }
  }, [applyToolBlocks]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  /**
   * Replace messages (session load / new session) and drop all live/stale UI
   * state so nothing from the previous session remains (tools, stream, etc.).
   * Restores context usage from the newest message that carries usage so the
   * sidebar Context panel and footer radial reflect the loaded session.
   */
  const replaceMessages = useCallback((next: Message[]) => {
    setMessages(next);
    applyToolBlocks([]);
    applyStreamSegments([]);
    setStreamingContent('');
    setStreamingThinking('');
    setError(null);
    setInterrupted(false);
    setInterruptState('idle');
    isSendingRef.current = false;
    setStatus('idle');
    // Rehydrate last-turn context usage from persisted messages; empty/new
    // sessions correctly get null → 0% context until the next stream.
    const restored = latestUsageFromMessages(next);
    setUsage(restored);
    usageRef.current = restored;
    setStreamStartTime(null);
    setElapsedSeconds(0);
    accumulatedContentRef.current = '';
    accumulatedThinkingRef.current = '';
  }, [applyToolBlocks, applyStreamSegments]);

  return {
    messages,
    status,
    streamingContent,
    streamingThinking,
    toolBlocks,
    streamSegments,
    error,
    usage,
    cumulativeUsage,
    contextBreakdown,
    streamStartTime,
    elapsedSeconds,
    interruptState,
    interrupted,
    cwd,
    send,
    cancel,
    clearError,
    setMessages: replaceMessages,
  };
}

/**
 * Convert chronological stream segments into persisted messages.
 * Order matches call order: tool pair(s) and text segments interleaved.
 */
function commitSegmentsToMessages(opts: {
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
    is_error: false,
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
    is_error: false,
  });
      }
    });

    // Any tools that never got a segment entry (should be rare) — append in start order.
    for (const block of liveTools) {
      if (!usedToolIds.has(block.id)) {
        out.push(...toolBlockToMessages(block));
      }
    }
    return out;
  }

  // Fallback: no segment timeline (older paths) — tools then single assistant.
  for (const block of liveTools) {
    out.push(...toolBlockToMessages(block));
  }
  if (fallbackResponse || interrupted) {
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
      hidden: false,
    is_error: false,
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
    is_error: false,
  };

  const resultContent =
    block.status === 'failed'
      ? block.error ?? 'Tool failed'
      : block.result ?? '';

  const result: Message = {
    id: crypto.randomUUID(),
    role: MessageRole.TOOL,
    content: resultContent,
    type: MessageType.TOOL_RESULT,
    tool_calls: null,
    tool_call_id: callId,
    name: toolName,
    thinking: null,
    timestamp: block.finishedAt ?? block.startedAt,
    usage: null,
    hidden: false,
    is_error: block.status === 'failed',
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
          result: next.result ?? block.result,
          error: next.error ?? block.error,
          finishedAt: next.finishedAt ?? block.finishedAt,
        }
      : { ...block, ...next };
  });
}
