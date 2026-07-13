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
  ChatCancelMessage,
  ChatStopMessage,
  ChatSnapshotMessage,
  ChatChunkEvent,
  ChatThinkingEvent,
  ChatStateEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatUsageEvent,
  ChatToolCallStartEvent,
  ChatToolCallDeltaEvent,
  ChatToolCallUpdateEvent,
  ConfigSaveMessage,
  ProviderConnectionCreateMessage,
  ProviderConnectionUpdateMessage,
  ProviderSubmitApiKeyMessage,
  ProviderConnectionIdMessage,
  ProviderDisconnectMessage,
  ProviderStatusRefreshMessage,
  SessionLoadMessage,
  SessionDeleteMessage,
  SessionRenamedEvent,
  SessionCreatedEvent,
  SessionUpdatedEvent,
  SessionChangeCwdMessage,
  SessionSetWorkspaceMessage,
  SessionWorkspaceChangedEvent,
  SessionTodosChangedEvent,
  SessionActivityChangedEvent,
  SessionMarkSeenMessage,
  WorkspaceInfo,
  ToolExecuteMessage,
  AgentSpawnMessage,
  AgentSaveMessage,
  DefinitionDeleteMessage,
  DefinitionRevealMessage,
  PersonalitySaveMessage,
  SkillSaveMessage,
  RAGIndexMessage,
  RAGIndexProgress,
  ASTIndexMessage,
  ASTIndexProgress,
  BgCommandSnapshotRequest,
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

    cancel: (message?: ChatCancelMessage) =>
      invoke(IPC_CHANNELS.CHAT_CANCEL, message ?? {}),

    stop: (message: ChatStopMessage) =>
      invoke(IPC_CHANNELS.CHAT_STOP, message),

    snapshot: (message?: ChatSnapshotMessage) =>
      invoke(IPC_CHANNELS.CHAT_SNAPSHOT, message ?? {}),

    onChunk: (callback: (event: ChatChunkEvent) => void) =>
      on(IPC_CHANNELS.CHAT_CHUNK, (...args) => callback(args[0] as ChatChunkEvent)),

    onThinking: (callback: (event: ChatThinkingEvent) => void) =>
      on(IPC_CHANNELS.CHAT_THINKING, (...args) => callback(args[0] as ChatThinkingEvent)),

    onState: (callback: (event: ChatStateEvent) => void) =>
      on(IPC_CHANNELS.CHAT_STATE, (...args) => callback(args[0] as ChatStateEvent)),

    onDone: (callback: (event: ChatDoneEvent) => void) =>
      on(IPC_CHANNELS.CHAT_DONE, (...args) => callback(args[0] as ChatDoneEvent)),

    onError: (callback: (event: ChatErrorEvent) => void) =>
      on(IPC_CHANNELS.CHAT_ERROR, (...args) => callback(args[0] as ChatErrorEvent)),

    onUsage: (callback: (event: ChatUsageEvent) => void) =>
      on(IPC_CHANNELS.CHAT_USAGE, (...args) => callback(args[0] as ChatUsageEvent)),

    onToolCallStart: (callback: (event: ChatToolCallStartEvent) => void) =>
      on(IPC_CHANNELS.CHAT_TOOL_CALL_START, (...args) => callback(args[0] as ChatToolCallStartEvent)),

    onToolCallDelta: (callback: (event: ChatToolCallDeltaEvent) => void) =>
      on(IPC_CHANNELS.CHAT_TOOL_CALL_DELTA, (...args) => callback(args[0] as ChatToolCallDeltaEvent)),

    onToolCallUpdate: (callback: (event: ChatToolCallUpdateEvent) => void) =>
      on(IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, (...args) => callback(args[0] as ChatToolCallUpdateEvent)),
  },

  config: {
    get: () =>
      invoke(IPC_CHANNELS.CONFIG_GET),

    diagnostics: () =>
      invoke(IPC_CHANNELS.CONFIG_DIAGNOSTICS),

    save: (updates: ConfigSaveMessage) =>
      invoke(IPC_CHANNELS.CONFIG_SAVE, updates),

    modelMetadata: (modelId: string) =>
      invoke(IPC_CHANNELS.CONFIG_MODEL_METADATA, modelId),

    listPersonalities: () =>
      invoke(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES),
  },

  providers: {
    list: () =>
      invoke(IPC_CHANNELS.PROVIDERS_LIST),

    create: (message: ProviderConnectionCreateMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_CREATE, message),

    update: (message: ProviderConnectionUpdateMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_UPDATE, message),

    submitApiKey: (message: ProviderSubmitApiKeyMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY, message),

    validate: (message: ProviderConnectionIdMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_VALIDATE, message),

    disable: (message: ProviderConnectionIdMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_DISABLE, message),

    enable: (message: ProviderConnectionIdMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_ENABLE, message),

    disconnect: (message: ProviderDisconnectMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_DISCONNECT, message),

    modelList: (message?: ProviderConnectionIdMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_MODEL_LIST, message),

    refreshStatus: (message: ProviderStatusRefreshMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_STATUS_REFRESH, message),
  },

  session: {
    list: () =>
      invoke(IPC_CHANNELS.SESSION_LIST),

    load: (id: SessionLoadMessage) =>
      invoke(IPC_CHANNELS.SESSION_LOAD, id),

    create: () =>
      invoke(IPC_CHANNELS.SESSION_CREATE),

    clearActive: () =>
      invoke(IPC_CHANNELS.SESSION_CLEAR_ACTIVE),

    delete: (id: SessionDeleteMessage) =>
      invoke(IPC_CHANNELS.SESSION_DELETE, id),

    rename: (id: string, name: string) =>
      invoke(IPC_CHANNELS.SESSION_RENAME, { id, name }),

    changeModel: (id, selection, modelLabel) =>
      invoke(IPC_CHANNELS.SESSION_CHANGE_MODEL, { id, selection, modelLabel }),

    getWorkspace: () =>
      invoke<WorkspaceInfo>(IPC_CHANNELS.SESSION_GET_WORKSPACE),

    pickProjectDir: () =>
      invoke<WorkspaceInfo>(IPC_CHANNELS.SESSION_PICK_PROJECT_DIR),

    setWorkspace: (message: SessionSetWorkspaceMessage) =>
      invoke<WorkspaceInfo>(IPC_CHANNELS.SESSION_SET_WORKSPACE, message),

    changeCwd: (message: SessionChangeCwdMessage) =>
      invoke(IPC_CHANNELS.SESSION_CHANGE_CWD, message),

    listActivity: () =>
      invoke(IPC_CHANNELS.SESSION_ACTIVITY_LIST),

    markSeen: (message: SessionMarkSeenMessage) =>
      invoke(IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN, message),

    onRenamed: (callback: (event: SessionRenamedEvent) => void) =>
      on(IPC_CHANNELS.SESSION_RENAMED, (...args) => callback(args[0] as SessionRenamedEvent)),

    onCreated: (callback: (event: SessionCreatedEvent) => void) =>
      on(IPC_CHANNELS.SESSION_CREATED, (...args) => callback(args[0] as SessionCreatedEvent)),

    onUpdated: (callback: (event: SessionUpdatedEvent) => void) =>
      on(IPC_CHANNELS.SESSION_UPDATED, (...args) => callback(args[0] as SessionUpdatedEvent)),

    onWorkspaceChanged: (callback: (event: SessionWorkspaceChangedEvent) => void) =>
      on(IPC_CHANNELS.SESSION_WORKSPACE_CHANGED, (...args) =>
        callback(args[0] as SessionWorkspaceChangedEvent),
      ),

    onSubagentsChanged: (callback: () => void) =>
      on(IPC_CHANNELS.SESSION_SUBAGENTS_CHANGED, () => callback()),

    onTodosChanged: (callback: (event: SessionTodosChangedEvent) => void) =>
      on(IPC_CHANNELS.SESSION_TODOS_CHANGED, (...args) =>
        callback(args[0] as SessionTodosChangedEvent),
      ),

    onActivityChanged: (callback: (event: SessionActivityChangedEvent) => void) =>
      on(IPC_CHANNELS.SESSION_ACTIVITY_CHANGED, (...args) =>
        callback(args[0] as SessionActivityChangedEvent),
      ),
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

    save: (message: AgentSaveMessage) =>
      invoke(IPC_CHANNELS.AGENT_SAVE, message),

    delete: (message: DefinitionDeleteMessage) =>
      invoke(IPC_CHANNELS.AGENT_DELETE, message),
  },

  definitions: {
    list: () =>
      invoke(IPC_CHANNELS.DEFINITIONS_LIST),

    reveal: (message: DefinitionRevealMessage) =>
      invoke(IPC_CHANNELS.DEFINITION_REVEAL, message),
  },

  skill: {
    save: (message: SkillSaveMessage) =>
      invoke(IPC_CHANNELS.SKILL_SAVE, message),

    delete: (message: DefinitionDeleteMessage) =>
      invoke(IPC_CHANNELS.SKILL_DELETE, message),
  },

  personality: {
    save: (message: PersonalitySaveMessage) =>
      invoke(IPC_CHANNELS.PERSONALITY_SAVE, message),

    delete: (message: DefinitionDeleteMessage) =>
      invoke(IPC_CHANNELS.PERSONALITY_DELETE, message),
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

    indexState: () =>
      invoke(IPC_CHANNELS.RAG_INDEX_STATE),

    onProgress: (callback: (progress: RAGIndexProgress) => void) =>
      on(IPC_CHANNELS.RAG_PROGRESS, (...args) => callback(args[0] as RAGIndexProgress)),
  },

  ast: {
    status: () =>
      invoke(IPC_CHANNELS.AST_STATUS),

    index: (message?: ASTIndexMessage) =>
      invoke(IPC_CHANNELS.AST_INDEX, message),

    indexState: () =>
      invoke(IPC_CHANNELS.AST_INDEX_STATE),

    onProgress: (callback: (progress: ASTIndexProgress) => void) =>
      on(IPC_CHANNELS.AST_PROGRESS, (...args) => callback(args[0] as ASTIndexProgress)),
  },

  bgCmd: {
    snapshot: (request: BgCommandSnapshotRequest) =>
      invoke(IPC_CHANNELS.BG_CMD_SNAPSHOT, request),
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
