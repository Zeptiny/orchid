/**
 * MessageWidget — renders a single message based on its role/type.
 *
 * Flat chat (no chat-bubble component). Thought blocks use disclosure
 * chrome; tool call/result messages fall back to ToolCallBlock for edge cases.
 * ChatStream normally converts them into ToolBlocks for consistent ordering.
 */
import { memo, useState, useCallback, useMemo, useEffect, useId } from 'react';
import type { Message } from '../../shared/types/message';
import { MessageRole, MessageType, ThinkingArtifactKind } from '../../shared/types/message';
import { formatDurationMs, useElapsedMs } from '../utils/elapsed';
import type { ToolBlock } from '../hooks/useChat';
import { MarkdownContent } from './MarkdownContent';
import { Icon } from './Icon';
import { ToolCallBlock } from './ToolCallBlock';
import { Alert } from './ui/Alert';
import { CollapsibleRegion } from './ui/CollapsibleRegion';
import { Spinner } from './ui/Spinner';

interface MessageWidgetProps {
  message: Message;
  isStreaming?: boolean;
  /**
   * Measured segment timing for live thinking (anchors the elapsed timer at
   * the model's actual reasoning start, not when the view mounted). Absent
   * for committed history — those messages carry thinking_duration_ms.
   */
  thinkingTiming?: { startedAt: string | null; endedAt: string | null };
}

export const MessageWidget = memo(function MessageWidget({ message, isStreaming, thinkingTiming }: MessageWidgetProps) {
  if (message.hidden) return null;

  switch (message.type) {
    case MessageType.ERROR:
      return <ErrorMessage message={message} />;
    case MessageType.THINKING:
      return <ThinkingMessage message={message} isStreaming={isStreaming} timing={thinkingTiming} />;
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
});

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
      {message.content ? (
        <MarkdownContent content={message.content} />
      ) : null}
    </div>
  );
}

/** Opaque/redacted thinking persists no readable text: render an indicator. */
function OpaqueThinkingMessage({ tokenCount }: { tokenCount?: number }) {
  return (
    <div className="orchid-thought">
      <div className="orchid-thought-title" aria-disabled="true">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="alertCircle" size={12} />
          {tokenCount != null ? `Thought (${tokenCount} tokens)` : 'Thought'}
        </span>
      </div>
    </div>
  );
}

function ThinkingMessage({
  message,
  isStreaming,
  timing,
}: {
  message: Message;
  isStreaming?: boolean;
  timing?: { startedAt: string | null; endedAt: string | null };
}) {
  // Open for live reasoning, then close when that segment settles.
  const [expanded, setExpanded] = useState(Boolean(isStreaming));
  const panelId = useId();
  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);
  const collapse = useCallback(() => {
    setExpanded(false);
  }, []);
  const content = message.content || (message.thinking ?? '');
  const payload = message.thinking_payload;
  const isOpaque = !content && !!payload && payload.kind !== ThinkingArtifactKind.TEXT;

  useEffect(() => {
    setExpanded(Boolean(isStreaming));
  }, [isStreaming]);

  // Anchor on measured timing: the wire stamps when reasoning actually began,
  // so a view mounted mid-thought (or a subagent page opened late) shows the
  // true elapsed value instead of restarting from zero.
  const measuredStartedAt = timing?.startedAt ?? null;
  const measuredEndedAt = timing?.endedAt ?? null;
  const liveElapsedMs = useElapsedMs({
    startedAt: isStreaming ? measuredStartedAt : null,
    endedAt: measuredEndedAt,
  });
  const settledElapsedMs = useMemo(() => {
    if (isStreaming) return null;
    if (message.thinking_duration_ms != null) return message.thinking_duration_ms;
    if (measuredStartedAt && measuredEndedAt) {
      const span = Date.parse(measuredEndedAt) - Date.parse(measuredStartedAt);
      if (Number.isFinite(span) && span >= 0) return span;
    }
    return null;
  }, [isStreaming, message.thinking_duration_ms, measuredStartedAt, measuredEndedAt]);
  const durationLabel = useMemo(() => {
    const ms = isStreaming ? liveElapsedMs : settledElapsedMs;
    return ms != null ? formatDurationMs(ms) : null;
  }, [isStreaming, liveElapsedMs, settledElapsedMs]);

  if (isOpaque && !isStreaming) {
    return <OpaqueThinkingMessage tokenCount={payload?.reasoningTokenCount} />;
  }

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
          {`${isStreaming ? 'Thinking…' : 'Thought'}${durationLabel ? ` ${durationLabel}` : ''}`}
        </span>
        <Icon
          name="chevronDown"
          size={12}
          className={`orchid-disclosure-chevron ${expanded ? 'is-open' : ''}`}
        />
      </button>
      <CollapsibleRegion open={expanded} id={panelId}>
        <div
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
      </CollapsibleRegion>
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
      agentProjection: null,
      toolResult: null,
      startedAt: message.timestamp,
      finishedAt: message.timestamp,
    };
  }, [message]);

  return <ToolCallBlock block={block} />;
}

function ToolResultMessage({ message }: { message: Message }) {
  const block = useMemo((): ToolBlock => {
    const status = message.tool_result?.status;
    return {
      id: message.tool_call_id ?? message.id,
      toolName: message.name ?? 'tool',
      status: status === 'error' ? 'failed' : status ?? 'completed',
      partialArgs: '',
      args: '',
      agentProjection: message.content,
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
