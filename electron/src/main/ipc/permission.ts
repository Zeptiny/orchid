import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { PermissionMode } from '../../shared/types/permission';
import {
  approvalStore,
  type ApprovalSettledEvent,
} from '../permissions/approval-store';
import {
  forceAbortMainTurn,
  getActiveMainTurnWindowId,
  webContentsForWindowId,
} from './chat';
import { getSessionManager } from './session';

export const sessionPermissionOverrides = new Map<string, PermissionMode>();

const approvalAnswerSchema = z.object({
  toolCallId: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
  reason: z.string().optional(),
}).strict();

const setSessionModeSchema = z.object({
  sessionId: z.string().min(1),
  mode: z.enum(['allow', 'ask', 'decide-for-me', 'ask-when-flagged']),
}).strict();

interface ApprovalRequestedPayload {
  toolCallId: string;
  sessionId: string;
  toolName: string;
  riskClass: string;
  args: unknown;
  cwd: string;
  scope?: string;
}

function abortUndeliverableApproval(sessionId: string, toolCallId: string): void {
  approvalStore.cancel(toolCallId);
  forceAbortMainTurn(sessionId);
}

function onApprovalRequested(payload: ApprovalRequestedPayload): void {
  const { sessionId, toolCallId } = payload;
  const ownerWindowId = getActiveMainTurnWindowId(sessionId);
  if (ownerWindowId == null || !approvalStore.bindOwnerWindow(toolCallId, ownerWindowId)) {
    abortUndeliverableApproval(sessionId, toolCallId);
    return;
  }

  const ownerWebContents = webContentsForWindowId(ownerWindowId);
  if (!ownerWebContents) {
    abortUndeliverableApproval(sessionId, toolCallId);
    return;
  }

  try {
    ownerWebContents.send(IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED, payload);
  } catch {
    abortUndeliverableApproval(sessionId, toolCallId);
  }
}

function onApprovalSettled({
  sessionId,
  toolCallId,
  ownerWindowId,
  result,
}: ApprovalSettledEvent): void {
  if (ownerWindowId == null) return;
  const ownerWebContents = webContentsForWindowId(ownerWindowId);
  if (!ownerWebContents) return;
  try {
    ownerWebContents.send(
      IPC_CHANNELS.PERMISSION_APPROVAL_SETTLED,
      { sessionId, toolCallId, result },
    );
  } catch { /* noop */ }
}

function selectedSessionId(senderId: number): string | null {
  return getSessionManager().getActive(String(senderId))?.id ?? null;
}

function senderOwnsApproval(senderId: number, toolCallId: string): boolean {
  const entry = approvalStore.get(toolCallId);
  return (
    entry != null &&
    entry.ownerWindowId === String(senderId) &&
    entry.sessionId === selectedSessionId(senderId)
  );
}

export function registerPermissionIPC(): void {
  approvalStore.on('approval-requested', onApprovalRequested);
  approvalStore.on('approval-settled', onApprovalSettled);

  ipcMain.handle(IPC_CHANNELS.PERMISSION_SNAPSHOT, () => {
    return { approvals: approvalStore.getSnapshot() };
  });

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_APPROVAL_ANSWER,
    (event, payload: unknown) => {
      const parsed = approvalAnswerSchema.parse(payload);
      if (!senderOwnsApproval(event.sender.id, parsed.toolCallId)) {
        return { ok: false };
      }
      const ok = approvalStore.answer(parsed.toolCallId, parsed.decision, parsed.reason);
      return { ok };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_SET_SESSION_MODE,
    (_event, payload: unknown) => {
      const parsed = setSessionModeSchema.parse(payload);
      sessionPermissionOverrides.set(parsed.sessionId, parsed.mode);
      return { ok: true };
    },
  );
}

export function unregisterPermissionIPC(): void {
  approvalStore.cleanupAll();
  approvalStore.off('approval-requested', onApprovalRequested);
  approvalStore.off('approval-settled', onApprovalSettled);
  ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_APPROVAL_ANSWER);
  ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_SET_SESSION_MODE);
}
