/**
 * ask_question IPC — bridge pending questions between tool handler and renderer.
 *
 * Subscribes to QuestionStore events and forwards them only to renderer
 * windows currently viewing the owning session. Handles answer/cancel invoke
 * channels from a renderer that still owns that selected session.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { hostRequest } from './host-request';
import {
  questionStore,
  type QuestionSettledEvent,
} from '../tools/ask-question/store';
import {
  forceAbortMainTurn,
  getActiveMainTurnWindowId,
  webContentsForWindowId,
} from './chat';
import {
  askQuestionAnswerSchema,
  askQuestionCancelSchema,
} from './payload-schemas';

interface QuestionAskedPayload {
  sessionId: string;
  toolCallId: string;
  questions: unknown[];
}

function abortUndeliverableQuestion(sessionId: string, toolCallId: string): void {
  questionStore.cancel(toolCallId);
  forceAbortMainTurn(sessionId);
}

function onQuestionAsked({ sessionId, toolCallId, questions }: QuestionAskedPayload): void {
  const ownerWindowId = getActiveMainTurnWindowId(sessionId);
  if (ownerWindowId == null || !questionStore.bindOwnerWindow(toolCallId, ownerWindowId)) {
    abortUndeliverableQuestion(sessionId, toolCallId);
    return;
  }

  const ownerWebContents = webContentsForWindowId(ownerWindowId);
  if (!ownerWebContents) {
    abortUndeliverableQuestion(sessionId, toolCallId);
    return;
  }

  try {
    ownerWebContents.send(
      IPC_CHANNELS.ASK_QUESTION_ASKED,
      { sessionId, toolCallId, questions },
    );
  } catch {
    abortUndeliverableQuestion(sessionId, toolCallId);
  }
}

function onQuestionSettled({
  sessionId,
  toolCallId,
  ownerWindowId,
  result,
}: QuestionSettledEvent): void {
  if (ownerWindowId == null) return;
  const ownerWebContents = webContentsForWindowId(ownerWindowId);
  if (!ownerWebContents) return;
  try {
    ownerWebContents.send(
      IPC_CHANNELS.ASK_QUESTION_SETTLED,
      { sessionId, toolCallId, result },
    );
  } catch {
    // The store is already settled; a dead renderer must not reopen the wait.
  }
}

/** Register ask_question IPC handlers and store event forwarding. */
export function registerAskQuestionIPC(): void {
  questionStore.on('question-asked', onQuestionAsked);
  questionStore.on('question-settled', onQuestionSettled);

  ipcMain.handle(IPC_CHANNELS.ASK_QUESTION_SNAPSHOT, (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.ASK_QUESTION_SNAPSHOT);
  });

  ipcMain.handle(
    IPC_CHANNELS.ASK_QUESTION_ANSWER,
    (event, payload: unknown) => {
      const parsed = askQuestionAnswerSchema.parse(payload);
      return hostRequest(
        String(event.sender.id),
        IPC_CHANNELS.ASK_QUESTION_ANSWER,
        parsed,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.ASK_QUESTION_CANCEL,
    (event, payload: unknown) => {
      const parsed = askQuestionCancelSchema.parse(payload);
      return hostRequest(
        String(event.sender.id),
        IPC_CHANNELS.ASK_QUESTION_CANCEL,
        parsed,
      );
    },
  );
}

/** Unregister ask_question IPC handlers and store event forwarding. */
export function unregisterAskQuestionIPC(): void {
  questionStore.cleanupAll();
  questionStore.off('question-asked', onQuestionAsked);
  questionStore.off('question-settled', onQuestionSettled);
  ipcMain.removeHandler(IPC_CHANNELS.ASK_QUESTION_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.ASK_QUESTION_ANSWER);
  ipcMain.removeHandler(IPC_CHANNELS.ASK_QUESTION_CANCEL);
}
