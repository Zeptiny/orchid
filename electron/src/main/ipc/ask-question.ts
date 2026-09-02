/**
 * ask_question IPC — bridge pending questions between tool handler and renderer.
 *
 * Question delivery is fully unified (U9): asked/settled events flow as host
 * protocol events — `host/server.ts` forwards them to connected clients and
 * `ipc/host-broadcast.ts` pushes them to windows. A question whose owner
 * client is not connected stays PENDING on the host; the store's timeout
 * (the same `approval_timeout` boundary approvals use) settles it CANCELLED —
 * fail-closed, never auto-answered — and a 0 timeout waits forever.
 *
 * This module only registers the answer/cancel invoke channels, which a
 * renderer that still owns the selected session may call.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { hostRequest } from './host-request';
import { questionStore } from '../tools/ask-question/store';
import {
  askQuestionAnswerSchema,
  askQuestionCancelSchema,
} from './payload-schemas';

/** Register ask_question IPC handlers. */
export function registerAskQuestionIPC(): void {
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

/** Unregister ask_question IPC handlers and settle pending questions (shutdown). */
export function unregisterAskQuestionIPC(): void {
  questionStore.cleanupAll();
  ipcMain.removeHandler(IPC_CHANNELS.ASK_QUESTION_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.ASK_QUESTION_ANSWER);
  ipcMain.removeHandler(IPC_CHANNELS.ASK_QUESTION_CANCEL);
}
