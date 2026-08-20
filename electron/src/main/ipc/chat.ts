/** Chat IPC registration and small boundary handlers. */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { z } from 'zod';
import { getSubagentManager } from '../tools';
import {
  getBackgroundStore,
  subscribeBackgroundProcessChanges,
} from '../tools/process/background-store';
import { getForegroundLiveRegistry } from '../tools/process/foreground-live';
import { SEND_INPUT_MAX_TEXT_LENGTH } from '../tools/process/send-input';
import { getSessionManager } from '../session/singleton';
import { IPC_CHANNELS, type ChatSessionSnapshot, type ChatCompactResult } from '../../shared/types/ipc';
import { ChainStatus, lastChainError } from '../../shared/types/chain';
import { flattenSessionMessages } from '../../shared/types/session';
import { getProjectTrustState } from '../project/trust';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { clearAllChatHistory } from './chat-history';
import { chatCancelSchema, chatCompactSchema, chatQueueNextSchema, chatSendSchema, chatSnapshotSchema, chatStopSchema } from './payload-schemas';
import { requestNextRequestStop } from './next-request-stop';
import { completeSessionActivity } from './session-activity';
import {
  activeAgents,
  agentGenerations,
  draftEnsureByWindow,
  sessionsStarting,
} from './chat/state';
import { sendChatState, sendTurnEvent, webContentsForWindowId } from './chat/events';
import { snapshotForAgent } from './chat/snapshot';
import { appendLiveTailMessages, persistTurnConversation, turnMessagesFromAgent } from './chat/persist';
import {
  discardDeletedSessionRuntime,
  disposeActiveAgent,
  forceAbortSession,
  forceStopSession,
} from './chat/abort';
import { startChatTurn } from './chat/send';
import { compactSessionNow } from './chat/compaction';
import { triggerInterruptedTurnAutoName } from './chat/title';
import type { AgentContext } from '../agents/xstate/agent-machine';

export { getActiveMainTurnWindowId, getLiveChatSnapshot } from './chat/snapshot';
export {
  activeSessionsForProviderConnection,
  forceAbortChat,
  forceAbortMainTurn,
  stopActiveProviderConnectionTurns,
} from './chat/abort';
export type { ForceAbortMainTurnOptions } from './chat/abort';
export { ensureActiveSession } from './chat/session';
export {
  discardDeletedSessionRuntime,
  forceAbortSession,
  forceStopSession,
  webContentsForWindowId,
};

const BG_CMD_SNAPSHOT_MAX_LAST_N = 1000;

/**
 * Discriminated snapshot target: exactly one of `commandId` (background store)
 * or `toolCallId` (foreground live registry). Zero or both targets reject.
 */
const bgCommandSnapshotSchema = z
  .object({
    commandId: z.number().int().positive().optional(),
    toolCallId: z.string().min(1).optional(),
    lastN: z.number().int().positive().max(BG_CMD_SNAPSHOT_MAX_LAST_N).optional(),
    sessionId: z.string().uuid().optional(),
    includeTail: z.boolean().optional(),
  })
  .refine(
    (data) => (data.commandId !== undefined) !== (data.toolCallId !== undefined),
    { message: 'Provide exactly one of commandId or toolCallId' },
  );

const bgCommandListSchema = z.object({
  sessionId: z.string().uuid().optional(),
});

const bgCommandSendInputSchema = z.object({
  commandId: z.number().int().positive(),
  // Cap stdin writes at the boundary; parity with the agent send_input tool.
  text: z.string().max(SEND_INPUT_MAX_TEXT_LENGTH),
  sessionId: z.string().uuid().optional(),
});

/** Shared shape for bgcmd:terminate and bgcmd:release_input. */
const bgCommandControlSchema = z.object({
  commandId: z.number().int().positive(),
  sessionId: z.string().uuid().optional(),
});

/**
 * Payload-then-active-session convention shared by every bgcmd handler: an
 * explicit sessionId wins, else the calling window's active session.
 */
function resolveBgCommandSessionId(
  requestedSessionId: string | undefined,
  event: IpcMainInvokeEvent,
): string | null {
  return requestedSessionId
    ?? getSessionManager().getActive(String(event.sender.id))?.id
    ?? null;
}

function broadcastBgCommandChanged(sessionId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      try {
        const active = getSessionManager().getActive(String(win.webContents.id));
        if (!active || active.id !== sessionId) continue;
      } catch {
        continue;
      }
      win.webContents.send(IPC_CHANNELS.BG_CMD_CHANGED, { sessionId });
    } catch (err) {
      console.debug('broadcastBgCommandChanged send failed (non-fatal):', err);
    }
  }
}

let removeBgCommandChangeListener: (() => void) | null = null;

/** Register chat IPC boundaries; the turn lifecycle lives in `chat/send.ts`. */
export function registerChatIPC(): void {
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (event, payload: unknown) => {
    const parsed = chatSendSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid chat:send payload: ${parsed.error.message}`);
    }
    return startChatTurn(event.sender, parsed.data);
  });

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SNAPSHOT,
    async (event, payload: unknown): Promise<ChatSessionSnapshot | null> => {
      const parsed = chatSnapshotSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        throw new Error(`Invalid chat:snapshot payload: ${parsed.error.message}`);
      }
      const windowId = String(event.sender.id);
      const sessionId = parsed.data.sessionId ?? getSessionManager().getActive(windowId)?.id;
      if (!sessionId) return null;
      const session = getSessionManager().getSession(sessionId);
      if (!session) return null;
      const liveAgent = activeAgents.get(sessionId);
      const live = liveAgent && !liveAgent.finalized ? snapshotForAgent(liveAgent) : null;
      return {
        sessionId,
        messages: liveAgent && live ? [...liveAgent.messages] : flattenSessionMessages(session),
        live,
        lastChainError: live ? null : lastChainError(session.chains),
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.CHAT_STOP, async (_event, payload: unknown) => {
    const parsed = chatStopSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid chat:stop payload: ${parsed.error.message}`);
    return { status: forceStopSession(parsed.data.sessionId) ? 'stopped' : 'no_active_stream' };
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_QUEUE_NEXT, async (_event, payload: unknown) => {
    const parsed = chatQueueNextSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid chat:queue_next payload: ${parsed.error.message}`);
    requestNextRequestStop(parsed.data.sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_COMPACT, async (event, payload: unknown): Promise<ChatCompactResult> => {
    const parsed = chatCompactSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid chat:compact payload: ${parsed.error.message}`);
    const windowId = String(event.sender.id);
    const sessionId = parsed.data.sessionId ?? getSessionManager().getActive(windowId)?.id;
    if (!sessionId) {
      return { status: 'nothing_to_compact', sessionId: '', detail: 'No active session to compact.' };
    }
    const session = getSessionManager().getSession(sessionId);
    if (!session) {
      return { status: 'nothing_to_compact', sessionId, detail: 'Session not found.' };
    }
    const boundCwd = session.cwd?.trim();
    if (!boundCwd || getProjectTrustState(boundCwd) !== 'trusted') {
      return { status: 'nothing_to_compact', sessionId, detail: 'The project folder for this session is not trusted.' };
    }
    const runtime = getProjectRuntimeRegistry().get(boundCwd);
    const selection = session.selection ?? runtime.config.default_model;
    if (!selection) {
      return { status: 'nothing_to_compact', sessionId, detail: 'A provider connection and model are required before compacting.' };
    }
    return compactSessionNow(sessionId, runtime, selection);
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL, async (event, payload: unknown) => {
    const webContents: WebContents = event.sender;
    const windowId = String(webContents.id);
    const parsed = chatCancelSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid chat:cancel payload: ${parsed.error.message}`);
    const sessionId = parsed.data.sessionId ?? getSessionManager().getActive(windowId)?.id;
    if (!sessionId) return { status: 'no_active_stream' };
    const existing = activeAgents.get(sessionId);
    if (!existing) return { status: 'no_active_stream' };
    const streamWebContents = webContentsForWindowId(existing.windowId) ?? webContents;
    const interruptState = existing.interruptActor.getSnapshot().value as
      | 'idle'
      | 'confirmAgent'
      | 'confirmSubagents';
    if (interruptState === 'idle') {
      existing.interruptActor.send({ type: 'INTERRUPT' });
      return { status: 'confirming' };
    }
    if (interruptState === 'confirmAgent') {
      getBackgroundStore().terminateSession(sessionId);
      getForegroundLiveRegistry().dropSession(sessionId);
      existing.agentCancelled = true;
      const context = existing.actor.getSnapshot().context as AgentContext;
      existing.actor.send({ type: 'CANCEL' });
      if (!existing.finalized) {
        existing.finalized = true;
        const partial = context.response ?? '';
        const thinking = context.thinking ?? '';
        const usage = context.usage ?? null;
        appendLiveTailMessages(existing.turnMessages, existing, context, { placeholderWhenEmpty: true });
        if (thinking.length > existing.thinkingCommittedLength) existing.thinkingCommittedLength = thinking.length;
        if (partial.length > existing.responseCommittedLength) existing.responseCommittedLength = partial.length;
        const terminalMessages = turnMessagesFromAgent(existing);
        const fullHistory = [...existing.messages, ...existing.turnMessages];
        persistTurnConversation(
          sessionId, fullHistory, terminalMessages, ChainStatus.INTERRUPTED,
          existing.agent, existing.selection, streamWebContents,
        );
        existing.messages = fullHistory;
        // Interrupted turns still name the session from what was exchanged so far.
        triggerInterruptedTurnAutoName(existing, fullHistory);
        completeSessionActivity(
          sessionId,
          getSessionManager().getActive(existing.windowId)?.id !== sessionId,
        );
        sendTurnEvent(streamWebContents, existing, IPC_CHANNELS.CHAT_DONE, {
          type: 'done', response: partial, messages: terminalMessages, interrupted: true, usage,
        });
        sendChatState(streamWebContents, existing, {
          state: 'idle', error: null, interruptState: 'confirmSubagents', cwd: existing.cwd,
        });
      }
      existing.interruptActor.send({ type: 'INTERRUPT' });
      return { status: 'confirming_subagents' };
    }
    if (interruptState === 'confirmSubagents') {
      getBackgroundStore().terminateSession(sessionId);
      getForegroundLiveRegistry().dropSession(sessionId);
      getSubagentManager().cancelRunning(sessionId);
      disposeActiveAgent(sessionId, existing);
      sendChatState(streamWebContents, existing, {
        state: 'idle', error: null, interruptState: 'idle', cwd: existing.cwd,
      });
      return { status: 'cancelled' };
    }
    return { status: 'no_active_stream' };
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_SNAPSHOT, async (event, payload: unknown) => {
    const parsed = bgCommandSnapshotSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid bgcmd:snapshot payload: ${parsed.error.message}`);
    const { commandId, toolCallId, lastN, sessionId: requestedSessionId, includeTail } = parsed.data;
    const sessionId = resolveBgCommandSessionId(requestedSessionId, event);
    if (!sessionId) return { found: false };
    const includeTailEffective = includeTail !== false;
    const lines = lastN ?? 50;
    if (commandId !== undefined) {
      // Session-privileged visibility: any agent scope within the session.
      const entry = getBackgroundStore().get(commandId);
      if (!entry || entry.sessionId !== sessionId) return { found: false };
      return {
        found: true,
        tail: includeTailEffective ? entry.buffer.getTail(lines) : '',
        exitCode: entry.exitCode,
        running: entry.exitCode === null,
        interactive: entry.interactive,
        owner: entry.owner,
        command: entry.command,
        description: entry.description || undefined,
        agentScopeId: entry.agentScopeId,
        createdAt: entry.createdAt,
      };
    }
    const liveEntry = getForegroundLiveRegistry().get(toolCallId!);
    if (!liveEntry || liveEntry.sessionId !== sessionId) return { found: false };
    const tail = includeTailEffective
      ? getForegroundLiveRegistry().snapshotForSession(toolCallId!, lines, sessionId)?.tail ?? ''
      : '';
    return {
      found: true,
      tail,
      exitCode: liveEntry.exitCode,
      running: liveEntry.exitCode === null,
      interactive: false,
      owner: 'AGENT',
      command: liveEntry.command,
      description: liveEntry.command,
      agentScopeId: liveEntry.agentScopeId,
      createdAt: liveEntry.startedAt,
    };
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_LIST, async (event, payload: unknown) => {
    const parsed = bgCommandListSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid bgcmd:list payload: ${parsed.error.message}`);
    const sessionId = resolveBgCommandSessionId(parsed.data.sessionId, event);
    if (!sessionId) return [];
    const scopeNames = new Map<string, string>();
    for (const state of getSubagentManager().getStates(sessionId)) {
      scopeNames.set(state.id, state.name);
    }
    const items = getBackgroundStore()
      .list()
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => ({
        id: entry.id,
        command: entry.command,
        description: entry.description,
        interactive: entry.interactive,
        owner: entry.owner,
        agentScopeId: entry.agentScopeId,
        scopeName: entry.agentScopeId === 'main'
          ? 'main'
          : scopeNames.get(entry.agentScopeId) ?? entry.agentScopeId,
        running: entry.exitCode === null,
        exitCode: entry.exitCode,
        createdAt: entry.createdAt,
        lastOutputAt: entry.lastOutputAt,
      }));
    // Running commands first, newest first within each group.
    items.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
    return items;
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_SEND_INPUT, async (event, payload: unknown) => {
    const parsed = bgCommandSendInputSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid bgcmd:send_input payload: ${parsed.error.message}`);
    const { commandId, text, sessionId: requestedSessionId } = parsed.data;
    const sessionId = resolveBgCommandSessionId(requestedSessionId, event);
    if (!sessionId) return { ok: false, reason: 'not_found' };
    const store = getBackgroundStore();
    // Session-privileged: any agent scope within the session is reachable.
    const entry = store.get(commandId);
    if (!entry || entry.sessionId !== sessionId) return { ok: false, reason: 'not_found' };
    if (!entry.interactive) return { ok: false, reason: 'not_interactive' };
    if (entry.exitCode !== null) return { ok: false, reason: 'exited' };
    // TOCTOU fix: take ownership before the async write so an agent send_input
    // cannot interleave between the write and the flip. Roll back on failure.
    const prevOwner = entry.owner;
    const prevLastUserInputAt = entry.lastUserInputAt;
    const took = store.takeOwnership(commandId);
    if (!took) return { ok: false, reason: 'not_found' };
    let sent: boolean;
    try {
      sent = await store.send(commandId, text);
    } catch {
      sent = false;
    }
    if (!sent) {
      const current = store.get(commandId);
      if (current) {
        current.owner = prevOwner;
        current.lastUserInputAt = prevLastUserInputAt;
      }
      return { ok: false, reason: 'write_failed' };
    }
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_TERMINATE, async (event, payload: unknown) => {
    const parsed = bgCommandControlSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid bgcmd:terminate payload: ${parsed.error.message}`);
    const { commandId, sessionId: requestedSessionId } = parsed.data;
    const sessionId = resolveBgCommandSessionId(requestedSessionId, event);
    if (!sessionId) return { ok: false, reason: 'not_found' };
    const entry = getBackgroundStore().get(commandId);
    if (!entry || entry.sessionId !== sessionId) return { ok: false, reason: 'not_found' };
    getBackgroundStore().terminate(commandId);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_RELEASE_INPUT, async (event, payload: unknown) => {
    const parsed = bgCommandControlSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid bgcmd:release_input payload: ${parsed.error.message}`);
    const { commandId, sessionId: requestedSessionId } = parsed.data;
    const sessionId = resolveBgCommandSessionId(requestedSessionId, event);
    if (!sessionId) return { ok: false };
    const entry = getBackgroundStore().get(commandId);
    if (!entry || entry.sessionId !== sessionId) return { ok: false };
    return { ok: getBackgroundStore().releaseOwnership(commandId) };
  });

  removeBgCommandChangeListener ??= subscribeBackgroundProcessChanges((sessionId) => {
    if (sessionId) broadcastBgCommandChanged(sessionId);
  });
}

/** Unregister chat IPC handlers (for cleanup/testing). */
export function unregisterChatIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SEND);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_CANCEL);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_QUEUE_NEXT);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_STOP);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_SEND_INPUT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_TERMINATE);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_RELEASE_INPUT);
  removeBgCommandChangeListener?.();
  removeBgCommandChangeListener = null;
  for (const [sessionId, agent] of [...activeAgents.entries()]) {
    agent.agentCancelled = true;
    agent.finalized = true;
    disposeActiveAgent(sessionId, agent);
  }
  activeAgents.clear();
  sessionsStarting.clear();
  draftEnsureByWindow.clear();
  agentGenerations.clear();
  clearAllChatHistory();
}
