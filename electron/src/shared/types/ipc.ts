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
  CustomConnectionModel,
  ModelSelection,
  ProviderAuthMethod,
  ProviderLifecycle,
  ProviderProtocol,
} from './provider';
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
  SessionActivity,
  Config,
  ConfigDiagnostic,
  ModelMetadata,
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
  SessionActivity,
  Config,
  ConfigDiagnostic,
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
  model?: ModelSelection | null;
  /** Renderer draft generation; prevents stale lazy-create events stealing selection. */
  draftGeneration?: number;
}

export interface ChatCancelMessage {
  /** Optional session ID (uses the sender window's selected session if omitted). */
  sessionId?: string;
}

/** Request the latest in-flight state for one session without changing selection. */
export interface ChatSnapshotMessage {
  /** Optional session ID (uses the sender window's selected session if omitted). */
  sessionId?: string;
}

/** Immediate, targeted cancellation used by the global Activity surface. */
export interface ChatStopMessage {
  sessionId: string;
}

export type ChatSnapshotState = 'idle' | 'streaming' | 'error';

export interface ChatToolCallSnapshot {
  toolCallId: string;
  toolName: string;
  status: 'generating' | 'running' | 'completed' | 'failed';
  partialArgs: string;
  args: string;
  result: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type ChatStreamSegmentSnapshot =
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'text'; id: string; content: string }
  | { kind: 'thinking'; id: string; content: string };

/** Atomic in-flight view used when a renderer returns to a running session. */
export interface ChatSnapshot {
  sessionId: string;
  turnId: string;
  /** Last stream event included by this snapshot. Older queued events are stale. */
  sequence: number;
  state: ChatSnapshotState;
  response: string;
  thinking: string;
  toolCalls: ChatToolCallSnapshot[];
  streamSegments: ChatStreamSegmentSnapshot[];
  usage: Usage | null;
  error: string | null;
  interruptState: 'idle' | 'confirmAgent' | 'confirmSubagents';
  cwd: string | null;
  startedAt: number | null;
  interrupted: boolean;
}

interface ChatEventIdentity {
  /** Session whose runtime emitted this event. */
  sessionId: string;
  /** Stable chain/turn id used to order live events and snapshots. */
  turnId: string;
  /** Monotonic per-turn event sequence. Events at or below a snapshot are stale. */
  sequence: number;
}

export interface ChatChunkEvent extends ChatEventIdentity {
  type: 'chunk';
  data: string;
}

/** Reasoning/thinking stream delta (models that emit reasoning-delta). */
export interface ChatThinkingEvent extends ChatEventIdentity {
  type: 'thinking';
  data: string;
}

export interface ChatStateEvent extends ChatEventIdentity {
  state: string;
  response: string;
  error: string | null;
  /** Current interrupt confirmation phase. */
  interruptState: 'idle' | 'confirmAgent' | 'confirmSubagents';
  /** Active workspace cwd (session → draft → sticky); null/undefined when unbound. */
  cwd?: string | null;
}

export interface ChatDoneEvent extends ChatEventIdentity {
  type: 'done';
  response: string;
  /** True when the turn ended due to user Esc cancellation. */
  interrupted?: boolean;
  /** Latest token usage for the completed/interrupted turn. */
  usage?: Usage | null;
}

export type ChatErrorKind = 'stream' | 'rate-limit' | 'auth' | 'generic';

export interface ChatErrorEvent extends ChatEventIdentity {
  type: 'error';
  error: string;
  /** Short banner title (e.g. "Authentication failed"). */
  title?: string;
  /** Classified error kind for banner actions. */
  kind?: ChatErrorKind;
}

export interface ChatUsageEvent extends ChatEventIdentity {
  type: 'usage';
  usage: Usage;
}

export interface ChatToolCallStartEvent extends ChatEventIdentity {
  type: 'tool_call_start';
  toolCallId: string;
  toolName: string;
}

export interface ChatToolCallDeltaEvent extends ChatEventIdentity {
  type: 'tool_call_delta';
  toolCallId: string;
  argsDelta: string;
}

export interface ChatToolCallUpdateEvent extends ChatEventIdentity {
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

export interface ConfigSaveMessage {
  updates: Partial<Config>;
}

// ── Provider API ─────────────────────────────────────────────────────────────

/**
 * Renderer-safe provider model metadata. Driver origins, pricing internals,
 * and catalog signatures stay in the main process.
 */
export interface ProviderModelView {
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  lifecycle: ProviderLifecycle | null;
  source: 'catalog' | 'connection';
  capabilities: {
    inputModalities: readonly string[];
    outputModalities: readonly string[];
    tools: boolean;
    reasoning: boolean;
  } | null;
  limits: {
    contextTokens: number | null;
    outputTokens: number | null;
  } | null;
}

/** A catalog preset rendered by onboarding and settings. */
export interface ProviderDefinitionView {
  id: string;
  displayName: string;
  supportedAuthMethods: readonly ProviderAuthMethod[];
  supportedProtocols: readonly ProviderProtocol[];
  allowsCustomModels: boolean;
  lifecycle: ProviderLifecycle | null;
  available: boolean;
  unavailableReason: string | null;
  models: readonly ProviderModelView[];
}

/**
 * A redacted connection view. `credentialHandle`, encrypted payloads, API
  * keys are intentionally not part of this type.
 */
export interface ProviderConnectionView {
  id: string;
  providerId: string;
  providerDisplayName: string | null;
  name: string;
  protocol: ProviderProtocol;
  authMethod: ProviderAuthMethod;
  credentialKind: 'stored' | 'environment' | 'none';
  environmentVariable: string | null;
  modelIds: readonly string[];
  customModels: readonly ProviderModelView[];
  health: 'draft' | 'ready' | 'needs_attention' | 'disabled' | 'disconnected';
  /** Active frozen turns attributed to this connection; never credential data. */
  activeTurnCount: number;
  endpoint: string | null;
  allowInsecureHttp: boolean;
}

/** Status data is timestamped and redacted before it crosses IPC. */
export interface ProviderStatusView {
  providerId: string;
  observedAt: string;
  providerUpdatedAt: string | null;
  availability: 'available' | 'unavailable' | 'unknown';
  stale: boolean;
  data: Readonly<Record<string, unknown>>;
  error: {
    kind: 'network' | 'unauthorized' | 'rate-limited' | 'schema' | 'unknown';
    message: string;
    statusCode?: number;
    retryAfterAt?: string;
  } | null;
}

export interface ProviderOverview {
  definitions: readonly ProviderDefinitionView[];
  connections: readonly ProviderConnectionView[];
  statuses: readonly ProviderStatusView[];
  secureStorage: {
    available: boolean;
    backend: string | null;
    reason: 'unavailable' | 'basic_text' | 'error' | null;
  };
}

/** Intent-only creation payload; credential handles can never be renderer input. */
export interface ProviderConnectionCreateMessage {
  providerId: string;
  name: string;
  protocol: ProviderProtocol;
  authMethod: ProviderAuthMethod;
  modelIds: readonly string[];
  customModels?: readonly CustomConnectionModel[];
  endpoint?: string | null;
  allowInsecureHttp?: boolean;
  /** Used only with `authMethod: 'environment'`; the value is never resolved here. */
  environmentVariable?: string;
}

/** Safe connection fields that may be edited after creation. */
export interface ProviderConnectionUpdateMessage {
  connectionId: string;
  name?: string;
  modelIds?: readonly string[];
  customModels?: readonly CustomConnectionModel[];
  endpoint?: string | null;
  allowInsecureHttp?: boolean;
  /** Reconnect an environment-authenticated connection without exposing its value. */
  environmentVariable?: string;
}

/** One-shot, write-only API key submission. No result includes the key or handle. */
export interface ProviderSubmitApiKeyMessage {
  connectionId: string;
  apiKey: string;
}

export interface ProviderConnectionIdMessage {
  connectionId: string;
}

export interface ProviderDisconnectMessage extends ProviderConnectionIdMessage {
  /** Explicit UI confirmation is required before stored credentials are removed. */
  confirm: true;
}

export interface ProviderStatusRefreshMessage {
  providerId: string;
  /** Required for connection-scoped authenticated status sources. */
  connectionId?: string;
}

export interface ProviderModelOption {
  selection: ModelSelection;
  connectionName: string;
  providerId: string;
  providerDisplayName: string | null;
  model: ProviderModelView;
  available: boolean;
  unavailableReason: string | null;
}

export interface ProviderMutationResult {
  connection: ProviderConnectionView;
  message: string | null;
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

export interface SessionActivityChangedEvent {
  activity: SessionActivity;
}

export interface SessionMarkSeenMessage {
  id: string;
}

/** Fired when main creates a session (e.g. first message from draft mode). */
export interface SessionCreatedEvent {
  session: Session;
  /** Present for lazy draft promotion initiated by chat:send. */
  draftGeneration?: number;
}

/**
 * Fired when the active session's multi-chain state changes (start/finish turn).
 * Same payload shape as SessionCreatedEvent so the renderer can refresh chains.
 */
export type SessionUpdatedEvent = SessionCreatedEvent;

export interface SessionChangeModelMessage {
  id: string;
  selection: ModelSelection | null;
  modelLabel?: string | null;
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
  /** Session that owns the started turn (present when status is started). */
  sessionId?: string;
  /** Turn/chain identity for ordering live events. */
  turnId?: string;
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
    cancel: (message?: ChatCancelMessage) => Promise<{ status: string }>;
    /** Immediately stop exactly one session without staged Esc confirmation. */
    stop: (message: ChatStopMessage) => Promise<{ status: string }>;
    /** Read a running session's in-flight state without changing window selection. */
    snapshot: (message?: ChatSnapshotMessage) => Promise<ChatSnapshot | null>;
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
    diagnostics: () => Promise<ConfigDiagnostic[]>;
    save: (updates: ConfigSaveMessage) => Promise<{ status: string }>;
    modelMetadata: (modelId: string) => Promise<ModelMetadata>;
    /** List personality names loaded from `~/.orchid/personalities/*.md`. */
    listPersonalities: () => Promise<string[]>;
  };

  providers: {
    /** Bundled/catalog provider presets, redacted connections, and status. */
    list: () => Promise<ProviderOverview>;
    /** Create a draft connection using only driver-supported metadata. */
    create: (message: ProviderConnectionCreateMessage) => Promise<ProviderMutationResult>;
    /** Edit safe connection metadata; credentials require their dedicated flow. */
    update: (message: ProviderConnectionUpdateMessage) => Promise<ProviderMutationResult>;
    /** One-shot write-only credential submission. */
    submitApiKey: (message: ProviderSubmitApiKeyMessage) => Promise<ProviderMutationResult>;
    /** Validate connection eligibility without returning secret material. */
    validate: (message: ProviderConnectionIdMessage) => Promise<ProviderMutationResult>;
    /** Mark a connection unavailable for new turns without deleting it. */
    disable: (message: ProviderConnectionIdMessage) => Promise<ProviderMutationResult>;
    /** Re-enable a disabled connection, then revalidate its existing auth. */
    enable: (message: ProviderConnectionIdMessage) => Promise<ProviderMutationResult>;
    /** Remove stored credentials after explicit confirmation; preserves connection history. */
    disconnect: (message: ProviderDisconnectMessage) => Promise<ProviderMutationResult>;
    /** Connection-scoped typed model options, including unavailable reasons. */
    modelList: (message?: ProviderConnectionIdMessage) => Promise<readonly ProviderModelOption[]>;
    /** Refresh informational status only; it never changes connection health. */
    refreshStatus: (message: ProviderStatusRefreshMessage) => Promise<ProviderStatusView | null>;
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
    changeModel: (id: string, selection: ModelSelection | null, modelLabel?: string | null) => Promise<{ status: string }>;
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
    /**
     * Change cwd on an empty active session. Non-empty conversations remain
     * bound and return null after opening a project-bound draft instead.
     */
    changeCwd: (message: SessionChangeCwdMessage) => Promise<Session | null>;
    /** Process-wide sessions currently working, waiting, needing attention, or unread. */
    listActivity: () => Promise<SessionActivity[]>;
    /** Mark an off-screen completion as viewed. */
    markSeen: (message: SessionMarkSeenMessage) => Promise<SessionActivity | null>;
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
    onActivityChanged: (callback: (event: SessionActivityChangedEvent) => void) => () => void;
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
  CHAT_STOP: 'chat:stop',
  CHAT_SNAPSHOT: 'chat:snapshot',
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
  CONFIG_DIAGNOSTICS: 'config:diagnostics',
  CONFIG_SAVE: 'config:save',
  CONFIG_MODEL_METADATA: 'config:model_metadata',
  CONFIG_LIST_PERSONALITIES: 'config:list_personalities',

  // Providers — every response is redacted and every mutation is validated
  // in the main process. There is deliberately no generic credential-read API.
  PROVIDERS_LIST: 'providers:list',
  PROVIDERS_CREATE: 'providers:create',
  PROVIDERS_UPDATE: 'providers:update',
  PROVIDERS_SUBMIT_API_KEY: 'providers:submit_api_key',
  PROVIDERS_VALIDATE: 'providers:validate',
  PROVIDERS_DISABLE: 'providers:disable',
  PROVIDERS_ENABLE: 'providers:enable',
  PROVIDERS_DISCONNECT: 'providers:disconnect',
  PROVIDERS_MODEL_LIST: 'providers:model_list',
  PROVIDERS_STATUS_REFRESH: 'providers:status_refresh',

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
  SESSION_ACTIVITY_LIST: 'session:activity_list',
  SESSION_ACTIVITY_MARK_SEEN: 'session:activity_mark_seen',
  SESSION_ACTIVITY_CHANGED: 'session:activity_changed',

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
  IPC_CHANNELS.CHAT_STOP,
  IPC_CHANNELS.CHAT_SNAPSHOT,
  IPC_CHANNELS.CONFIG_GET,
  IPC_CHANNELS.CONFIG_DIAGNOSTICS,
  IPC_CHANNELS.CONFIG_SAVE,
  IPC_CHANNELS.CONFIG_MODEL_METADATA,
  IPC_CHANNELS.CONFIG_LIST_PERSONALITIES,
  IPC_CHANNELS.PROVIDERS_LIST,
  IPC_CHANNELS.PROVIDERS_CREATE,
  IPC_CHANNELS.PROVIDERS_UPDATE,
  IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY,
  IPC_CHANNELS.PROVIDERS_VALIDATE,
  IPC_CHANNELS.PROVIDERS_DISABLE,
  IPC_CHANNELS.PROVIDERS_ENABLE,
  IPC_CHANNELS.PROVIDERS_DISCONNECT,
  IPC_CHANNELS.PROVIDERS_MODEL_LIST,
  IPC_CHANNELS.PROVIDERS_STATUS_REFRESH,
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
  IPC_CHANNELS.SESSION_ACTIVITY_LIST,
  IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN,
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
  IPC_CHANNELS.SESSION_ACTIVITY_CHANGED,
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
