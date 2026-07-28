/**
 * IPC API surface types — shared between main, preload, and renderer.
 *
 * This file defines the typed contract for the contextBridge API.
 * All IPC payloads are validated with zod at the main-process boundary.
 *
 * The renderer accesses this API via `window.orchid.*`.
 */

import type { Session } from './session';
import type { Message, Usage } from './message';
import type {
  CanonicalToolResult,
  TerminalToolResultStatus,
  ToolExecutionResult,
} from './tool-result';
import type { SubagentDeltaEvent, SubagentLiveProjection, SubagentRecord } from './subagent';
import type { RiskClass, ToolScope } from './permission';
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
  MCPServerStatus,
  RAGStoreStatus,
  ASTStoreStatus,
  RAGIndexResult,
  RAGIndexProgress,
  ASTIndexResult,
  ASTIndexProgress,
  IndexRunState,
  RAGConfig,
  AgentsMdConfig,
  SubagentsConfig,
  PermissionModeValue,
  PermissionRule,
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
  MCPServerStatus,
  RAGStoreStatus,
  ASTStoreStatus,
  RAGIndexResult,
  RAGIndexProgress,
  ASTIndexResult,
  ASTIndexProgress,
  IndexRunState,
  RAGConfig,
  AgentsMdConfig,
  SubagentsConfig,
  PermissionModeValue,
  PermissionRule,
  UpdaterState,
  UpdateStatus,
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

/** Signal that a next-request queue message is pending; stop the current chain at the next step boundary. */
export interface ChatQueueNextRequest {
  sessionId: string;
}

export type ChatSnapshotState = 'idle' | 'streaming' | 'error';

export interface ChatToolCallSnapshot {
  toolCallId: string;
  toolName: string;
  status: 'generating' | 'running' | TerminalToolResultStatus;
  partialArgs: string;
  args: string;
  /** Exact finalized agent projection for terminal snapshots. */
  content: string | null;
  /** Canonical terminal authority; null while generating/running. */
  toolResult: CanonicalToolResult | null;
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

/** Coherent persisted history plus the optional in-flight tail for one session. */
export interface ChatSessionSnapshot {
  sessionId: string;
  messages: Message[];
  live: ChatSnapshot | null;
}

/**
 * Full view payload for activating a session in one round-trip.
 *
 * Replaces the prior peek + chat:snapshot + activate sequence so a session
 * switch reads/parses the session file once and serializes it across IPC once.
 */
export interface SessionOpenResult {
  /** The activated session, or null when missing/corrupt. */
  session: Session | null;
  /** Flattened chain messages for the chat pane (empty when no session). */
  messages: Message[];
  /** In-flight turn snapshot when the session is currently running. */
  live: ChatSnapshot | null;
  /** Resolved workspace after activation (session → sticky → unbound). */
  workspace: WorkspaceInfo;
}

export interface SubagentSnapshotRequest { sessionId: string; }
export interface SubagentSnapshot {
  sessionId: string;
  /**
   * Per-session monotonic revision from the manager's session counter. The
   * renderer rejects snapshots below its recorded revision floor.
   */
  sessionRevision: number;
  records: SubagentRecord[];
  live: SubagentLiveProjection[];
}
/**
 * Unit of SUBAGENTS_EVENT delivery: one budgeted flush of typed live deltas
 * for a single session. Records ride only `spawned`/`terminal` deltas, so
 * projection-only batches keep renderer record identity stable.
 */
export interface SubagentEvent {
  sessionId: string;
  events: SubagentDeltaEvent[];
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
  /** Canonical identity shared by the live segment and persisted message. */
  segmentId: string;
}

/** Reasoning/thinking stream delta (models that emit reasoning-delta). */
export interface ChatThinkingEvent extends ChatEventIdentity {
  type: 'thinking';
  data: string;
  /** Canonical identity shared by the live segment and persisted message. */
  segmentId: string;
}

export interface ChatStateEvent extends ChatEventIdentity {
  state: string;
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
  status: 'running' | TerminalToolResultStatus;
  args?: string;
  /** Exact finalized agent projection; required for terminal updates. */
  content?: string;
  /** Canonical terminal authority; required for terminal updates. */
  toolResult?: CanonicalToolResult;
}

// ── Background Command API ────────────────────────────────────────────────

export interface BgCommandSnapshotRequest {
  /** The background command ID. */
  commandId: number;
  /** Optional last N lines to retrieve (default: 50, max: 1000). */
  lastN?: number;
  /**
   * Owning session for visibility. When omitted, main resolves the calling
   * window's active session; cross-session command tails are denied.
   */
  sessionId?: string;
}

export type BgCommandSnapshotResult =
  | {
    /** The command exists and is visible to the requesting session. */
    found: true;
    /** Tail output text. */
    tail: string;
    /** Exit code (null if still running). */
    exitCode: number | null;
  }
  | {
    /** The command is unavailable after restart, eviction, or session mismatch. */
    found: false;
  };

// ── Config API ───────────────────────────────────────────────────────────────

/**
 * Nested map under config:save PATCH. `null` values are tombstones that delete
 * the key under deep-merge (e.g. removed mcp_servers aliases).
 */
export type ConfigPatchMap<V> = { readonly [key: string]: V | null };

/**
 * PATCH-style config update matching main's mergeConfigUpdates semantics:
 * - Nested plain objects (rag, …) deep-merge field-by-field
 * - Map entries (mcp_servers, tier_models) accept null tombstones for deletes
 * - Nullable fields (default_model, default_project_dir) use null as a real value
 *
 * Not the same as Partial<Config>: Partial cannot express map tombstones.
 */
export type ConfigPatch = {
  default_model?: ModelSelection | null;
  tier_models?: ConfigPatchMap<ModelSelection | null>;
  tier_reasoning_effort?: ConfigPatchMap<string | number | null>;
  ignored_dirs?: string[];
  command_timeout?: number;
  read_line_limit?: number;
  grep_max_results?: number;
  directory_tree_depth?: number;
  tool_worker_pool_size?: number;
  tool_worker_pool_main_agent_reserved?: number;
  theme?: string;
  personality?: string;
  rag?: Partial<RAGConfig> & {
    embedding_api_model?: ModelSelection | null;
  };
  agents_md?: Partial<AgentsMdConfig>;
  subagents?: Partial<SubagentsConfig>;
  ast_max_file_size?: number;
  mcp_startup_timeout?: number;
  mcp_per_server_timeout?: number;
  mcp_servers?: ConfigPatchMap<Record<string, unknown>>;
  /** Rejected at the main boundary; kept for draft tombstone helpers only. */
  providers?: ConfigPatchMap<Record<string, unknown>>;
  llm_stream_idle_timeout?: number;
  llm_stream_retries?: number;
  background_command_idle_timeout?: number;
  max_tool_steps?: number;
  permission_history_size?: number;
  permissions?: ConfigPatchMap<PermissionRule>;
  default_project_dir?: string | null;
  always_expand_tool_groups?: boolean;
  has_completed_onboarding?: boolean;
  command_max_output_bytes?: number;
  tool_output_inline_threshold?: number;
  approval_timeout?: number;
  subagent_wait_timeout?: number;
  web_fetch_timeout?: number;
  web_fetch_max_body_bytes?: number;
  web_fetch_user_agent?: string;
  bg_prompt_max_entries?: number;
  bg_prompt_tail_lines?: number;
  bg_prompt_tail_chars?: number;
  mcp_result_max_bytes?: number;
  max_background_processes?: number;
  bg_output_head_bytes?: number;
  bg_output_tail_bytes?: number;
  grep_per_file_timeout?: number;
  read_output_long_poll_max?: number;
  llm_retry_backoff_base?: number;
  llm_retry_max_delay?: number;
};

export interface ConfigSaveMessage {
  updates: ConfigPatch;
}

export type PermissionConfigScope = 'global' | 'project';

export interface PermissionConfigScopes {
  global: Record<string, PermissionRule>;
  project: Record<string, PermissionRule>;
  projectDir: string | null;
}

export type PermissionConfigScopeSaveMessage =
  | {
      scope: 'global';
      updates: ConfigPatchMap<PermissionRule>;
      expectedProjectDir?: never;
    }
  | {
      scope: 'project';
      updates: ConfigPatchMap<PermissionRule>;
      /** Canonical project observed when this draft was created. */
      expectedProjectDir: string;
    };

export interface ProjectConfigReadResult {
  projectDir: string;
  overrides: Record<string, unknown>;
}

export interface ProjectConfigSaveMessage {
  projectDir: string;
  updates: Record<string, unknown>;
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
  reasoningConfig?: Record<string, import('./provider').ReasoningModelConfig>;
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
  /** Change the connection's authentication strategy; credentials remain write-only. */
  authMethod?: ProviderAuthMethod;
  modelIds?: readonly string[];
  customModels?: readonly CustomConnectionModel[];
  reasoningConfig?: Record<string, import('./provider').ReasoningModelConfig>;
  endpoint?: string | null;
  allowInsecureHttp?: boolean;
  /** Select or replace an environment reference without exposing its value. */
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
  /** Whether the trusted provider driver can route this selection to RAG embeddings. */
  embeddingSupported?: boolean;
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

/** Activate a session and return its full view payload in one round-trip. */
export interface SessionOpenMessage {
  id: string;
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

/** Durable open tab set for the primary window. */
export interface WorkingSetSnapshot {
  openSessionIds: string[];
  focusedSessionId: string | null;
  mruSessionIds: string[];
}

export interface WorkingSetIdMessage {
  id: string;
}

export interface WorkingSetSetFocusMessage {
  id: string | null;
}

export interface WorkingSetChangedEvent {
  snapshot: WorkingSetSnapshot;
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

export interface SessionSetReasoningEffortMessage {
  effort: string | number | null;
}

export interface SessionReasoningConfigResult {
  levels: string[];
  default: string | number | null;
  override: string | number | null;
  supportsReasoning: boolean;
}

export interface SessionWorkspaceChangedEvent {
  workspace: WorkspaceInfo;
}

/** Machine-readable chat:send gate / start failures. */
export type ChatSendErrorKind =
  | 'session_not_found'
  | 'unbound_workspace'
  | 'provider_required'
  | 'session_busy'
  | 'runtime_hydration_failed'
  | 'provider_unavailable';

/** Result of chat:send (started stream or structured gate failure). */
export type ChatSendResult =
  | {
      status: 'started';
      /** Session that owns the started turn. */
      sessionId: string;
      /** Turn/chain identity for ordering live events. */
      turnId: string;
    }
  | {
      status: 'error';
      kind: ChatSendErrorKind;
      error: string;
    };

// ── Updater API ──────────────────────────────────────────────────────────────

/** Detailed download progress emitted on updater:progress. */
export interface UpdaterProgressEvent {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

/** Error payload emitted on updater:error. */
export interface UpdaterErrorEvent {
  error: string;
}

// ── Tool API ─────────────────────────────────────────────────────────────────

export interface ToolExecuteMessage {
  name: string;
  args: unknown;
}

export type ToolExecuteResult = ToolExecutionResult;

// ── Ask Question API ─────────────────────────────────────────────────────────

/** Event payload when the agent asks the user interactive questions. */
export interface AskQuestionAskedEvent {
  sessionId: string;
  toolCallId: string;
  questions: Array<{
    type: 'single' | 'multi';
    title: string;
    description?: string;
    options: Array<{
      label: string;
      description?: string;
    }>;
  }>;
}

/** Event payload when a pending interactive question leaves the main store. */
export interface AskQuestionSettledEvent {
  sessionId: string;
  toolCallId: string;
  result: 'answered' | 'cancelled';
}

/** Renderer → main: submit answers for a pending ask_question tool call. */
export interface AskQuestionAnswerMessage {
  toolCallId: string;
  answers: Array<{
    selected: string[];
    text: string | null;
    skipped: boolean;
  }>;
}

/** Renderer → main: cancel a pending ask_question tool call. */
export interface AskQuestionCancelMessage {
  toolCallId: string;
}

export interface AskQuestionResult {
  ok: boolean;
}

/** Replayable pending questions for the session selected by the invoking window. */
export interface AskQuestionSnapshot {
  questions: AskQuestionAskedEvent[];
}

// ── Permission API ───────────────────────────────────────────────────────────

export interface PermissionApprovalRequestedEvent {
  toolCallId: string;
  sessionId: string;
  toolName: string;
  riskClass: RiskClass;
  args: unknown;
  cwd: string;
  scope?: ToolScope;
}

export interface PermissionApprovalSettledEvent {
  sessionId: string;
  toolCallId: string;
  result: {
    decision: 'approved' | 'denied';
    reason?: string;
  };
}

export interface PermissionApprovalAnswerMessage {
  toolCallId: string;
  decision: 'approved' | 'denied';
  reason?: string;
}

export interface PermissionSetSessionModeMessage {
  mode: PermissionModeValue | null;
  /** Session identity observed by the renderer before issuing this request. */
  expectedSessionId: string | null;
}

export interface PermissionGetSessionModeMessage {
  /** Session identity observed by the renderer before issuing this request. */
  expectedSessionId: string | null;
}

export interface PermissionSessionModeResult {
  ok: boolean;
  sessionId: string | null;
  mode: PermissionModeValue | null;
}

export interface PermissionSessionModeMutationResult {
  ok: boolean;
  sessionId: string | null;
}

export interface PermissionApprovalSnapshot {
  approvals: Array<{
    toolCallId: string;
    sessionId: string;
    toolName: string;
    riskClass: RiskClass;
    args: unknown;
    cwd: string;
    scope?: ToolScope;
  }>;
}

export interface PermissionResult {
  ok: boolean;
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

// ── Orchid API (the full contextBridge surface) ──────────────────────────────

export interface OrchidAPI {
  chat: {
    send: (message: ChatSendMessage) => Promise<ChatSendResult>;
    cancel: (message?: ChatCancelMessage) => Promise<{ status: string }>;
    /** Signal that a next-request queue message is pending; stop the current chain at the next step boundary. */
    queueNext: (request: ChatQueueNextRequest) => Promise<void>;
    /** Immediately stop exactly one session without staged Esc confirmation. */
    stop: (message: ChatStopMessage) => Promise<{ status: string }>;
    /** Read coherent persisted history and in-flight state without changing selection. */
    snapshot: (message?: ChatSnapshotMessage) => Promise<ChatSessionSnapshot | null>;
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
    permissionScopes: () => Promise<PermissionConfigScopes>;
    savePermissionScope: (message: PermissionConfigScopeSaveMessage) => Promise<{ status: string }>;
    /** List personality names loaded from `~/.orchid/personalities/*.md`. */
    listPersonalities: () => Promise<string[]>;
    readProject: (projectDir: string) => Promise<ProjectConfigReadResult>;
    saveProject: (message: ProjectConfigSaveMessage) => Promise<void>;
    getHome: () => Promise<Config>;
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
    /**
     * Activate a session and return its full view payload (session, flattened
     * messages, live snapshot, workspace) in one round-trip. Replaces the prior
     * peek + chat:snapshot + activate sequence for session switching.
     */
    open: (message: SessionOpenMessage) => Promise<SessionOpenResult>;
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
    setReasoningEffort: (message: SessionSetReasoningEffortMessage) => Promise<{ status: string }>;
    getReasoningConfig: () => Promise<SessionReasoningConfigResult>;
    /** Process-wide sessions currently working, waiting, needing attention, or unread. */
    listActivity: () => Promise<SessionActivity[]>;
    /** Mark an off-screen completion as viewed. */
    markSeen: (message: SessionMarkSeenMessage) => Promise<SessionActivity | null>;
    /** Durable open tab set (primary window). */
    getWorkingSet: () => Promise<WorkingSetSnapshot>;
    openOrFocusTab: (message: WorkingSetIdMessage) => Promise<WorkingSetSnapshot>;
    closeTab: (message: WorkingSetIdMessage) => Promise<WorkingSetSnapshot>;
    removeTab: (message: WorkingSetIdMessage) => Promise<WorkingSetSnapshot>;
    setTabFocus: (message: WorkingSetSetFocusMessage) => Promise<WorkingSetSnapshot>;
    onWorkingSetChanged: (callback: (event: WorkingSetChangedEvent) => void) => () => void;
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

  subagents: {
    snapshot: (request: SubagentSnapshotRequest) => Promise<SubagentSnapshot>;
    /** Batched subagent live deltas for the window's active session. */
    onEvent: (callback: (event: SubagentEvent) => void) => () => void;
  };

  tool: {
    execute: (message: ToolExecuteMessage) => Promise<ToolExecuteResult>;
  };

  agent: {
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

  askQuestion: {
    snapshot: () => Promise<AskQuestionSnapshot>;
    answer: (payload: AskQuestionAnswerMessage) => Promise<AskQuestionResult>;
    cancel: (payload: AskQuestionCancelMessage) => Promise<AskQuestionResult>;
    onAsked: (callback: (event: AskQuestionAskedEvent) => void) => () => void;
    onSettled: (callback: (event: AskQuestionSettledEvent) => void) => () => void;
  };

  permission: {
    snapshot: () => Promise<PermissionApprovalSnapshot>;
    answer: (payload: PermissionApprovalAnswerMessage) => Promise<PermissionResult>;
    setSessionMode: (payload: PermissionSetSessionModeMessage) => Promise<PermissionSessionModeMutationResult>;
    getSessionMode: (payload: PermissionGetSessionModeMessage) => Promise<PermissionSessionModeResult>;
    onApprovalRequested: (callback: (event: PermissionApprovalRequestedEvent) => void) => () => void;
    onApprovalSettled: (callback: (event: PermissionApprovalSettledEvent) => void) => () => void;
  };
}

// ── IPC Channel names ────────────────────────────────────────────────────────

export const IPC_CHANNELS = {
  // Chat
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_QUEUE_NEXT: 'chat:queue_next',
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

  SUBAGENTS_SNAPSHOT: 'subagents:snapshot',
  SUBAGENTS_EVENT: 'subagents:event',

  // Config
  CONFIG_GET: 'config:get',
  CONFIG_DIAGNOSTICS: 'config:diagnostics',
  CONFIG_SAVE: 'config:save',
  CONFIG_PERMISSION_SCOPES: 'config:permission_scopes',
  CONFIG_SAVE_PERMISSION_SCOPE: 'config:save_permission_scope',
  CONFIG_LIST_PERSONALITIES: 'config:list_personalities',
  CONFIG_READ_PROJECT: 'config:read_project',
  CONFIG_SAVE_PROJECT: 'config:save_project',
  CONFIG_GET_HOME: 'config:get_home',

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
  /** Activate a session and return its full view payload in one round-trip. */
  SESSION_OPEN: 'session:open',
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
  SESSION_SET_REASONING_EFFORT: 'session:set_reasoning_effort',
  SESSION_GET_REASONING_CONFIG: 'session:get_reasoning_config',
  /** Fired when workspace binding changes. */
  SESSION_WORKSPACE_CHANGED: 'session:workspace_changed',
  /** Fired when subagent_chains are persisted (spawn progress / complete). */
  SESSION_SUBAGENTS_CHANGED: 'session:subagents_changed',
  /** Fired when the active session's todo store mutates (tool create/update/delete). */
  SESSION_TODOS_CHANGED: 'session:todos_changed',
  SESSION_ACTIVITY_LIST: 'session:activity_list',
  SESSION_ACTIVITY_MARK_SEEN: 'session:activity_mark_seen',
  SESSION_ACTIVITY_CHANGED: 'session:activity_changed',
  SESSION_WORKING_SET_GET: 'session:working_set_get',
  SESSION_WORKING_SET_OPEN_OR_FOCUS: 'session:working_set_open_or_focus',
  SESSION_WORKING_SET_CLOSE: 'session:working_set_close',
  SESSION_WORKING_SET_REMOVE: 'session:working_set_remove',
  SESSION_WORKING_SET_SET_FOCUS: 'session:working_set_set_focus',
  SESSION_WORKING_SET_CHANGED: 'session:working_set_changed',

  // Tool
  TOOL_EXECUTE: 'tool:execute',

  // Agent definitions
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

  // Ask Question
  ASK_QUESTION_ASKED: 'ask_question:asked',
  ASK_QUESTION_SETTLED: 'ask_question:settled',
  ASK_QUESTION_SNAPSHOT: 'ask_question:snapshot',
  ASK_QUESTION_ANSWER: 'ask_question:answer',
  ASK_QUESTION_CANCEL: 'ask_question:cancel',

  // Permission
  PERMISSION_APPROVAL_REQUESTED: 'permission:approval_requested',
  PERMISSION_APPROVAL_SETTLED: 'permission:approval_settled',
  PERMISSION_APPROVAL_ANSWER: 'permission:approval_answer',
  PERMISSION_SNAPSHOT: 'permission:snapshot',
  PERMISSION_SET_SESSION_MODE: 'permission:set_session_mode',
  PERMISSION_GET_SESSION_MODE: 'permission:get_session_mode',

  // Updater
  UPDATER_STATUS_UPDATE: 'updater:status_update',
  UPDATER_PROGRESS: 'updater:progress',
  UPDATER_ERROR: 'updater:error',
} as const;

export type IPCChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ── Allowed invoke channels (preload security gate) ──────────────────────────

export const ALLOWED_INVOKE_CHANNELS = [
  IPC_CHANNELS.CHAT_SEND,
  IPC_CHANNELS.CHAT_CANCEL,
  IPC_CHANNELS.CHAT_QUEUE_NEXT,
  IPC_CHANNELS.CHAT_STOP,
  IPC_CHANNELS.CHAT_SNAPSHOT,
  IPC_CHANNELS.SUBAGENTS_SNAPSHOT,
  IPC_CHANNELS.CONFIG_GET,
  IPC_CHANNELS.CONFIG_DIAGNOSTICS,
  IPC_CHANNELS.CONFIG_SAVE,
  IPC_CHANNELS.CONFIG_PERMISSION_SCOPES,
  IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE,
  IPC_CHANNELS.CONFIG_LIST_PERSONALITIES,
  IPC_CHANNELS.CONFIG_READ_PROJECT,
  IPC_CHANNELS.CONFIG_SAVE_PROJECT,
  IPC_CHANNELS.CONFIG_GET_HOME,
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
  IPC_CHANNELS.SESSION_OPEN,
  IPC_CHANNELS.SESSION_CREATE,
  IPC_CHANNELS.SESSION_CLEAR_ACTIVE,
  IPC_CHANNELS.SESSION_DELETE,
  IPC_CHANNELS.SESSION_RENAME,
  IPC_CHANNELS.SESSION_CHANGE_MODEL,
  IPC_CHANNELS.SESSION_GET_WORKSPACE,
  IPC_CHANNELS.SESSION_PICK_PROJECT_DIR,
  IPC_CHANNELS.SESSION_SET_WORKSPACE,
  IPC_CHANNELS.SESSION_CHANGE_CWD,
  IPC_CHANNELS.SESSION_SET_REASONING_EFFORT,
  IPC_CHANNELS.SESSION_GET_REASONING_CONFIG,
  IPC_CHANNELS.SESSION_ACTIVITY_LIST,
  IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN,
  IPC_CHANNELS.SESSION_WORKING_SET_GET,
  IPC_CHANNELS.SESSION_WORKING_SET_OPEN_OR_FOCUS,
  IPC_CHANNELS.SESSION_WORKING_SET_CLOSE,
  IPC_CHANNELS.SESSION_WORKING_SET_REMOVE,
  IPC_CHANNELS.SESSION_WORKING_SET_SET_FOCUS,
  IPC_CHANNELS.TOOL_EXECUTE,
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
  IPC_CHANNELS.ASK_QUESTION_SNAPSHOT,
  IPC_CHANNELS.ASK_QUESTION_ANSWER,
  IPC_CHANNELS.ASK_QUESTION_CANCEL,
  IPC_CHANNELS.PERMISSION_APPROVAL_ANSWER,
  IPC_CHANNELS.PERMISSION_SNAPSHOT,
  IPC_CHANNELS.PERMISSION_SET_SESSION_MODE,
  IPC_CHANNELS.PERMISSION_GET_SESSION_MODE,
] as const satisfies readonly IPCChannel[];

// ── Allowed event channels (preload security gate) ───────────────────────────

export const ALLOWED_EVENT_CHANNELS = [
  IPC_CHANNELS.CHAT_CHUNK,
  IPC_CHANNELS.CHAT_THINKING,
  IPC_CHANNELS.CHAT_STATE,
  IPC_CHANNELS.CHAT_DONE,
  IPC_CHANNELS.CHAT_ERROR,
  IPC_CHANNELS.CHAT_USAGE,
  IPC_CHANNELS.CHAT_TOOL_CALL_START,
  IPC_CHANNELS.CHAT_TOOL_CALL_DELTA,
  IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE,
  IPC_CHANNELS.SUBAGENTS_EVENT,
  IPC_CHANNELS.SESSION_RENAMED,
  IPC_CHANNELS.SESSION_CREATED,
  IPC_CHANNELS.SESSION_UPDATED,
  IPC_CHANNELS.SESSION_WORKSPACE_CHANGED,
  IPC_CHANNELS.SESSION_SUBAGENTS_CHANGED,
  IPC_CHANNELS.SESSION_TODOS_CHANGED,
  IPC_CHANNELS.SESSION_ACTIVITY_CHANGED,
  IPC_CHANNELS.SESSION_WORKING_SET_CHANGED,
  IPC_CHANNELS.RAG_PROGRESS,
  IPC_CHANNELS.AST_PROGRESS,
  IPC_CHANNELS.ASK_QUESTION_ASKED,
  IPC_CHANNELS.ASK_QUESTION_SETTLED,
  IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED,
  IPC_CHANNELS.PERMISSION_APPROVAL_SETTLED,
] as const satisfies readonly IPCChannel[];

// ── Window type augmentation (renderer-side) ─────────────────────────────────

declare global {
  interface Window {
    orchid: OrchidAPI;
  }
}
