/**
 * MessageWidget — renders a single message based on its role/type.
 *
 * Supports:
 * - User messages: right-aligned, distinct background
 * - Assistant messages: left-aligned, markdown rendering
 * - Thinking messages: italic, dimmed
 * - Tool calls: collapsible, shows tool name + args
 * - Tool results: collapsible, shows result content
 * - Error messages: red accent, error icon
 *
 * Interaction states: loading (streaming cursor), partial content.
 */
import { useState, useCallback } from 'react';
import type { Message } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';
import { MarkdownContent } from './MarkdownContent';

// ── Props ────────────────────────────────────────────────────────────────────

interface MessageWidgetProps {
  message: Message;
  /** Whether this is the currently streaming message. */
  isStreaming?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export function MessageWidget({ message, isStreaming }: MessageWidgetProps) {
  // Skip hidden messages
  if (message.hidden) return null;

  switch (message.type) {
    case MessageType.ERROR:
      return <ErrorMessage message={message} />;
    case MessageType.THINKING:
      return <ThinkingMessage message={message} />;
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

// ── User Message ─────────────────────────────────────────────────────────────

function UserMessage({ message }: { message: Message }) {
  return (
    <div className="message message-user">
      <div className="message-role">You</div>
      <div className="message-content">{message.content}</div>
    </div>
  );
}

// ── Assistant Message ────────────────────────────────────────────────────────

function AssistantMessage({
  message,
  isStreaming,
}: {
  message: Message;
  isStreaming?: boolean;
}) {
  return (
    <div className="message message-assistant">
      <div className="message-role">Assistant</div>
      <div className="message-content">
        <MarkdownContent content={message.content} />
        {isStreaming && <span className="streaming-cursor" />}
      </div>
    </div>
  );
}

// ── Thinking Message ─────────────────────────────────────────────────────────

function ThinkingMessage({ message }: { message: Message }) {
  return (
    <div className="message message-thinking">
      <div className="message-role">Thinking</div>
      <div className="message-content">{message.content}</div>
    </div>
  );
}

// ── Tool Call Message ────────────────────────────────────────────────────────

function ToolCallMessage({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  // Extract tool call info from message
  const toolCalls = message.tool_calls ?? [];
  const toolName = toolCalls[0]?.function?.name ?? message.name ?? 'unknown';
  const toolArgs = toolCalls[0]?.function?.arguments ?? message.content;

  let formattedArgs: string;
  try {
    formattedArgs = JSON.stringify(JSON.parse(toolArgs), null, 2);
  } catch {
    formattedArgs = toolArgs;
  }

  return (
    <div className="message message-tool-call">
      <div className="tool-call-header" onClick={toggle} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(); }}>
        <span className="tool-call-icon">&#9881;</span>
        <span className="tool-call-name">{toolName}</span>
        <span className={`tool-call-toggle ${expanded ? 'expanded' : ''}`}>&#9654;</span>
      </div>
      {expanded && (
        <div className="tool-call-body">{formattedArgs}</div>
      )}
    </div>
  );
}

// ── Tool Result Message ──────────────────────────────────────────────────────

function ToolResultMessage({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const content = message.content;
  const isLong = content.length > 500;
  const displayContent = isLong && !showAll ? content.slice(0, 500) + '...' : content;

  return (
    <div className="message message-tool-result">
      <div className="tool-result-header" onClick={toggle} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(); }}>
        <span className="tool-result-label">Tool Result</span>
        <span className={`tool-result-toggle ${expanded ? 'expanded' : ''}`}>&#9654;</span>
      </div>
      {expanded && (
        <div className="tool-result-body">
          {displayContent}
          {isLong && !showAll && (
            <button className="show-more-btn" onClick={(e) => { e.stopPropagation(); setShowAll(true); }}>
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Error Message ────────────────────────────────────────────────────────────

function ErrorMessage({ message }: { message: Message }) {
  return (
    <div className="message message-error">
      <div className="message-role">Error</div>
      <div className="message-content">
        <span className="error-icon">&#9888;</span>
        {message.content}
      </div>
    </div>
  );
}

// ── System Message ───────────────────────────────────────────────────────────

function SystemMessage({ message }: { message: Message }) {
  return (
    <div className="message" style={{ alignSelf: 'center', opacity: 0.6, fontSize: 'var(--font-size-xs)' }}>
      <div className="message-content">{message.content}</div>
    </div>
  );
}

// ── Default Message ──────────────────────────────────────────────────────────

function DefaultMessage({ message }: { message: Message }) {
  return (
    <div className="message message-assistant">
      <div className="message-content">{message.content}</div>
    </div>
  );
}
