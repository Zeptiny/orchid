/**
 * Spike: Minimal chat UI for U2 foundation patterns validation.
 *
 * Features:
 * - Text input + send button
 * - Message list (user + assistant)
 * - Streaming response display in real-time
 * - Cancel button during streaming
 *
 * This is throwaway code — real chat UI comes in U20.
 */
import { useState, useRef, useEffect, useCallback } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

type StreamState = 'idle' | 'streaming' | 'error';

// ─── Component ───────────────────────────────────────────────────────────────

export function SpikeChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Subscribe to IPC events
  useEffect(() => {
    const unsubChunk = window.orchid.chat.onChunk((event) => {
      setStreamingContent((prev) => prev + event.data);
    });

    const unsubState = window.orchid.chat.onState((event) => {
      if (event.state === 'streaming') {
        setStreamState('streaming');
      } else if (event.state === 'error') {
        setStreamState('error');
        setError(event.error);
      } else if (event.state === 'idle') {
        setStreamState('idle');
      }
    });

    const unsubDone = window.orchid.chat.onDone((event) => {
      if (event.response) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: event.response },
        ]);
      }
      setStreamingContent('');
      setStreamState('idle');
      inputRef.current?.focus();
    });

    const unsubError = window.orchid.chat.onError((event) => {
      setError(event.error);
      setStreamState('idle');
      setStreamingContent('');
      inputRef.current?.focus();
    });

    return () => {
      unsubChunk();
      unsubState();
      unsubDone();
      unsubError();
    };
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || streamState === 'streaming') return;

    // Add user message
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    setInput('');
    setError(null);
    setStreamingContent('');
    setStreamState('streaming');

    try {
      await window.orchid.chat.send({ message: trimmed });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStreamState('idle');
    }
  }, [input, streamState]);

  const handleCancel = useCallback(async () => {
    try {
      await window.orchid.chat.cancel();
    } catch {
      // Ignore cancel errors
    }
    setStreamState('idle');
    setStreamingContent('');
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.title}>Orchid Spike Chat</h2>
        <span style={styles.subtitle}>
          U2: Foundation Patterns Validation
        </span>
      </div>

      {/* Messages */}
      <div style={styles.messages}>
        {messages.length === 0 && !streamingContent && (
          <div style={styles.empty}>
            Send a message to test the XState + AI SDK + Zod pipeline.
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              ...styles.message,
              ...(msg.role === 'user' ? styles.userMessage : styles.assistantMessage),
            }}
          >
            <div style={styles.messageRole}>
              {msg.role === 'user' ? 'You' : 'Assistant'}
            </div>
            <div style={styles.messageContent}>{msg.content}</div>
          </div>
        ))}

        {/* Streaming content */}
        {streamingContent && (
          <div style={{ ...styles.message, ...styles.assistantMessage }}>
            <div style={styles.messageRole}>Assistant</div>
            <div style={styles.messageContent}>
              {streamingContent}
              <span style={styles.cursor}>▊</span>
            </div>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div style={styles.error}>
            <strong>Error:</strong> {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={styles.inputArea}>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          style={styles.input}
          disabled={streamState === 'streaming'}
        />
        {streamState === 'streaming' ? (
          <button onClick={handleCancel} style={styles.cancelButton}>
            Cancel
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            style={styles.sendButton}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    backgroundColor: 'var(--bg-primary, #1a1a2e)',
    color: 'var(--text-primary, #e0e0e0)',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border-default, #2a2a4a)',
    display: 'flex',
    alignItems: 'baseline',
    gap: '12px',
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
  },
  subtitle: {
    fontSize: '12px',
    color: 'var(--text-secondary, #888)',
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  empty: {
    textAlign: 'center',
    color: 'var(--text-tertiary, #666)',
    padding: '40px 0',
    fontSize: '14px',
  },
  message: {
    padding: '10px 14px',
    borderRadius: '8px',
    maxWidth: '80%',
    fontSize: '14px',
    lineHeight: '1.5',
  },
  userMessage: {
    alignSelf: 'flex-end',
    backgroundColor: 'var(--msg-user-bg, #2a4a6a)',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    backgroundColor: 'var(--msg-assistant-bg, #2a2a4a)',
  },
  messageRole: {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--text-secondary, #aaa)',
    marginBottom: '4px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  messageContent: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  cursor: {
    animation: 'blink 1s step-end infinite',
    color: 'var(--accent-primary, #4a9eff)',
  },
  error: {
    padding: '10px 14px',
    borderRadius: '8px',
    backgroundColor: 'var(--msg-error-bg, #4a2a2a)',
    color: 'var(--accent-error, #ff6b6b)',
    fontSize: '13px',
  },
  inputArea: {
    padding: '12px 16px',
    borderTop: '1px solid var(--border-default, #2a2a4a)',
    display: 'flex',
    gap: '8px',
  },
  input: {
    flex: 1,
    padding: '10px 14px',
    borderRadius: '6px',
    border: '1px solid var(--input-border, #3a3a5a)',
    backgroundColor: 'var(--input-bg, #2a2a4a)',
    color: 'var(--input-text, #e0e0e0)',
    fontSize: '14px',
    outline: 'none',
  },
  sendButton: {
    padding: '10px 20px',
    borderRadius: '6px',
    border: 'none',
    backgroundColor: 'var(--btn-primary-bg, #4a9eff)',
    color: 'var(--btn-primary-text, #fff)',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  cancelButton: {
    padding: '10px 20px',
    borderRadius: '6px',
    border: 'none',
    backgroundColor: 'var(--btn-danger-bg, #ff4a4a)',
    color: 'var(--btn-danger-text, #fff)',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
  },
};
