import type { KeyboardEvent } from 'react';
import type { QueuedMessage, QueueTrigger } from '../hooks/useMessageQueue';
import { IconButton } from './ui/IconButton';

interface MessageQueueProps {
  queue: readonly QueuedMessage[];
  editingId: string | null;
  onRemove: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onStartEditing: (id: string) => void;
  onUpdateEditingText: (id: string, text: string) => void;
  onFinishEditing: (id: string) => void;
  onCancelEditing: (id: string) => void;
  onChangeTrigger: (id: string, trigger: QueueTrigger) => void;
}

const TRIGGER_LABEL: Record<QueueTrigger, string> = {
  'next-request': 'next req',
  'chain-end': 'chain end',
};

/**
 * MessageQueue — deferred-send messages staged above the composer.
 *
 * Renders the `useMessageQueue` queue as compact rows, each with a clickable
 * trigger badge ("next req" / "chain end"), inline edit (textarea — Enter
 * saves, Shift+Enter inserts a newline, Escape aborts), delete, and up/down
 * reorder controls.
 * Renders nothing when the queue is empty. Purely presentational: all
 * mutations flow through the callback props.
 */
export function MessageQueue({
  queue,
  editingId,
  onRemove,
  onReorder,
  onStartEditing,
  onUpdateEditingText,
  onFinishEditing,
  onCancelEditing,
  onChangeTrigger,
}: MessageQueueProps) {
  if (queue.length === 0) return null;

  return (
    <div role="list" aria-label="Queued messages" className="flex flex-col gap-1 px-3 pb-1">
      {queue.map((message, index) => (
        <QueueItem
          key={message.id}
          message={message}
          index={index}
          count={queue.length}
          editing={editingId === message.id}
          onRemove={onRemove}
          onReorder={onReorder}
          onStartEditing={onStartEditing}
          onUpdateEditingText={onUpdateEditingText}
          onFinishEditing={onFinishEditing}
          onCancelEditing={onCancelEditing}
          onChangeTrigger={onChangeTrigger}
        />
      ))}
    </div>
  );
}

interface QueueItemProps {
  message: QueuedMessage;
  index: number;
  count: number;
  editing: boolean;
  onRemove: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onStartEditing: (id: string) => void;
  onUpdateEditingText: (id: string, text: string) => void;
  onFinishEditing: (id: string) => void;
  onCancelEditing: (id: string) => void;
  onChangeTrigger: (id: string, trigger: QueueTrigger) => void;
}

function QueueItem({
  message,
  index,
  count,
  editing,
  onRemove,
  onReorder,
  onStartEditing,
  onUpdateEditingText,
  onFinishEditing,
  onCancelEditing,
  onChangeTrigger,
}: QueueItemProps) {
  if (editing) {
    return (
      <div
        role="listitem"
        className="flex flex-col gap-1.5 rounded-selector border border-primary/40 bg-base-200 px-2 py-1.5"
      >
        <div className="flex items-start gap-2">
          <QueueIndex index={index} />
          <textarea
            autoFocus
            rows={3}
            value={message.text}
            aria-label="Edit queued message"
            className="w-full min-w-0 flex-1 resize-none rounded-selector border border-base-300 bg-base-100 px-2 py-1.5 text-xs leading-snug text-base-content focus:border-primary focus:outline-none"
            onChange={(event) => onUpdateEditingText(message.id, event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === 'Escape') {
                // Keep Escape from bubbling to the composer's global interrupt handler.
                event.preventDefault();
                event.stopPropagation();
                onCancelEditing(message.id);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onFinishEditing(message.id);
              }
            }}
          />
        </div>
        <div className="flex items-center justify-end gap-1">
          <TriggerBadge message={message} onChangeTrigger={onChangeTrigger} />
          <div className="flex-1" />
          <IconButton
            label="Cancel editing"
            icon="x"
            size="xs"
            variant="ghost"
            iconSize={12}
            onClick={() => onCancelEditing(message.id)}
          />
          <IconButton
            label="Save message"
            icon="check"
            size="xs"
            variant="primary"
            iconSize={12}
            onClick={() => onFinishEditing(message.id)}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      role="listitem"
      className="flex items-center gap-2 rounded-selector border border-base-300 bg-base-200 px-2 py-1.5 transition-colors hover:border-base-content/25"
    >
      <QueueIndex index={index} />
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-snug text-base-content/90 line-clamp-2">
        {message.text}
      </p>
      <TriggerBadge message={message} onChangeTrigger={onChangeTrigger} />
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          label="Move up"
          icon="chevronUp"
          size="xs"
          variant="ghost"
          iconSize={12}
          disabled={index === 0}
          onClick={() => onReorder(index, index - 1)}
        />
        <IconButton
          label="Move down"
          icon="chevronDown"
          size="xs"
          variant="ghost"
          iconSize={12}
          disabled={index === count - 1}
          onClick={() => onReorder(index, index + 1)}
        />
        <IconButton
          label="Edit message"
          icon="edit"
          size="xs"
          variant="ghost"
          iconSize={12}
          onClick={() => onStartEditing(message.id)}
        />
        <IconButton
          label="Remove from queue"
          icon="x"
          size="xs"
          variant="ghost"
          iconSize={12}
          className="text-error hover:bg-error/10"
          onClick={() => onRemove(message.id)}
        />
      </div>
    </div>
  );
}

function QueueIndex({ index }: { index: number }) {
  return (
    <span className="w-4 shrink-0 text-center font-mono text-xs text-base-content/35">
      {index + 1}
    </span>
  );
}

function TriggerBadge({
  message,
  onChangeTrigger,
}: {
  message: QueuedMessage;
  onChangeTrigger: (id: string, trigger: QueueTrigger) => void;
}) {
  const next: QueueTrigger = message.trigger === 'next-request' ? 'chain-end' : 'next-request';
  return (
    <button
      type="button"
      aria-label={`Trigger: ${TRIGGER_LABEL[message.trigger]}. Toggle to ${TRIGGER_LABEL[next]}.`}
      title={`Fires at ${TRIGGER_LABEL[message.trigger]} — click to toggle`}
      className={`shrink-0 cursor-pointer rounded-full border px-1.5 py-px text-xs font-medium leading-tight transition-colors ${
        message.trigger === 'next-request'
          ? 'border-primary/35 bg-primary/10 text-primary hover:bg-primary/20'
          : 'border-accent/35 bg-accent/10 text-accent hover:bg-accent/20'
      }`}
      onClick={() => onChangeTrigger(message.id, next)}
    >
      {TRIGGER_LABEL[message.trigger]}
    </button>
  );
}
