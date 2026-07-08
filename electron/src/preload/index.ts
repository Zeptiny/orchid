/**
 * Preload script — typed API bridge between main and renderer.
 *
 * Exposes `window.orchid` via contextBridge with strict channel allowlists.
 * Each method is an ipcRenderer.invoke wrapper; event listeners use ipcRenderer.on.
 *
 * Security:
 * - contextIsolation: true (enforced in BrowserWindow)
 * - nodeIntegration: false (enforced in BrowserWindow)
 * - Only allowed channels can be invoked/subscribed
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  ALLOWED_INVOKE_CHANNELS,
  ALLOWED_EVENT_CHANNELS,
  IPC_CHANNELS,
} from '../shared/types/ipc';
import type {
  OrchidAPI,
  ChatSendMessage,
  ChatChunkEvent,
  ChatStateEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ConfigSaveMessage,
  SessionLoadMessage,
  SessionDeleteMessage,
  ToolExecuteMessage,
  AgentSpawnMessage,
  RAGIndexMessage,
  ASTIndexMessage,
  UpdaterProgress,
  UpdaterErrorEvent,
} from '../shared/types/ipc';
import type { UpdaterState } from '../shared/types/ipc';

// ── Security helpers ─────────────────────────────────────────────────────────

function assertAllowedInvoke(channel: string): void {
  if (!ALLOWED_INVOKE_CHANNELS.includes(channel)) {
    throw new Error(`IPC channel '${channel}' is not allowed for invoke`);
  }
}

function assertAllowedEvent(channel: string): void {
  if (!ALLOWED_EVENT_CHANNELS.includes(channel)) {
    throw new Error(`IPC channel '${channel}' is not allowed for events`);
  }
}

// ── Typed invoke wrapper ─────────────────────────────────────────────────────

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  assertAllowedInvoke(channel);
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

// ── Typed event listener wrapper ─────────────────────────────────────────────

function on(channel: string, callback: (...args: unknown[]) => void): () => void {
  assertAllowedEvent(channel);
  const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
    callback(...args);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// ── Build the API surface ────────────────────────────────────────────────────

const orchidAPI: OrchidAPI = {
  chat: {
    send: (message: ChatSendMessage) =>
      invoke(IPC_CHANNELS.CHAT_SEND, message),

    cancel: () =>
      invoke(IPC_CHANNELS.CHAT_CANCEL),

    onChunk: (callback: (event: ChatChunkEvent) => void) =>
      on(IPC_CHANNELS.CHAT_CHUNK, (...args) => callback(args[0] as ChatChunkEvent)),

    onState: (callback: (event: ChatStateEvent) => void) =>
      on(IPC_CHANNELS.CHAT_STATE, (...args) => callback(args[0] as ChatStateEvent)),

    onDone: (callback: (event: ChatDoneEvent) => void) =>
      on(IPC_CHANNELS.CHAT_DONE, (...args) => callback(args[0] as ChatDoneEvent)),

    onError: (callback: (event: ChatErrorEvent) => void) =>
      on(IPC_CHANNELS.CHAT_ERROR, (...args) => callback(args[0] as ChatErrorEvent)),
  },

  config: {
    get: () =>
      invoke(IPC_CHANNELS.CONFIG_GET),

    save: (updates: ConfigSaveMessage) =>
      invoke(IPC_CHANNELS.CONFIG_SAVE, updates),
  },

  session: {
    list: () =>
      invoke(IPC_CHANNELS.SESSION_LIST),

    load: (id: SessionLoadMessage) =>
      invoke(IPC_CHANNELS.SESSION_LOAD, id),

    create: () =>
      invoke(IPC_CHANNELS.SESSION_CREATE),

    delete: (id: SessionDeleteMessage) =>
      invoke(IPC_CHANNELS.SESSION_DELETE, id),

    rename: (id: string, name: string) =>
      invoke(IPC_CHANNELS.SESSION_RENAME, { id, name }),
  },

  tool: {
    execute: (message: ToolExecuteMessage) =>
      invoke(IPC_CHANNELS.TOOL_EXECUTE, message),
  },

  agent: {
    list: () =>
      invoke(IPC_CHANNELS.AGENT_LIST),

    spawn: (message: AgentSpawnMessage) =>
      invoke(IPC_CHANNELS.AGENT_SPAWN, message),
  },

  mcp: {
    status: () =>
      invoke(IPC_CHANNELS.MCP_STATUS),
  },

  rag: {
    status: () =>
      invoke(IPC_CHANNELS.RAG_STATUS),

    index: (message?: RAGIndexMessage) =>
      invoke(IPC_CHANNELS.RAG_INDEX, message),

    clear: () =>
      invoke(IPC_CHANNELS.RAG_CLEAR),
  },

  ast: {
    status: () =>
      invoke(IPC_CHANNELS.AST_STATUS),

    index: (message?: ASTIndexMessage) =>
      invoke(IPC_CHANNELS.AST_INDEX, message),
  },

  updater: {
    check: () =>
      invoke(IPC_CHANNELS.UPDATER_CHECK),

    install: () =>
      invoke(IPC_CHANNELS.UPDATER_INSTALL),

    status: () =>
      invoke(IPC_CHANNELS.UPDATER_STATUS),

    download: () =>
      invoke(IPC_CHANNELS.UPDATER_DOWNLOAD),

    onStatus: (callback: (state: UpdaterState) => void) =>
      on(IPC_CHANNELS.UPDATER_STATUS_UPDATE, (...args) => callback(args[0] as UpdaterState)),

    onProgress: (callback: (progress: UpdaterProgress) => void) =>
      on(IPC_CHANNELS.UPDATER_PROGRESS, (...args) => callback(args[0] as UpdaterProgress)),

    onError: (callback: (event: UpdaterErrorEvent) => void) =>
      on(IPC_CHANNELS.UPDATER_ERROR, (...args) => callback(args[0] as UpdaterErrorEvent)),
  },
};

// ── Expose to renderer ───────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('orchid', orchidAPI);
