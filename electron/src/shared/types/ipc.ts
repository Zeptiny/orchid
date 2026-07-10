/**
 * IPC API surface types — shared between main, preload, and renderer.
 *
 * This file defines the typed contract for the contextBridge API.
 * All IPC payloads are validated with zod at the main-process boundary.
 *
 * The renderer accesses this API via `window.orchid.*`.
 */

import type { Session } from './session';
import type { Agent } from './agent';
import type { Usage } from './message';
import type {
  AgentSaveMessage,
  DefinitionDeleteMessage,
  DefinitionRevealMessage,
  DefinitionsListResult,
  ManagedAgent,
  ManagedPersonality,
  ManagedSkill,
  PersonalitySaveMessage,
  SkillSaveMessage,
} from './definitions';
import type {
  SessionSummary,
  Config,
  ModelMetadata,
  DiscoveredModel,
  MCPServerStatus,
  RAGStoreStatus,
  ASTStoreStatus,
  RAGIndexResult,
  RAGIndexProgress,
  ASTIndexResult,
  ASTIndexProgress,
  IndexRunState,
  UpdaterState,
} from './ipc-boundary';

export type {
  AgentSaveMessage,
  DefinitionDeleteMessage,
  DefinitionRevealMessage,
  DefinitionsListResult,
  ManagedAgent,
  ManagedPersonality,
  ManagedSkill,
  PersonalitySaveMessage,
  SkillSaveMessage,
  DefinitionScope,
} from './definitions';

export type {
  SessionSummary,
  Config,
  ModelMetadata,
  DiscoveredModel,
  MCPServerStatus,
  RAGStoreStatus,
  ASTStoreStatus,
  RAGIndexResult,
  RAGIndexProgress,
  ASTIndexResult,
  ASTIndexProgress,
  IndexRunState,
  UpdaterState,
} from './ipc-boundary';

// ── Chat API ─────────────────────────────────────────────────────────────────

export interface ChatSendMessage {
  /** The user's message text. */
  message: string;
  /** Optional session ID (uses active session if omitted). */
  sessionId?: string;
  /**
   * Preferred model when auto-creating a session on first send (draft mode).
   * Ignored when an active session already exists.
   */
  model?: string;
}

export interface ChatCancelMessage {
  /** Optional session ID (uses active session if omitted). */
  sessionId?: string;
}

export interface ChatChunkEvent {
  type: 'chunk';
  data: string;
}

/** Reasoning/thinking stream delta (models that emit reasoning-delta). */
export interface ChatThinkingEvent {
  type: 'thinking';
  data: string;
}

export interface ChatStateEvent {
  state: string;
  response: string;
  error: string | null;
  /** Current interrupt confirmation phase. */
  interruptState: 'idle' | 'confirmAgent' | 'confirmSubagents';
  /** Active workspace cwd (session → draft → sticky); null/undefined when unbound. */
  cwd?: string | null;
}

export interface ChatDoneEvent {
  type: 'done';
  response: string;
  /** True when the turn ended due to user Esc cancellation. */
  interrupted?: boolean;
  /** Latest token usage for the completed/interrupted turn. */
  usage?: Usage | null;
}

export type ChatErrorKind = 'stream' | 'rate-limit' | 'auth' | 'generic';

export interface ChatErrorEvent {
  type: 'error';
  error: string;
  /** Short banner title (e.g. "Authentication failed"). */
  title?: string;
  /** Classified error kind for banner actions. */
  kind?: ChatErrorKind;
}

export interface ChatUsageEvent {
  type: 'usage';
  usage: Usage;
}

export interface ChatToolCallStartEvent {
  type: 'tool_call_start';
  toolCallId: string;
  toolName: string;
}

export interface ChatToolCallDeltaEvent {
  type: 'tool_call_delta';
  toolCallId: string;
  argsDelta: string;
}

export interface ChatToolCallUpdateEvent {
  type: 'tool_call_update';
  toolCallId: string;
  toolName?: string;
  status: 'running' | 'completed' | 'failed';
  args?: string;
  result?: string;
  error?: string;
}

// ── Background Command API ────────────────────────────────────────────────

export interface BgCommandSnapshotRequest {
  /** The background command ID. */
  commandId: number;
  /** Optional last N lines to retrieve (default: 50). */
  lastN?: number;
}

export interface BgCommandSnapshotResult {
  /** Tail output text. */
  tail: string;
  /** Exit code (null if still running). */
  exitCode: number | null;
}

// ── Config API ───────────────────────────────────────────────────────────────

export interface ProviderRename {
  from: string;
  to: string;
}

export interface ConfigSaveMessage {
  updates: Partial<Config>;
  /** Explicit provider alias changes so keychain entries can follow renames safely. */
  providerRenames?: ProviderRename[];
}

// ── Session API ──────────────────────────────────────────────────────────────

export interface SessionLoadMessage {
  id: string;
  /**
   * When true (default), set the session as active and seed chat history.
   * When false, read-only peek from disk (todos/subagents refresh) without
   * changing the active session or chat history.
   */
  activate?: boolean;
}

export interface SessionDeleteMessage {
  id: string;
}

export interface SessionRenameMessage {
  id: string;
  name: string;
}

export interface SessionRenamedEvent {
  id: string;
  name: string;
}

export interface SessionTodosChangedEvent {
  /** Active session id when todos changed, or null if no active session. */
  sessionId: string | null;
}

/** Fired when main creates a session (e.g. first message from draft mode). */
export interface SessionCreatedEvent {
  session: Session;
}

/**
 * Fired when the active session's multi-chain state changes (start/finish turn).
 * Same payload shape as SessionCreatedEvent so the renderer can refresh chains.
 */
export type SessionUpdatedEvent = SessionCreatedEvent;

export interface SessionChangeModelMessage {
  id: string;
  model: string;
}

/** Source of the resolved workspace path. */
export type WorkspaceSource = 'draft' | 'session' | 'default' | 'unbound';

/** Coarse project-directory status (mirrors main project path helpers). */
export type WorkspaceStatus = 'unbound' | 'valid' | 'missing';

/** Resolved workspace for UI chrome and send gate. */
export interface WorkspaceInfo {
  /** Canonical absolute path when bound; null when unbound. */
  cwd: string | null;
  /** Where the path came from. */
  source: WorkspaceSource;
  /** Directory usability status. */
  status: WorkspaceStatus;
}

export interface SessionChangeCwdMessage {
  id: string;
  /** Absolute path to an existing readable directory. */
  cwd: string;
}

export interface SessionSetWorkspaceMessage {
  /** Absolute path to bind (no dialog). Used by tests and non-dialog callers. */
  cwd: string;
}

export interface SessionWorkspaceChangedEvent {
  workspace: WorkspaceInfo;
}

/** Result of chat:send (started stream or structured gate failure). */
export interface ChatSendResult {
  status: string;
  /** Human-readable error when status is not started. */
  error?: string;
  /** Machine-readable failure kind (e.g. unbound_workspace). */
  kind?: string;
}

// ── Tool API ─────────────────────────────────────────────────────────────────

export interface ToolExecuteMessage {
  name: string;
  args: unknown;
}

export interface ToolExecuteResult {
  content: string;
  isError: boolean;
}

// ── Agent API ────────────────────────────────────────────────────────────────

export interface AgentSpawnMessage {
  name: string;
  task: string;
  tier?: string;
}

export interface AgentSpawnResult {
  id: string;
  agent: Agent;
}

// ── RAG API ──────────────────────────────────────────────────────────────────

export interface RAGIndexMessage {
  /** Force re-index everything. */
  force?: boolean;
}

// ── AST API ──────────────────────────────────────────────────────────────────

export interface ASTIndexMessage {
  /** Force re-index everything. */
  force?: boolean;
}

// ── Updater API ──────────────────────────────────────────────────────────────

export interface UpdaterProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface UpdaterErrorEvent {
  error: string;
}

// ── Orchid API (the full contextBridge surface) ──────────────────────────────

export interface OrchidAPI {
  chat: {
    send: (message: ChatSendMessage) => Promise<ChatSendResult>;
    cancel: () => Promise<{ status: string }>;
    onChunk: (callback: (event: ChatChunkEvent) => void) => () => void;
    onThinking: (callback: (event: ChatThinkingEvent) => void) => () => void;
    onState: (callback: (event: ChatStateEvent) => void) => () => void;
    onDone: (callback: (event: ChatDoneEvent) => void) => () => void;
    onError: (callback: (event: ChatErrorEvent) => void) => () => void;
    onUsage: (callback: (event: ChatUsageEvent) => void) => () => void;
    onToolCallStart: (callback: (event: ChatToolCallStartEvent) => void) => () => void;
    onToolCallDelta: (callback: (event: ChatToolCallDeltaEvent) => void) => () => void;
    onToolCallUpdate: (callback: (event: ChatToolCallUpdateEvent) => void) => () => void;
  };

  config: {
    get: () => Promise<Config>;
    save: (updates: ConfigSaveMessage) => Promise<{ status: string }>;
    modelMetadata: (modelId: string) => Promise<ModelMetadata>;
    discoverModels: (alias: string, force?: boolean) => Promise<DiscoveredModel[]>;
    /** List personality names loaded from `~/.orchid/personalities/*.md`. */
    listPersonalities: () => Promise<string[]>;
  };

  session: {
    list: () => Promise<SessionSummary[]>;
    load: (id: SessionLoadMessage) => Promise<Session | null>;
    create: () => Promise<Session>;
    /**
     * Enter draft mode: clear active session, abort in-flight chat, clear
     * window history. Does not write a session file.
     */
    clearActive: () => Promise<{ status: string }>;
    delete: (id: SessionDeleteMessage) => Promise<{ status: string }>;
    rename: (id: string, name: string) => Promise<{ status: string }>;
    changeModel: (id: string, model: string) => Promise<{ status: string }>;
    /** Resolve current workspace (draft → session → sticky default → unbound). */
    getWorkspace: () => Promise<WorkspaceInfo>;
    /**
     * Native directory picker; binds draft or active session cwd and updates
     * sticky default_project_dir. Cancelled dialog returns current workspace.
     */
    pickProjectDir: () => Promise<WorkspaceInfo>;
    /**
     * Bind an absolute path without a dialog (tests / non-dialog callers).
     * Updates sticky default like an intentional pick.
     */
    setWorkspace: (message: SessionSetWorkspaceMessage) => Promise<WorkspaceInfo>;
    /** Change cwd on the active session and update sticky default. */
    changeCwd: (message: SessionChangeCwdMessage) => Promise<Session>;
    onRenamed: (callback: (event: SessionRenamedEvent) => void) => () => void;
    /** Session auto-created on first message from draft mode. */
    onCreated: (callback: (event: SessionCreatedEvent) => void) => () => void;
    /** Active session chains/todos mutated mid-chat (multi-chain turn lifecycle). */
    onUpdated: (callback: (event: SessionUpdatedEvent) => void) => () => void;
    /** Workspace draft/session/default changed. */
    onWorkspaceChanged: (callback: (event: SessionWorkspaceChangedEvent) => void) => () => void;
    /** Subagent chains persisted — refresh sidebar / chain-footer usage. */
    onSubagentsChanged: (callback: () => void) => () => void;
    /** Todo store mutated — refresh todos sidebar. */
    onTodosChanged: (callback: (event: SessionTodosChangedEvent) => void) => () => void;
  };

  tool: {
    execute: (message: ToolExecuteMessage) => Promise<ToolExecuteResult>;
  };

  agent: {
    list: () => Promise<Agent[]>;
    spawn: (message: AgentSpawnMessage) => Promise<AgentSpawnResult>;
    /** Create or update an AGENT.md under global or project scope. */
    save: (message: AgentSaveMessage) => Promise<ManagedAgent>;
    /** Delete an agent definition from the given scope. */
    delete: (message: DefinitionDeleteMessage) => Promise<{ status: string }>;
  };

  /**
   * Skills / agents / personalities management (Config UI).
   * Project scope requires a bound workspace.
   */
  definitions: {
    list: () => Promise<DefinitionsListResult>;
    reveal: (message: DefinitionRevealMessage) => Promise<{ status: string }>;
  };

  skill: {
    save: (message: SkillSaveMessage) => Promise<ManagedSkill>;
    delete: (message: DefinitionDeleteMessage) => Promise<{ status: string }>;
  };

  personality: {
    save: (message: PersonalitySaveMessage) => Promise<ManagedPersonality>;
    delete: (message: DefinitionDeleteMessage) => Promise<{ status: string }>;
  };

  mcp: {
    status: () => Promise<MCPServerStatus[]>;
  };

  rag: {
    status: () => Promise<RAGStoreStatus>;
    index: (message?: RAGIndexMessage) => Promise<RAGIndexResult>;
    clear: () => Promise<{ status: string }>;
    /** Whether a run is active + last progress (for tab remount / late join). */
    indexState: () => Promise<IndexRunState<RAGIndexProgress>>;
    /** Subscribe to live index progress (worker → main → renderer). */
    onProgress: (callback: (progress: RAGIndexProgress) => void) => () => void;
  };

  ast: {
    status: () => Promise<ASTStoreStatus>;
    index: (message?: ASTIndexMessage) => Promise<ASTIndexResult>;
    /** Whether a run is active + last progress (for tab remount / late join). */
    indexState: () => Promise<IndexRunState<ASTIndexProgress>>;
    /** Subscribe to live index progress (worker → main → renderer). */
    onProgress: (callback: (progress: ASTIndexProgress) => void) => () => void;
  };

  bgCmd: {
    snapshot: (request: BgCommandSnapshotRequest) => Promise<BgCommandSnapshotResult>;
  };

  updater: {
    check: () => Promise<UpdaterState>;
    install: () => Promise<{ status: string }>;
    status: () => Promise<UpdaterState>;
    download: () => Promise<UpdaterState>;
    onStatus: (callback: (state: UpdaterState) => void) => () => void;
    onProgress: (callback: (progress: UpdaterProgress) => void) => () => void;
    onError: (callback: (event: UpdaterErrorEvent) => void) => () => void;
  };
}

// ── IPC Channel names ────────────────────────────────────────────────────────

export const IPC_CHANNELS = {
  // Chat
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_CHUNK: 'chat:chunk',
  CHAT_THINKING: 'chat:thinking',
  CHAT_STATE: 'chat:state',
  CHAT_DONE: 'chat:done',
  CHAT_ERROR: 'chat:error',
  CHAT_USAGE: 'chat:usage',
  CHAT_TOOL_CALL_START: 'chat:tool_call_start',
  CHAT_TOOL_CALL_DELTA: 'chat:tool_call_delta',
  CHAT_TOOL_CALL_UPDATE: 'chat:tool_call_update',

  // Config
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  CONFIG_MODEL_METADATA: 'config:model_metadata',
  CONFIG_DISCOVER_MODELS: 'config:discover_models',
  CONFIG_LIST_PERSONALITIES: 'config:list_personalities',

  // Session
  SESSION_LIST: 'session:list',
  SESSION_LOAD: 'session:load',
  SESSION_CREATE: 'session:create',
  /** Clear active session without creating a file (draft / new chat). */
  SESSION_CLEAR_ACTIVE: 'session:clear_active',
  SESSION_DELETE: 'session:delete',
  SESSION_RENAME: 'session:rename',
  SESSION_RENAMED: 'session:renamed',
  /** Fired when a session is created (eager create or first-message lazy create). */
  SESSION_CREATED: 'session:created',
  /** Fired when multi-chain state is updated (start/persist/finish turn). */
  SESSION_UPDATED: 'session:updated',
  SESSION_CHANGE_MODEL: 'session:change_model',
  /** Resolve current workspace (draft / session / sticky / unbound). */
  SESSION_GET_WORKSPACE: 'session:get_workspace',
  /** Native folder dialog → bind workspace + sticky default. */
  SESSION_PICK_PROJECT_DIR: 'session:pick_project_dir',
  /** Bind absolute path without dialog (tests). */
  SESSION_SET_WORKSPACE: 'session:set_workspace',
  /** Change active session cwd + sticky default. */
  SESSION_CHANGE_CWD: 'session:change_cwd',
  /** Fired when workspace binding changes. */
  SESSION_WORKSPACE_CHANGED: 'session:workspace_changed',
  /** Fired when subagent_chains are persisted (spawn progress / complete). */
  SESSION_SUBAGENTS_CHANGED: 'session:subagents_changed',
  /** Fired when the active session's todo store mutates (tool create/update/delete). */
  SESSION_TODOS_CHANGED: 'session:todos_changed',

  // Tool
  TOOL_EXECUTE: 'tool:execute',

  // Agent
  AGENT_LIST: 'agent:list',
  AGENT_SPAWN: 'agent:spawn',
  AGENT_SAVE: 'agent:save',
  AGENT_DELETE: 'agent:delete',

  // Skills / agents / personalities management
  DEFINITIONS_LIST: 'definitions:list',
  DEFINITION_REVEAL: 'definition:reveal',
  SKILL_SAVE: 'skill:save',
  SKILL_DELETE: 'skill:delete',
  PERSONALITY_SAVE: 'personality:save',
  PERSONALITY_DELETE: 'personality:delete',

  // MCP
  MCP_STATUS: 'mcp:status',

  // RAG
  RAG_STATUS: 'rag:status',
  RAG_INDEX: 'rag:index',
  RAG_CLEAR: 'rag:clear',
  RAG_INDEX_STATE: 'rag:index_state',
  /** Push event: live RAG index progress from worker. */
  RAG_PROGRESS: 'rag:progress',

  // AST
  AST_STATUS: 'ast:status',
  AST_INDEX: 'ast:index',
  AST_INDEX_STATE: 'ast:index_state',
  /** Push event: live AST index progress from worker. */
  AST_PROGRESS: 'ast:progress',

  // Background Commands
  BG_CMD_SNAPSHOT: 'bgcmd:snapshot',

  // Updater
  UPDATER_CHECK: 'updater:check',
  UPDATER_INSTALL: 'updater:install',
  UPDATER_STATUS: 'updater:status',
  UPDATER_DOWNLOAD: 'updater:download',
  UPDATER_STATUS_UPDATE: 'updater:status_update',
  UPDATER_PROGRESS: 'updater:progress',
  UPDATER_ERROR: 'updater:error',
} as const;

export type IPCChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ── Allowed invoke channels (preload security gate) ──────────────────────────

export const ALLOWED_INVOKE_CHANNELS: readonly string[] = [
  IPC_CHANNELS.CHAT_SEND,
  IPC_CHANNELS.CHAT_CANCEL,
  IPC_CHANNELS.CONFIG_GET,
  IPC_CHANNELS.CONFIG_SAVE,
  IPC_CHANNELS.CONFIG_MODEL_METADATA,
  IPC_CHANNELS.CONFIG_DISCOVER_MODELS,
  IPC_CHANNELS.CONFIG_LIST_PERSONALITIES,
  IPC_CHANNELS.SESSION_LIST,
  IPC_CHANNELS.SESSION_LOAD,
  IPC_CHANNELS.SESSION_CREATE,
  IPC_CHANNELS.SESSION_CLEAR_ACTIVE,
  IPC_CHANNELS.SESSION_DELETE,
  IPC_CHANNELS.SESSION_RENAME,
  IPC_CHANNELS.SESSION_CHANGE_MODEL,
  IPC_CHANNELS.SESSION_GET_WORKSPACE,
  IPC_CHANNELS.SESSION_PICK_PROJECT_DIR,
  IPC_CHANNELS.SESSION_SET_WORKSPACE,
  IPC_CHANNELS.SESSION_CHANGE_CWD,
  IPC_CHANNELS.TOOL_EXECUTE,
  IPC_CHANNELS.AGENT_LIST,
  IPC_CHANNELS.AGENT_SPAWN,
  IPC_CHANNELS.AGENT_SAVE,
  IPC_CHANNELS.AGENT_DELETE,
  IPC_CHANNELS.DEFINITIONS_LIST,
  IPC_CHANNELS.DEFINITION_REVEAL,
  IPC_CHANNELS.SKILL_SAVE,
  IPC_CHANNELS.SKILL_DELETE,
  IPC_CHANNELS.PERSONALITY_SAVE,
  IPC_CHANNELS.PERSONALITY_DELETE,
  IPC_CHANNELS.MCP_STATUS,
  IPC_CHANNELS.RAG_STATUS,
  IPC_CHANNELS.RAG_INDEX,
  IPC_CHANNELS.RAG_CLEAR,
  IPC_CHANNELS.RAG_INDEX_STATE,
  IPC_CHANNELS.AST_STATUS,
  IPC_CHANNELS.AST_INDEX,
  IPC_CHANNELS.AST_INDEX_STATE,
  IPC_CHANNELS.BG_CMD_SNAPSHOT,
  IPC_CHANNELS.UPDATER_CHECK,
  IPC_CHANNELS.UPDATER_INSTALL,
  IPC_CHANNELS.UPDATER_STATUS,
  IPC_CHANNELS.UPDATER_DOWNLOAD,
];

// ── Allowed event channels (preload security gate) ───────────────────────────

export const ALLOWED_EVENT_CHANNELS: readonly string[] = [
  IPC_CHANNELS.CHAT_CHUNK,
  IPC_CHANNELS.CHAT_THINKING,
  IPC_CHANNELS.CHAT_STATE,
  IPC_CHANNELS.CHAT_DONE,
  IPC_CHANNELS.CHAT_ERROR,
  IPC_CHANNELS.CHAT_USAGE,
  IPC_CHANNELS.CHAT_TOOL_CALL_START,
  IPC_CHANNELS.CHAT_TOOL_CALL_DELTA,
  IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE,
  IPC_CHANNELS.SESSION_RENAMED,
  IPC_CHANNELS.SESSION_CREATED,
  IPC_CHANNELS.SESSION_UPDATED,
  IPC_CHANNELS.SESSION_WORKSPACE_CHANGED,
  IPC_CHANNELS.SESSION_SUBAGENTS_CHANGED,
  IPC_CHANNELS.SESSION_TODOS_CHANGED,
  IPC_CHANNELS.RAG_PROGRESS,
  IPC_CHANNELS.AST_PROGRESS,
  IPC_CHANNELS.UPDATER_STATUS_UPDATE,
  IPC_CHANNELS.UPDATER_PROGRESS,
  IPC_CHANNELS.UPDATER_ERROR,
];

// ── Window type augmentation (renderer-side) ─────────────────────────────────

declare global {
  interface Window {
    orchid: OrchidAPI;
  }
}
