import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { z } from 'zod';
import type { AnalyticsTimeRange } from '../../shared/types/analytics';
import {
  getOverview,
  getSessions,
  getSessionDetail,
  getModels,
  getTools,
  getSubagents,
} from '../providers/accounting/analytics-queries';
import { runContextQuery } from '../providers/accounting/analytics-query-runner';

const timeRangeSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
}).optional();

const analyticsParamsSchema = z.object({
  timeRange: timeRangeSchema,
}).strict().optional();

const sessionsParamsSchema = z.object({
  limit: z.number().int().positive().max(10000).optional(),
  offset: z.number().int().nonnegative().max(1_000_000).optional(),
  timeRange: timeRangeSchema,
}).optional();

const sessionDetailParamsSchema = z.object({
  sessionId: z.string().uuid(),
  timeRange: timeRangeSchema,
});

const contextParamsSchema = z.object({
  sessionId: z.string().uuid().optional(),
  timeRange: timeRangeSchema,
}).optional();

export function registerAnalyticsIPC(): void {
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_OVERVIEW, async (_event, payload?: unknown) => {
    const parsed = analyticsParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid analytics:overview payload');
    const timeRange = parsed.data?.timeRange as AnalyticsTimeRange | undefined;
    try {
      return getOverview(timeRange);
    } catch (error) {
      console.error('[analytics] Overview query failed', { error });
      throw new Error(`Analytics overview query failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SESSIONS, async (_event, payload?: unknown) => {
    const parsed = sessionsParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid analytics:sessions payload');
    const limit = parsed.data?.limit;
    const offset = parsed.data?.offset;
    const timeRange = parsed.data?.timeRange as AnalyticsTimeRange | undefined;
    try {
      return getSessions(limit, timeRange, offset);
    } catch (error) {
      console.error('[analytics] Sessions query failed', { error });
      throw new Error(`Analytics sessions query failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SESSION_DETAIL, async (_event, payload: unknown) => {
    const parsed = sessionDetailParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid analytics:session_detail payload');
    try {
      return getSessionDetail(parsed.data.sessionId, parsed.data.timeRange as AnalyticsTimeRange | undefined);
    } catch (error) {
      console.error('[analytics] Session detail query failed', { error });
      throw new Error(`Analytics session detail query failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_MODELS, async (_event, payload?: unknown) => {
    const parsed = analyticsParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid analytics:models payload');
    const timeRange = parsed.data?.timeRange as AnalyticsTimeRange | undefined;
    try {
      return getModels(timeRange);
    } catch (error) {
      console.error('[analytics] Models query failed', { error });
      throw new Error(`Analytics models query failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_TOOLS, async (_event, payload?: unknown) => {
    const parsed = analyticsParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid analytics:tools payload');
    const timeRange = parsed.data?.timeRange as AnalyticsTimeRange | undefined;
    try {
      return getTools(timeRange);
    } catch (error) {
      console.error('[analytics] Tools query failed', { error });
      throw new Error(`Analytics tools query failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SUBAGENTS, async (_event, payload?: unknown) => {
    const parsed = analyticsParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid analytics:subagents payload');
    const timeRange = parsed.data?.timeRange as AnalyticsTimeRange | undefined;
    try {
      return getSubagents(timeRange);
    } catch (error) {
      console.error('[analytics] Subagents query failed', { error });
      throw new Error(`Analytics subagents query failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_CONTEXT, async (_event, payload?: unknown) => {
    const parsed = contextParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid analytics:context payload');
    const sessionId = parsed.data?.sessionId;
    const timeRange = parsed.data?.timeRange as AnalyticsTimeRange | undefined;
    try {
      return await runContextQuery(sessionId, timeRange);
    } catch (error) {
      console.error('[analytics] Context query failed', { error });
      throw new Error(`Analytics context query failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
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
