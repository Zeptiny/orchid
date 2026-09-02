/**
 * Composer send path: the UI gates a send must clear before the agent starts,
 * retry of the last user message, queueing, and queue auto-fire.
 */
import { useCallback } from 'react';
import { useQueueAutoFire } from '../../hooks/useQueueAutoFire';
import { emitOrchidEvent } from '../../utils/events';
import type { UseChatReturn } from '../../hooks/useChat';
import type { UseMessageQueueReturn } from '../../hooks/useMessageQueue';
import type { UseTrustSendReplayReturn } from '../../hooks/useTrustSendReplay';
import type { UseSessionReturn } from '../../hooks/useSession';
import type { ModelSelection } from '../../../shared/types/provider';
import type { Notify } from '../../utils/notify';

export interface UseChatViewComposerOptions {
  readonly chat: UseChatReturn;
  readonly session: UseSessionReturn;
  readonly messageQueue: UseMessageQueueReturn;
  readonly trustSend: UseTrustSendReplayReturn;
  readonly notify: Notify;
  readonly canPickProjectDir: boolean;
  readonly activeMachineLabel: string;
  readonly workspaceBound: boolean;
  readonly providerAvailable: boolean;
  readonly modelSelected: boolean;
  readonly preferredSelection: ModelSelection | null;
  readonly onPickProjectDir: () => Promise<void>;
}

export interface UseChatViewComposerReturn {
  readonly handleSend: (message: string) => Promise<boolean>;
  readonly handleRetry: () => Promise<void>;
  readonly handleQueue: (text: string) => void;
}

/** The last user turn a retry can re-send, or null when there is none. */
function findRetryableMessage(chat: UseChatReturn) {
  return [...chat.messages]
    .reverse()
    .find((message) => message.role === 'user' && !message.hidden && Boolean(message.content?.trim()));
}

/**
 * A send resolves `true` only when a turn actually started. Queue autofire
 * relies on the distinction: gate failures restore the consumed batch instead
 * of silently dropping it (and never reject — rejection is not the signal).
 */
export function useChatViewComposer({
  chat,
  session,
  messageQueue,
  trustSend,
  notify,
  canPickProjectDir,
  activeMachineLabel,
  workspaceBound,
  providerAvailable,
  modelSelected,
  preferredSelection,
  onPickProjectDir,
}: UseChatViewComposerOptions): UseChatViewComposerReturn {
  const activeSessionId = session.activeSession?.id ?? null;

  const handleSend = useCallback(
    async (message: string): Promise<boolean> => {
      // UI gate (R3): reinforce main-process unbound_workspace rejection.
      if (chat.isSwitchingSession) return false;
      if (!workspaceBound) {
        notify(
          canPickProjectDir
            ? 'Choose a project folder before sending a message.'
            : `Choose a project folder on ${activeMachineLabel} before sending a message.`,
          'warning',
        );
        if (canPickProjectDir) void onPickProjectDir();
        return false;
      }
      const missingProvider = !providerAvailable;
      if (missingProvider) {
        notify('Connect a provider in Settings before sending a message.', 'warning');
        emitOrchidEvent('orchid:open-settings', { tab: 'providers' });
        return false;
      }
      const modelNotReady = preferredSelection == null || !modelSelected;
      if (modelNotReady) {
        notify('Select a ready connection and model before sending a message.', 'warning');
        return false;
      }
      return chat.send(message, {
        ...(preferredSelection ? { model: preferredSelection } : {}),
        ...(activeSessionId
          ? { sessionId: activeSessionId }
          : { draftGeneration: session.draftGeneration }),
      });
    },
    [
      chat.send,
      chat.isSwitchingSession,
      activeSessionId,
      session.draftGeneration,
      workspaceBound,
      providerAvailable,
      modelSelected,
      preferredSelection,
      notify,
      onPickProjectDir,
      canPickProjectDir,
      activeMachineLabel,
    ],
  );

  // Late-bind handleSend for the trust-grant replay.
  trustSend.sendRef.current = handleSend;

  const handleRetry = useCallback(async () => {
    // Re-send the last user message after an error
    const lastUser = findRetryableMessage(chat);
    if (!lastUser?.content) return;
    chat.clearError();
    await handleSend(lastUser.content);
  }, [chat, handleSend]);

  const handleQueue = useCallback(
    (text: string) => {
      const trigger = messageQueue.addToQueue(text);
      // Only next-request messages stop the chain early; chain-end messages
      // queue without signaling so the current run continues to its natural end.
      const signalsEarlyStop = trigger === 'next-request' && chat.status === 'streaming';
      if (signalsEarlyStop && activeSessionId) {
        void window.orchid?.chat?.queueNext({ sessionId: activeSessionId })?.catch(() => {});
      }
    },
    [messageQueue.addToQueue, chat.status, activeSessionId],
  );

  useQueueAutoFire(
    chat.status,
    messageQueue.consumeNext,
    trustSend.restoreQueueBatch,
    messageQueue.editingId,
    handleSend,
  );

  return { handleSend, handleRetry, handleQueue };
}
