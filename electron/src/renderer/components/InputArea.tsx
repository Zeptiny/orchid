/**
 * InputArea — text input for chat messages.
 *
 * Features:
 * - Textarea with auto-resize
 * - Submit: Enter or Ctrl+S
 * - Clear: Ctrl+C (when input is focused and empty)
 * - Cancel: Esc (during streaming)
 * - Model indicator
 * - Disabled during streaming
 *
 * Interaction states:
 * - Empty: placeholder text
 * - Loading: disabled input with spinner
 */
import { useRef, useCallback, useEffect, useState } from 'react';
import type { ChatStatus } from '../hooks/useChat';

// ── Props ────────────────────────────────────────────────────────────────────

interface InputAreaProps {
  status: ChatStatus;
  model: string;
  onSend: (message: string) => Promise<void>;
  onCancel: () => Promise<void>;
}

// ── Component ────────────────────────────────────────────────────────────────

export function InputArea({ status, model, onSend, onCancel }: InputAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState('');

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [input]);

  // Focus textarea when streaming ends
  useEffect(() => {
    if (status === 'idle') {
      textareaRef.current?.focus();
    }
  }, [status]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || status === 'streaming') return;
    setInput('');
    await onSend(trimmed);
  }, [input, status, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Enter (without Shift) or Ctrl+S to send
      if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 's' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        handleSend();
        return;
      }

      // Esc to cancel streaming
      if (e.key === 'Escape' && status === 'streaming') {
        e.preventDefault();
        onCancel();
        return;
      }

      // Ctrl+C to clear when input is empty
      if (e.key === 'c' && (e.ctrlKey || e.metaKey) && !input.trim()) {
        e.preventDefault();
        setInput('');
        return;
      }
    },
    [handleSend, onCancel, status, input],
  );

  const isStreaming = status === 'streaming';

  return (
    <div className="input-area">
      <div className="input-row">
        <div className="model-indicator">
          <span className="model-indicator-dot" />
          <span>{model || 'No model'}</span>
        </div>
        <textarea
          ref={textareaRef}
          className="input-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? 'Streaming...' : 'Type a message... (Enter to send)'}
          disabled={isStreaming}
          rows={1}
        />
        <div className="input-actions">
          {isStreaming ? (
            <button className="btn btn-danger btn-sm" onClick={onCancel}>
              Cancel
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSend}
              disabled={!input.trim()}
            >
              Send
            </button>
          )}
        </div>
      </div>
      <div className="input-hint">
        Enter or Ctrl+S to send &middot; Shift+Enter for newline &middot; Esc to cancel
      </div>
    </div>
  );
}
