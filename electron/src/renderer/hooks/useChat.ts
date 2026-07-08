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
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Message, Usage } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';
import type {
  ChatChunkEvent,
  ChatStateEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatUsageEvent,
} from '../../shared/types/ipc';

// ── Types ────────────────────────────────────────────────────────────────────

export type ChatStatus = 'idle' | 'streaming' | 'error';

export interface ChatState {
  /** All messages in the current chain. */
  messages: Message[];
  /** Current streaming status. */
  status: ChatStatus;
  /** Partial content being streamed (before commit). */
  streamingContent: string;
  /** Thinking content being streamed. */
  streamingThinking: string;
  /** Error message if status is 'error'. */
  error: string | null;
  /** Latest usage data from the stream. */
  usage: Usage | null;
  /** Stream start time (ms epoch) for elapsed tracking. */
  streamStartTime: number | null;
  /** Stream elapsed time in seconds. */
  elapsedSeconds: number;
}

export interface UseChatReturn extends ChatState {
  /** Send a message to the chat. */
  send: (message: string) => Promise<void>;
  /** Cancel the current stream. */
  cancel: () => Promise<void>;
  /** Clear the error state. */
  clearError: () => void;
  /** Manually set messages (for session loading). */
  setMessages: (messages: Message[]) => void;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [error, setError] = useState<string | null>(null);
  // TODO: Wire up usage tracking — no IPC event populates this yet.
  // The infrastructure (state, Footer display) is ready; needs a
  // ChatUsageEvent from main→renderer to complete the data path.
  const [usage, setUsage] = useState<Usage | null>(null);
  const [streamStartTime, setStreamStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const accumulatedContentRef = useRef('');
  const accumulatedThinkingRef = useRef('');
  const usageRef = useRef<Usage | null>(null);

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
    });

    const unsubState = window.orchid.chat.onState((event: ChatStateEvent) => {
      if (event.state === 'streaming') {
        setStatus('streaming');
      } else if (event.state === 'error') {
        setStatus('error');
        setError(event.error);
      } else if (event.state === 'idle') {
        setStatus('idle');
      }
    });

    const unsubDone = window.orchid.chat.onDone((event: ChatDoneEvent) => {
      if (event.response) {
        const newMessage: Message = {
          id: crypto.randomUUID(),
          role: MessageRole.ASSISTANT,
          content: event.response,
          type: MessageType.TEXT,
          tool_calls: null,
          tool_call_id: null,
          name: null,
          thinking: accumulatedThinkingRef.current || null,
          timestamp: new Date().toISOString(),
          usage: usageRef.current,
          hidden: false,
        };
        setMessages((prev) => [...prev, newMessage]);
      }
      setStreamingContent('');
      setStreamingThinking('');
      accumulatedContentRef.current = '';
      accumulatedThinkingRef.current = '';
      setStatus('idle');
    });

    const unsubError = window.orchid.chat.onError((event: ChatErrorEvent) => {
      setError(event.error);
      setStatus('idle');
      setStreamingContent('');
      setStreamingThinking('');
      accumulatedContentRef.current = '';
      accumulatedThinkingRef.current = '';
    });

    const unsubUsage = window.orchid.chat.onUsage((event: ChatUsageEvent) => {
      setUsage(event.usage);
      usageRef.current = event.usage;
    });

    return () => {
      unsubChunk();
      unsubState();
      unsubDone();
      unsubError();
      unsubUsage();
    };
  }, []);

  const send = useCallback(
    async (message: string) => {
      if (!message.trim() || status === 'streaming') return;
      if (!window.orchid?.chat) {
        setError('Chat IPC not available');
        return;
      }

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: MessageRole.USER,
        content: message.trim(),
        type: MessageType.TEXT,
        tool_calls: null,
        tool_call_id: null,
        name: null,
        thinking: null,
        timestamp: new Date().toISOString(),
        usage: null,
        hidden: false,
      };

      setMessages((prev) => [...prev, userMessage]);
      setError(null);
      setStreamingContent('');
      setStreamingThinking('');
      setUsage(null);
      usageRef.current = null;
      setStreamStartTime(Date.now());
      setElapsedSeconds(0);
      accumulatedContentRef.current = '';
      accumulatedThinkingRef.current = '';
      setStatus('streaming');

      try {
        await window.orchid.chat.send({ message: message.trim() });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('idle');
      }
    },
    [status],
  );

  const cancel = useCallback(async () => {
    if (!window.orchid?.chat) return;
    try {
      await window.orchid.chat.cancel();
    } catch {
      // Ignore cancel errors
    }
    // Append interrupted message
    if (accumulatedContentRef.current) {
      const interruptedMessage: Message = {
        id: crypto.randomUUID(),
        role: MessageRole.ASSISTANT,
        content: accumulatedContentRef.current + '\n\n[Interrupted by user]',
        type: MessageType.TEXT,
        tool_calls: null,
        tool_call_id: null,
        name: null,
        thinking: accumulatedThinkingRef.current || null,
        timestamp: new Date().toISOString(),
        usage: null,
        hidden: false,
      };
      setMessages((prev) => [...prev, interruptedMessage]);
    }
    setStreamingContent('');
    setStreamingThinking('');
    accumulatedContentRef.current = '';
    accumulatedThinkingRef.current = '';
    setStatus('idle');
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    messages,
    status,
    streamingContent,
    streamingThinking,
    error,
    usage,
    streamStartTime,
    elapsedSeconds,
    send,
    cancel,
    clearError,
    setMessages,
  };
}
