/**
 * MessageWidget — renders a single message based on its role/type.
 *
 * Uses DaisyUI components for styling.
 */
import { useState, useCallback, useMemo } from 'react';
import type { Message } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';
import { MarkdownContent } from './MarkdownContent';
import { LiveCommandInline } from './ToolWidgets/LiveCommandInline';

interface MessageWidgetProps {
  message: Message;
  isStreaming?: boolean;
}

// Regex matching Python's _BACKGROUND_CMD_RE for background command tool results.
// Parses: <background_command id="N" command="..." description="..." />
const BG_CMD_RE =
  /<background_command\s+id="(\d+)"[^>]*command="([^"]*)"[^>]*description="([^"]*)"[^>]*\/>/;

function parseBackgroundCommand(content: string): {
  commandId: number;
  command: string;
  description: string;
} | null {
  const match = BG_CMD_RE.exec(content);
  if (!match) return null;
  return {
    commandId: parseInt(match[1], 10),
    command: match[2],
    description: match[3],
  };
}

export function MessageWidget({ message, isStreaming }: MessageWidgetProps) {
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

function UserMessage({ message }: { message: Message }) {
  return (
    <div className="chat chat-end">
      <div className="chat-header">
        You
        <time className="text-xs opacity-50 ml-1">
          {new Date(message.timestamp).toLocaleTimeString()}
        </time>
      </div>
      <div className="chat-bubble chat-bubble-primary">{message.content}</div>
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
  return (
    <div className="chat chat-start">
      <div className="chat-header">
        Assistant
        <time className="text-xs opacity-50 ml-1">
          {new Date(message.timestamp).toLocaleTimeString()}
        </time>
      </div>
      <div className="chat-bubble chat-bubble-secondary">
        <MarkdownContent content={message.content} />
        {isStreaming && <span className="loading loading-dots loading-xs ml-1" />}
      </div>
    </div>
  );
}

function ThinkingMessage({ message }: { message: Message }) {
  return (
    <div className="chat chat-start">
      <div className="chat-header">Thinking</div>
      <div className="chat-bubble chat-bubble-accent opacity-70 italic">{message.content}</div>
    </div>
  );
}

function ToolCallMessage({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

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
    <div className="collapse collapse-arrow bg-base-200">
      <input type="checkbox" checked={expanded} onChange={toggle} />
      <div className="collapse-title text-sm font-medium">
        ⚙️ {toolName}
      </div>
      <div className="collapse-content">
        <pre className="text-xs overflow-x-auto p-2 bg-base-300 rounded">{formattedArgs}</pre>
      </div>
    </div>
  );
}

function ToolResultMessage({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  // Check if this tool result is a background command
  const bgCmd = useMemo(() => parseBackgroundCommand(message.content), [message.content]);

  if (bgCmd) {
    return (
      <LiveCommandInline
        commandId={bgCmd.commandId}
        commandText={bgCmd.command}
        description={bgCmd.description}
      />
    );
  }

  const content = message.content;
  const isLong = content.length > 500;
  const displayContent = isLong && !showAll ? content.slice(0, 500) + '...' : content;

  return (
    <div className="collapse collapse-arrow bg-base-200">
      <input type="checkbox" checked={expanded} onChange={toggle} />
      <div className="collapse-title text-sm font-medium">
        Tool Result
      </div>
      <div className="collapse-content">
        <pre className="text-xs overflow-x-auto p-2 bg-base-300 rounded whitespace-pre-wrap">{displayContent}</pre>
        {isLong && !showAll && (
          <button className="btn btn-link btn-xs mt-2" onClick={(e) => { e.stopPropagation(); setShowAll(true); }}>
            Show more
          </button>
        )}
      </div>
    </div>
  );
}

function ErrorMessage({ message }: { message: Message }) {
  return (
    <div className="chat chat-start">
      <div className="chat-header">Error</div>
      <div className="chat-bubble chat-bubble-error">
        ⚠️ {message.content}
      </div>
    </div>
  );
}

function SystemMessage({ message }: { message: Message }) {
  return (
    <div className="text-center text-xs opacity-50 my-2">
      {message.content}
    </div>
  );
}

function DefaultMessage({ message }: { message: Message }) {
  return (
    <div className="chat chat-start">
      <div className="chat-bubble">{message.content}</div>
    </div>
  );
}
