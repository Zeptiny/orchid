import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { z } from 'zod';
import {
  getOverview,
  getSessions,
  getSessionDetail,
  getModels,
  getTools,
  getSubagents,
  getContext,
} from '../providers/accounting/analytics-queries';

const sessionsParamsSchema = z.object({
  limit: z.number().int().positive().max(10000).optional(),
}).optional();

const sessionDetailParamsSchema = z.object({
  sessionId: z.string().min(1),
});

const contextParamsSchema = z.object({
  sessionId: z.string().min(1).optional(),
}).optional();

export function registerAnalyticsIPC(): void {
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_OVERVIEW, async () => {
    return getOverview();
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SESSIONS, async (_event, payload?: unknown) => {
    const parsed = sessionsParamsSchema.safeParse(payload);
    const limit = parsed.success ? parsed.data?.limit : undefined;
    return getSessions(limit);
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SESSION_DETAIL, async (_event, payload: unknown) => {
    const parsed = sessionDetailParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid analytics:session_detail payload');
    return getSessionDetail(parsed.data.sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_MODELS, async () => {
    return getModels();
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_TOOLS, async () => {
    return getTools();
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SUBAGENTS, async () => {
    return getSubagents();
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_CONTEXT, async (_event, payload?: unknown) => {
    const parsed = contextParamsSchema.safeParse(payload);
    const sessionId = parsed.success ? parsed.data?.sessionId : undefined;
    return getContext(sessionId);
  });
}

export function unregisterAnalyticsIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_OVERVIEW);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_SESSIONS);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_SESSION_DETAIL);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_MODELS);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_TOOLS);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_SUBAGENTS);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_CONTEXT);
}
