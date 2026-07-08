/**
 * ChatStream — scrollable message stream with smart auto-scroll.
 *
 * Smart auto-scroll: scrolls to bottom on new messages, but doesn't
 * auto-scroll if the user has scrolled up (to allow reading history).
 *
 * Interaction states:
 * - Empty: placeholder with CTA
 * - Loading: spinner (during session load)
 * - Error: error banner with retry
 * - Streaming: partial content with cursor
 */
import { useRef, useEffect, useCallback, useState } from 'react';
import type { Message } from '../../shared/types/message';
import type { ChatStatus } from '../hooks/useChat';
import { MessageWidget } from './MessageWidget';

// ── Props ────────────────────────────────────────────────────────────────────

interface ChatStreamProps {
  messages: Message[];
  streamingContent: string;
  status: ChatStatus;
  error: string | null;
  onClearError: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ChatStream({
  messages,
  streamingContent,
  status,
  error,
  onClearError,
}: ChatStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);

  // Smart auto-scroll: scroll to bottom unless user has scrolled up
  const scrollToBottom = useCallback(() => {
    if (!isUserScrolledUp) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isUserScrolledUp]);

  // Detect user scroll position
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // Consider "scrolled up" if user is more than 100px from bottom
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      setIsUserScrolledUp(distanceFromBottom > 100);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll on new messages or streaming content
  useEffect(() => {
    scrollToBottom();
  }, [messages.length, streamingContent, scrollToBottom]);

  // Auto-scroll when streaming starts (user just sent a message)
  useEffect(() => {
    if (status === 'streaming') {
      setIsUserScrolledUp(false);
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [status]);

  // Empty state
  if (messages.length === 0 && !streamingContent && status === 'idle') {
    return (
      <div className="chat-empty">
        <div className="chat-empty-icon">&#127793;</div>
        <div className="chat-empty-title">Welcome to Orchid</div>
        <div className="chat-empty-subtitle">
          Start a conversation by typing a message below.
          <br />
          Press Enter or Ctrl+S to send, Esc to cancel.
        </div>
      </div>
    );
  }

  return (
    <div className="chat-stream" ref={containerRef}>
      {/* Error banner */}
      {error && (
        <div className="error-banner">
          <span className="error-banner-message">{error}</span>
          <button className="btn btn-ghost btn-sm" onClick={onClearError}>
            Dismiss
          </button>
        </div>
      )}

      {/* Messages */}
      {messages.map((msg) => (
        <MessageWidget key={msg.id} message={msg} />
      ))}

      {/* Streaming content (not yet committed) */}
      {streamingContent && status === 'streaming' && (
        <MessageWidget
          message={{
            id: 'streaming',
            role: 'assistant',
            content: streamingContent,
            type: 'text',
            tool_calls: null,
            tool_call_id: null,
            name: null,
            thinking: null,
            timestamp: new Date().toISOString(),
            usage: null,
            hidden: false,
          }}
          isStreaming
        />
      )}

      {/* Scroll anchor */}
      <div ref={messagesEndRef} />
    </div>
  );
}
