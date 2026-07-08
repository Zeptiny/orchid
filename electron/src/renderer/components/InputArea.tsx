/**
 * InputArea — text input for chat messages.
 *
 * Uses DaisyUI components for styling.
 */
import { useRef, useCallback, useEffect, useState } from 'react';
import type { ChatStatus } from '../hooks/useChat';

interface InputAreaProps {
  status: ChatStatus;
  model: string;
  onSend: (message: string) => Promise<void>;
  onCancel: () => Promise<void>;
}

export function InputArea({ status, model, onSend, onCancel }: InputAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState('');

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [input]);

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
      if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 's' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        handleSend();
        return;
      }

      if (e.key === 'Escape' && status === 'streaming') {
        e.preventDefault();
        onCancel();
        return;
      }

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
    <div className="p-4 bg-base-200 border-t border-base-300">
      <div className="flex items-end gap-2">
        <div className="badge badge-neutral gap-1">
          <span className={`w-2 h-2 rounded-full ${isStreaming ? 'bg-warning animate-pulse' : 'bg-success'}`} />
          <span className="text-xs">{model || 'No model'}</span>
        </div>
        <textarea
          ref={textareaRef}
          className="textarea textarea-bordered flex-1 min-h-[40px] max-h-[200px] resize-none"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? 'Streaming...' : 'Type a message... (Enter to send)'}
          disabled={isStreaming}
          rows={1}
        />
        <div className="flex gap-2">
          {isStreaming ? (
            <button className="btn btn-error btn-sm" onClick={onCancel}>
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
      <div className="text-xs text-base-content/50 mt-2">
        Enter or Ctrl+S to send · Shift+Enter for newline · Esc to cancel
      </div>
    </div>
  );
}
