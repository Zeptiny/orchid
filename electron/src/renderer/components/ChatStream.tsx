/**
 * ChatStream — scrollable message stream with smart auto-scroll.
 *
 * Uses DaisyUI components for styling.
 */
import { useRef, useEffect, useCallback, useState } from 'react';
import type { Message } from '../../shared/types/message';
import type { ChatStatus } from '../hooks/useChat';
import { MessageWidget } from './MessageWidget';

interface ChatStreamProps {
  messages: Message[];
  streamingContent: string;
  status: ChatStatus;
  error: string | null;
  onClearError: () => void;
}

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

  const scrollToBottom = useCallback(() => {
    if (!isUserScrolledUp) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isUserScrolledUp]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      setIsUserScrolledUp(distanceFromBottom > 100);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, streamingContent, scrollToBottom]);

  useEffect(() => {
    if (status === 'streaming') {
      setIsUserScrolledUp(false);
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [status]);

  if (messages.length === 0 && !streamingContent && status === 'idle') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center p-8">
          <div className="text-6xl mb-4">🌸</div>
          <h2 className="text-2xl font-bold mb-2">Welcome to Orchid</h2>
          <p className="text-base-content/60">
            Start a conversation by typing a message below.
            <br />
            Press Enter or Ctrl+S to send, Esc to cancel.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={containerRef}>
      {error && (
        <div className="alert alert-error">
          <span>{error}</span>
          <button className="btn btn-ghost btn-sm" onClick={onClearError}>
            Dismiss
          </button>
        </div>
      )}

      {messages.map((msg) => (
        <MessageWidget key={msg.id} message={msg} />
      ))}

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

      <div ref={messagesEndRef} />
    </div>
  );
}
