/**
 * Chat IPC registration — the Electron boundary for the chat turn pipeline.
 *
 * U5: every handler here is a thin forwarder over the unified host protocol.
 * The turn lifecycle itself lives in `host/chat/*` and is reached through the
 * embedded local host's `HostClient` (`host/routing.ts`), so the local machine
 * exercises exactly the same protocol a remote `orchid-agent` daemon serves.
 */
import { BrowserWindow, ipcMain } from 'electron';
import {
  subscribeBackgroundProcessChanges,
} from '../tools/process/background-store';
import { getSessionManager } from '../session/singleton';
import { IPC_CHANNELS, type ChatSessionSnapshot, type ChatCompactResult } from '../../shared/types/ipc';
import {
  bgCommandControlRequestSchema,
  bgCommandListRequestSchema,
  bgCommandSendInputRequestSchema,
  bgCommandSnapshotRequestSchema,
} from '../../shared/types/ipc-schemas';
import { isEmbeddedLocalHostRunning } from '../host/local-host';
import { hostRequest } from './host-request';
import { clearAllChatHistory } from '../host/chat/history';
import { chatCancelSchema, chatCompactSchema, chatQueueNextSchema, chatSendSchema, chatSnapshotSchema, chatStopSchema } from './payload-schemas';
import {
  activeAgents,
  agentGenerations,
  draftEnsureByWindow,
  sessionsStarting,
} from '../host/chat/state';
import {
  disposeActiveAgent,
} from '../host/chat/abort';

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

/** Register chat IPC boundaries; the turn lifecycle lives in `host/chat/send.ts`. */
export function registerChatIPC(): void {
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (event, payload: unknown) => {
    const parsed = chatSendSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid chat:send payload: ${parsed.error.message}`);
    }
    return hostRequest(String(event.sender.id), IPC_CHANNELS.CHAT_SEND, parsed.data);
  });

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SNAPSHOT,
    async (event, payload: unknown): Promise<ChatSessionSnapshot | null> => {
      const parsed = chatSnapshotSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        throw new Error(`Invalid chat:snapshot payload: ${parsed.error.message}`);
      }
      return hostRequest<ChatSessionSnapshot | null>(
        String(event.sender.id),
        IPC_CHANNELS.CHAT_SNAPSHOT,
        parsed.data,
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.CHAT_STOP, async (event, payload: unknown) => {
    const parsed = chatStopSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid chat:stop payload: ${parsed.error.message}`);
    return hostRequest(String(event.sender.id), IPC_CHANNELS.CHAT_STOP, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_QUEUE_NEXT, async (event, payload: unknown) => {
    const parsed = chatQueueNextSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid chat:queue_next payload: ${parsed.error.message}`);
    await hostRequest(String(event.sender.id), IPC_CHANNELS.CHAT_QUEUE_NEXT, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_COMPACT, async (event, payload: unknown): Promise<ChatCompactResult> => {
    const parsed = chatCompactSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid chat:compact payload: ${parsed.error.message}`);
    return hostRequest<ChatCompactResult>(
      String(event.sender.id),
      IPC_CHANNELS.CHAT_COMPACT,
      parsed.data,
    );
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL, async (event, payload: unknown) => {
    const parsed = chatCancelSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid chat:cancel payload: ${parsed.error.message}`);
    return hostRequest(String(event.sender.id), IPC_CHANNELS.CHAT_CANCEL, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_SNAPSHOT, async (event, payload: unknown) => {
    const parsed = bgCommandSnapshotRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid bgcmd:snapshot payload: ${parsed.error.message}`);
    }
    return hostRequest(String(event.sender.id), IPC_CHANNELS.BG_CMD_SNAPSHOT, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_LIST, async (event, payload: unknown) => {
    const parsed = bgCommandListRequestSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid bgcmd:list payload: ${parsed.error.message}`);
    }
    return hostRequest(String(event.sender.id), IPC_CHANNELS.BG_CMD_LIST, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_SEND_INPUT, async (event, payload: unknown) => {
    const parsed = bgCommandSendInputRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid bgcmd:send_input payload: ${parsed.error.message}`);
    }
    return hostRequest(String(event.sender.id), IPC_CHANNELS.BG_CMD_SEND_INPUT, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_TERMINATE, async (event, payload: unknown) => {
    const parsed = bgCommandControlRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid bgcmd:terminate payload: ${parsed.error.message}`);
    }
    return hostRequest(String(event.sender.id), IPC_CHANNELS.BG_CMD_TERMINATE, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_RELEASE_INPUT, async (event, payload: unknown) => {
    const parsed = bgCommandControlRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid bgcmd:release_input payload: ${parsed.error.message}`);
    }
    return hostRequest(String(event.sender.id), IPC_CHANNELS.BG_CMD_RELEASE_INPUT, parsed.data);
  });

  // Fallback only: once the embedded local host is running, its HostServer
  // owns bgcmd:changed delivery (per-connection, through the client broadcast).
  if (!isEmbeddedLocalHostRunning()) {
    removeBgCommandChangeListener ??= subscribeBackgroundProcessChanges((sessionId) => {
      if (sessionId) broadcastBgCommandChanged(sessionId);
    });
  }
}

/** Unregister chat IPC handlers (for cleanup/testing). */
export function unregisterChatIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SEND);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_CANCEL);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_QUEUE_NEXT);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_STOP);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_COMPACT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_SEND_INPUT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_TERMINATE);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_RELEASE_INPUT);
  if (!isEmbeddedLocalHostRunning()) {
    removeBgCommandChangeListener?.();
    removeBgCommandChangeListener = null;
  }
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
