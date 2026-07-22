/**
 * ask_question IPC — bridge pending questions between tool handler and renderer.
 *
 * Subscribes to QuestionStore events and forwards them to all renderer windows.
 * Handles answer/cancel invoke channels from the renderer.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { QuestionAnswer } from '../tools/ask-question/store';
import { questionStore } from '../tools/ask-question/store';
import { forceAbortSession } from './chat';

interface QuestionAskedPayload {
  sessionId: string;
  toolCallId: string;
  questions: unknown[];
}

function onQuestionAsked({ sessionId, toolCallId, questions }: QuestionAskedPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.ASK_QUESTION_ASKED, { sessionId, toolCallId, questions });
    }
  }
}

/** Register ask_question IPC handlers and store event forwarding. */
export function registerAskQuestionIPC(): void {
  questionStore.on('question-asked', onQuestionAsked);

  ipcMain.handle(
    IPC_CHANNELS.ASK_QUESTION_ANSWER,
    (_event, payload: { toolCallId: string; answers: QuestionAnswer[] }) => {
      const ok = questionStore.answer(payload.toolCallId, payload.answers);
      return { ok };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.ASK_QUESTION_CANCEL,
    (_event, payload: { toolCallId: string }) => {
      const entry = questionStore.get(payload.toolCallId);
      const ok = questionStore.cancel(payload.toolCallId);
      if (ok && entry) {
        setImmediate(() => forceAbortSession(entry.sessionId));
      }
      return { ok };
    },
  );
}

/** Unregister ask_question IPC handlers and store event forwarding. */
export function unregisterAskQuestionIPC(): void {
  questionStore.off('question-asked', onQuestionAsked);
  ipcMain.removeHandler(IPC_CHANNELS.ASK_QUESTION_ANSWER);
  ipcMain.removeHandler(IPC_CHANNELS.ASK_QUESTION_CANCEL);
}
