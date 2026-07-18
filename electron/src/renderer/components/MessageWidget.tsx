/**
 * MessageWidget — renders a single message based on its role/type.
 *
 * Flat chat (no DaisyUI chat/chat-bubble). Thought blocks use disclosure
 * chrome; tool call/result messages fall back to ToolCallBlock for edge cases.
 * ChatStream normally converts them into ToolBlocks for consistent ordering.
 */
import { useState, useCallback, useMemo, useEffect, useId } from 'react';
import type { Message } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';
import {
  estimateThoughtDurationMs,
  formatDurationMs,
} from '../utils/thought-grouping';
import type { ToolBlock } from '../hooks/useChat';
import { MarkdownContent } from './MarkdownContent';
import { Icon } from './Icon';
import { ToolCallBlock } from './ToolCallBlock';
import { Alert } from './ui/Alert';
import { Spinner } from './ui/Spinner';

interface MessageWidgetProps {
  message: Message;
  isStreaming?: boolean;
}

export function MessageWidget({ message, isStreaming }: MessageWidgetProps) {
  if (message.hidden) return null;

  switch (message.type) {
    case MessageType.ERROR:
      return <ErrorMessage message={message} />;
    case MessageType.THINKING:
      return <ThinkingMessage message={message} isStreaming={isStreaming} />;
    case MessageType.TOOL_CALL:
      return <ToolCallMessage message={message} />;
    case MessageType.TOOL_RESULT:
      return <ToolResultMessage message={message} />;
    default:
      break;
  }

  switch (message.role) {
    case MessageRole.USER:
      return <UserMessage message={message} />;
    case MessageRole.ASSISTANT:
      return <AssistantMessage message={message} isStreaming={isStreaming} />;
    case MessageRole.SYSTEM:
      return <SystemMessage message={message} />;
    default:
      return <DefaultMessage message={message} />;
  }
}

function UserMessage({ message }: { message: Message }) {
  return (
    <div className="orchid-msg orchid-msg-user px-4 py-3 rounded-md">
      {message.content}
    </div>
  );
}

function AssistantMessage({
  message,
  isStreaming,
}: {
  message: Message;
  isStreaming?: boolean;
}) {
  if (!message.content && !isStreaming) return null;
  return (
    <div className="orchid-msg orchid-msg-assistant px-1 py-1">
      {message.content ? <MarkdownContent content={message.content} /> : null}
    </div>
  );
}

function ThinkingMessage({
  message,
  isStreaming,
}: {
  message: Message;
  isStreaming?: boolean;
}) {
  // Stay open while reasoning streams; user can still toggle.
  const [expanded, setExpanded] = useState(Boolean(isStreaming));
  const [userToggled, setUserToggled] = useState(false);
  const panelId = useId();
  const toggle = useCallback(() => {
    setUserToggled(true);
    setExpanded((prev) => !prev);
  }, []);
  const collapse = useCallback(() => {
    setUserToggled(true);
    setExpanded(false);
  }, []);
  const content = message.content || (message.thinking ?? '');
  // Mock shows "Thought 936ms" — estimate from content length when no duration field
  const durationLabel = useMemo(() => {
    if (isStreaming) return null;
    const ms = estimateThoughtDurationMs(content);
    return ms != null ? formatDurationMs(ms) : null;
  }, [content, isStreaming]);

  useEffect(() => {
    if (isStreaming && !userToggled) {
      setExpanded(true);
    }
  }, [isStreaming, userToggled]);

  return (
    <div
      className={`orchid-thought ${isStreaming ? 'thought-block-streaming' : ''}`}
    >
      <button
        type="button"
        className="orchid-thought-title"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span className="inline-flex items-center gap-1.5">
          {isStreaming ? (
            <Spinner size="xs" aria-hidden />
          ) : (
            <Icon name="alertCircle" size={12} />
          )}
          {isStreaming ? 'Thinking…' : `Thought${durationLabel ? ` ${durationLabel}` : ''}`}
        </span>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
      </button>
      {expanded && (
        <div
          id={panelId}
          className="orchid-thought-content"
          onClick={collapse}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              collapse();
            }
          }}
          role="button"
          tabIndex={0}
          title="Click to collapse"
        >
          {content}
        </div>
      )}
    </div>
  );
}

function ToolCallMessage({ message }: { message: Message }) {
  const block = useMemo((): ToolBlock => {
    const toolName = message.tool_calls?.[0]?.function?.name ?? message.name ?? 'unknown';
    const args = message.tool_calls?.[0]?.function?.arguments ?? message.content ?? '';
    return {
      id: message.tool_call_id ?? message.id,
      toolName,
      status: 'completed',
      partialArgs: '',
      args,
      result: null,
      error: null,
      toolResult: null,
      startedAt: message.timestamp,
      finishedAt: message.timestamp,
    };
  }, [message]);

  return <ToolCallBlock block={block} />;
}

function ToolResultMessage({ message }: { message: Message }) {
  const block = useMemo((): ToolBlock => {
    const isError = Boolean(message.is_error);
    return {
      id: message.tool_call_id ?? message.id,
      toolName: message.name ?? 'tool',
      status: isError ? 'failed' : 'completed',
      partialArgs: '',
      args: '',
      result: isError ? null : message.content,
      error: isError ? message.content : null,
      toolResult: message.tool_result,
      startedAt: message.timestamp,
      finishedAt: message.timestamp,
    };
  }, [message]);

  return <ToolCallBlock block={block} />;
}

function ErrorMessage({ message }: { message: Message }) {
  return (
    <Alert
      tone="error"
      icon="alertCircle"
      className="orchid-error-banner"
    >
      <div className="min-w-0 flex-1 orchid-error-body">
        <div className="orchid-error-title">Error</div>
        <div className="orchid-error-message">{message.content}</div>
      </div>
    </Alert>
  );
}

function SystemMessage({ message }: { message: Message }) {
  return (
    <div className="orchid-msg-system">{message.content}</div>
  );
}

function DefaultMessage({ message }: { message: Message }) {
  return (
    <div className="orchid-msg orchid-msg-assistant">{message.content}</div>
  );
}
