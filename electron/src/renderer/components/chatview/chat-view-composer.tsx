/**
 * The strip under the transcript: staged messages, the composer, and the status
 * footer. Each maps its slice of shell state onto an already-memoized
 * presentation component, so streamed tokens never re-render a sibling.
 */
import { Footer } from '../Footer';
import { InputArea } from '../InputArea';
import { MessageQueue } from '../MessageQueue';
import { DeferredSurface } from '../deferred-surface';
import type { ComponentProps } from 'react';
import type { CommandContext, SessionSummary } from '../../../shared/types/ipc-boundary';
import type { UseChatReturn } from '../../hooks/useChat';
import type { UseMessageQueueReturn } from '../../hooks/useMessageQueue';
import type { UseSessionReturn } from '../../hooks/useSession';
import type { UseTrustSendReplayReturn } from '../../hooks/useTrustSendReplay';
import type { UseChatViewComposerReturn } from './use-chat-view-composer';
import type { UseChatViewConfigReturn } from './use-chat-view-config';
import type { UseChatViewModelsReturn } from './use-chat-view-models';

export interface ChatViewComposerProps {
  /** False while a full-window surface owns presentation. */
  isVisible: boolean;
  /** Remount key that drops the composer draft. */
  composerDraftKey: number;
  chat: UseChatReturn;
  session: UseSessionReturn;
  models: UseChatViewModelsReturn;
  config: UseChatViewConfigReturn;
  messageQueue: UseMessageQueueReturn;
  composer: UseChatViewComposerReturn;
  trustSend: UseTrustSendReplayReturn;
  commandContext: CommandContext;
  sessions: SessionSummary[];
  workspaceBound: boolean;
  canPickProjectDir: boolean;
  onPickProjectDir?: () => void;
  onOpenProviders: () => void;
  hasRunningSubagents: boolean;
  /** ChatView keeps this subtree mounted while the Subagent View owns focus. */
  isViewActive: boolean;
}

/** Queued follow-ups (next-request / chain-end) staged above the composer. */
function buildQueueProps(
  messageQueue: UseMessageQueueReturn,
): ComponentProps<typeof MessageQueue> {
  return {
    queue: messageQueue.queue,
    editingId: messageQueue.editingId,
    onRemove: messageQueue.removeFromQueue,
    onReorder: messageQueue.reorderQueue,
    onStartEditing: messageQueue.startEditing,
    onUpdateEditingText: messageQueue.updateEditingText,
    onFinishEditing: messageQueue.finishEditing,
    onCancelEditing: messageQueue.cancelEditing,
    onChangeTrigger: messageQueue.changeTrigger,
  };
}

/** Thinking text not yet billed to a step, rounded to the footer's granularity. */
function unaccountedThinkingChars(chat: UseChatReturn): number | undefined {
  return Math.floor(chat.streamingUnaccountedThinkingChars / 500) * 500 || undefined;
}

export function ChatViewComposer({
  isVisible,
  composerDraftKey,
  chat,
  session,
  models,
  config,
  messageQueue,
  composer,
  trustSend,
  commandContext,
  sessions,
  workspaceBound,
  canPickProjectDir,
  onPickProjectDir,
  onOpenProviders,
  hasRunningSubagents,
  isViewActive,
}: ChatViewComposerProps) {
  const activeSession = session.activeSession;
  const sessionId = activeSession?.id ?? null;
  const composerProps: ComponentProps<typeof InputArea> = {
    sessionId,
    status: chat.status,
    model: models.providerPickerValue,
    modelLabels: models.providerModelLabels,
    modelDetails: models.providerModelDetails,
    interruptState: chat.interruptState,
    onSend: composer.handleSend,
    onCancel: chat.cancel,
    onQueue: composer.handleQueue,
    commandContext,
    sessions,
    currentTheme: config.currentTheme,
    currentPersonality: config.currentPersonality,
    personalityNames: config.personalityNames,
    workspaceBound,
    providerAvailable: models.providerAvailable,
    modelSelected: models.modelSelected,
    onOpenProviders,
    onPickProjectDir: canPickProjectDir ? onPickProjectDir : undefined,
    isViewActive,
    hasRunningSubagents,
    draftRestore: trustSend.draftRestore,
  };
  const footerProps: ComponentProps<typeof Footer> = {
    isVisible,
    streamStartTime: chat.streamStartTime,
    isStreaming: chat.status === 'streaming',
    interruptState: chat.interruptState,
    usage: chat.usage,
    maxContext: models.maxContext,
    messages: chat.messages,
    streamingThinkingChars: unaccountedThinkingChars(chat),
    model: models.providerPickerValue,
    modelLabels: models.providerModelLabels,
    modelDetails: models.providerModelDetails,
    commandContext,
    sessionId,
    reasoningEffortOverride: activeSession?.reasoningEffortOverride ?? null,
    serviceTierOverride: activeSession?.tierOverride ?? null,
    permissionMode: activeSession?.permissionMode ?? null,
  };

  return (
    <>
      <MessageQueue {...buildQueueProps(messageQueue)} />
      <InputArea key={composerDraftKey} {...composerProps} />
      <DeferredSurface isVisible={isVisible}>
        <Footer {...footerProps} />
      </DeferredSurface>
    </>
  );
}
