/**
 * IPC API surface types — shared between main, preload, and renderer.
 *
 * This file defines the typed contract for the contextBridge API.
 * All IPC payloads are validated with zod at the main-process boundary.
 *
 * The renderer accesses this API via `window.orchid.*`.
 */

import type { Session } from './session';
import type { Chain } from './chain';
import type { Message, Usage } from './message';
import type {
  CanonicalToolResult,
  TerminalToolResultStatus,
  ToolExecutionResult,
} from './tool-result';
import type {
  SubagentDeltaEvent,
  SubagentLiveProjection,
  SubagentRecord,
  SubagentSummary,
} from './subagent';
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
  CompactionScopeConfig,
  PermissionModeValue,
  PermissionRule,
  StartupSnapshot,
  StartupContinueDegradedResult,
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
  StartupSnapshot,
  StartupContinueDegradedResult,
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
  /** Error detail from the last FAILED chain, if any (for hydration restore). */
  lastChainError?: { detail: string; title?: string | null } | null;
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
  /** Error detail from the last FAILED chain, if any (for hydration restore). */
  lastChainError?: { detail: string; title?: string | null } | null;
}

export interface SubagentSnapshotRequest { sessionId: string; }
export interface SubagentSnapshot {
  sessionId: string;
  /**
   * Per-session monotonic revision from the manager's session counter. The
   * renderer rejects snapshots below its recorded revision floor.
   */
  sessionRevision: number;
  records: SubagentSummary[];
  live: SubagentLiveProjection[];
}
export interface SubagentDetailRequest {
  sessionId: string;
  subagentId: string;
}
export interface SubagentDetailResult {
  sessionId: string;
  subagentId: string;
  record: SubagentRecord | null;
}
/**
 * Unit of SUBAGENTS_EVENT delivery: one budgeted flush of typed live deltas
 * for a single session. Summaries ride only `spawned`/`terminal` deltas, so
 * projection-only batches keep renderer row identity stable.
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
  /** Durable messages for the completed turn only; prior model history stays main-process-only. */
  messages: Message[];
  /** True when the turn ended due to user Esc cancellation. */
  interrupted?: boolean;
  /** Latest token usage for the completed/interrupted turn. */
  usage?: Usage | null;
}

export type ChatErrorKind = 'stream' | 'rate-limit' | 'auth' | 'generic';

export interface ChatErrorEvent extends ChatEventIdentity {
  type: 'error';
  error: string;
  /** Durable messages for the failed turn only; prior model history stays main-process-only. */
  messages: Message[];
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

/** Input ownership of a background command. */
export type BgCommandOwner = 'AGENT' | 'USER';

export interface BgCommandSnapshotRequest {
  /** Background command ID (targets the background store). Exactly one of
   * `commandId` / `toolCallId` must be provided. */
  commandId?: number;
  /** Foreground tool call ID (targets the foreground live registry). Exactly
   * one of `commandId` / `toolCallId` must be provided. */
  toolCallId?: string;
  /** Optional last N lines to retrieve (default: 50, max: 1000). */
  lastN?: number;
  /**
   * Owning session for visibility. When omitted, main resolves the calling
   * window's active session; cross-session command tails are denied.
   */
  sessionId?: string;
  /**
   * When false, the handler returns `tail: ''` without touching the buffer
   * and keeps all other fields (running/exitCode/owner/etc). Default `true`
   * when omitted.
   */
  includeTail?: boolean;
}

export interface BgCommandSnapshotFound {
  /** The command exists and is visible to the requesting session. */
  found: true;
  /** Tail output text. */
  tail: string;
  /** Exit code (null if still running). */
  exitCode: number | null;
  /** Whether the process is still running (`exitCode === null`). Optional for
   * wire-compat with old clients that only expect tail/exitCode. */
  running?: boolean;
  /** Whether the command accepts user input (interactive PTY commands only). */
  interactive?: boolean;
  /** Current input owner. */
  owner?: BgCommandOwner;
  /** The spawned command line. */
  command?: string;
  /** Human-readable label; foreground commands reuse the command line. */
  description?: string;
  /** Owning agent scope (`'main'` or a subagent id). */
  agentScopeId?: string;
  /**
   * Restart-stable spawn identity (epoch ms). Background: the store entry's
   * `createdAt`; foreground: the mirror's `startedAt`. Replayed widgets compare
   * this against the persisted spawn fact so a reused integer `commandId` after
   * an app restart cannot alias onto an unrelated live process.
   */
  createdAt?: number;
}

export type BgCommandSnapshotResult =
  | BgCommandSnapshotFound
  | {
    /** The command is unavailable after restart, eviction, or session mismatch. */
    found: false;
  };

export interface BgCommandListRequest {
  /**
   * Session whose background fleet to list. When omitted, main resolves the
   * calling window's active session.
   */
  sessionId?: string;
}

/** One background command in the session fleet view. */
export interface BgCommandListItem {
  id: number;
  command: string;
  description: string;
  interactive: boolean;
  owner: BgCommandOwner;
  /** Owning agent scope (`'main'` or a subagent id). */
  agentScopeId: string;
  /** `'main'` for the main scope, else the subagent display name
   * (falls back to the raw scope id). */
  scopeName: string;
  running: boolean;
  exitCode: number | null;
  createdAt: number;
  lastOutputAt: number;
}

export type BgCommandListResult = BgCommandListItem[];

export interface BgCommandSendInputRequest {
  commandId: number;
  /** Text to write to stdin (include \n for newline). */
  text: string;
  sessionId?: string;
}

export type BgCommandSendInputResult =
  | { ok: true }
  | {
    ok: false;
    /** `not_found` covers unknown ids and cross-session access alike. */
    reason: 'not_found' | 'not_interactive' | 'exited' | 'write_failed';
  };

/** Target for user terminate / release-input (session-privileged). */
export interface BgCommandControlRequest {
  commandId: number;
  sessionId?: string;
}

export type BgCommandTerminateResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' };

export interface BgCommandReleaseInputResult {
  ok: boolean;
}

/** Push event: the background fleet of one session changed. */
export interface BgCommandChangedEvent {
  sessionId: string;
}

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
  compaction?: {
    main?: Partial<CompactionScopeConfig>;
    subagents?: Partial<CompactionScopeConfig>;
  };
  ast_max_file_size?: number;
  mcp_startup_timeout?: number;
  mcp_per_server_timeout?: number;
  mcp_servers?: ConfigPatchMap<Record<string, unknown>>;
  llm_stream_idle_timeout?: number;
  llm_stream_retries?: number;
  background_command_idle_timeout?: number;
  session_title_max_wait_seconds?: number;
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
 * Renderer-safe catalog pricing for one model: the rate fields plus the
 * billing-unit context needed to label them. Provenance stays in main.
 */
export interface ProviderModelPricingView {
  currency: string;
  currencyUnit?: import('./provider-facets').CurrencyUnit;
  effectiveAt: string;
  rates: import('./provider-facets').PricingRateFields;
  contextTiers?: readonly import('./provider-facets').PricingContextTier[];
}

/**
 * Renderer-safe provider model metadata. Driver origins, pricing internals,
 * and catalog signatures stay in the main process.
 */
export interface ProviderModelView {
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  lifecycle: ProviderLifecycle | null;
  /** Provenance badge: signed catalog, live provider discovery, or user-defined (R28). */
  source: 'catalog' | 'provider' | 'user';
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
  /** Signed-catalog rate card for catalog rows; absent for other origins. */
  pricing?: ProviderModelPricingView;
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
  /** The trusted driver publishes a live models endpoint for this provider (R26). */
  supportsDiscovery: boolean;
  /** The trusted driver declares a typed quota facet for this provider (R24). */
  supportsQuota: boolean;
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
  /** Per-model field-level rate overrides, keyed by modelId (R6). */
  pricingOverrides?: Record<string, import('./provider-facets').PricingRateFields>;
  /** Per-model service tier selections, keyed by modelId (R21). */
  tierSelections?: Record<string, string>;
  /** Driver-declared cache TTL options; absent when the driver has no cache facet. */
  cacheTtlOptions?: readonly import('./provider-facets').CacheTtlOption[];
  /** Selected cache TTL; the driver's default applies when absent (R11). */
  cacheTtl?: string | null;
}

/** Status data is timestamped and redacted before it crosses IPC. */
export interface ProviderStatusView {
  providerId: string;
  /** Present only for account status tied to one provider connection. */
  connectionId?: string;
  observedAt: string;
  providerUpdatedAt: string | null;
  availability: 'available' | 'unavailable' | 'unknown';
  stale: boolean;
  data: Readonly<Record<string, unknown>>;
  /** Typed driver quota (R24); present only for facet-capable providers. */
  quota?: import('./provider-facets').ProviderQuota | null;
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
  reasoningConfig?: Record<string, import('./provider').ReasoningModelConfig>;
  pricingOverrides?: Record<string, import('./provider-facets').PricingRateFields>;
  tierSelections?: Record<string, string>;
  cacheTtl?: string | null;
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
  pricingOverrides?: Record<string, import('./provider-facets').PricingRateFields>;
  tierSelections?: Record<string, string>;
  /** Omit to keep the stored TTL; null clears back to the driver default. */
  cacheTtl?: string | null;
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

export interface ProviderDeleteConnectionMessage extends ProviderConnectionIdMessage {
  /** Explicit UI confirmation is required before connection metadata is removed. */
  confirm: true;
}

export interface ProviderStatusRefreshMessage {
  providerId: string;
  /** Required for connection-scoped authenticated status sources. */
  connectionId?: string;
}

export interface ProviderModelListMessage extends ProviderConnectionIdMessage {
  /** Include rows not enabled on the connection (the unified per-connection listing). */
  includeDisabled?: boolean;
}

export interface ProviderModelOption {
  selection: ModelSelection;
  connectionName: string;
  providerId: string;
  providerDisplayName: string | null;
  model: ProviderModelView;
  /** Enabled models are usable in chat (present in the connection's model list). */
  enabled: boolean;
  /** A user metadata override exists over the catalog/discovered entry. */
  customized: boolean;
  /** When the provider's live endpoint last published this model, if ever. */
  discoveredAt: string | null;
  available: boolean;
  unavailableReason: string | null;
  /** Whether the trusted provider driver can route this selection to RAG embeddings. */
  embeddingSupported?: boolean;
  /** Per-model user rate override honored by the pricing ladder (R6). */
  pricingOverrides?: import('./provider-facets').PricingRateFields;
  /** Tier selector data; present only when the driver declares a tier mechanism (R20). */
  tierOptions?: {
    mechanism: 'request-parameter' | 'model-name-variants';
    tiers: readonly ServiceTierOptionView[];
    /** Connection per-model selection for this model. */
    selected: string | null;
  };
}

/** Result of one explicit live-discovery fetch; never thrown for endpoint failures. */
export interface ProviderDiscoverModelsResult {
  connection: ProviderConnectionView;
  status: 'ok' | 'unsupported' | 'no-credential' | 'failed';
  /** Live models now tracked on the connection. */
  discoveredModelCount: number;
  /** Discovered ids unknown to the catalog and user-defined models. */
  addedModelIds: readonly string[];
  /** Redacted, user-presentable detail; null when nothing needs surfacing. */
  message: string | null;
}

export interface ProviderMutationResult {
  connection: ProviderConnectionView;
  message: string | null;
}

export interface ProviderDeleteConnectionResult {
  connectionId: string;
  message: string;
  config: Config;
  clearedConfigReferences: {
    defaultModel: boolean;
    tierModels: readonly string[];
    ragEmbeddingModel: boolean;
  };
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

/** Activate a session and return its bounded renderer view in one round-trip. */
export interface SessionOpenMessage {
  id: string;
}

/** Request the bounded page immediately preceding one durable chain index. */
export interface SessionHistoryPageMessage {
  sessionId: string;
  chainId: string;
  /** Exclusive durable message index; omit to start from the chain tail. */
  beforeIndex?: number;
}

/** One bounded page of durable messages and its absolute position in the chain. */
export interface SessionHistoryPageResult {
  sessionId: string;
  chainId: string;
  messages: Message[];
  startIndex: number;
  totalMessages: number;
  complete: boolean;
}

export interface SessionDeleteMessage {
  id: string;
}

export interface SessionDeleteResult {
  status: 'deleted' | 'not_found';
  workingSet: WorkingSetSnapshot;
}

/** Authoritative deletion broadcast with the recipient window's next focus. */
export interface SessionDeletedEvent {
  id: string;
  workingSet: WorkingSetSnapshot;
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
 * Narrow durable patch emitted when one main-agent chain changes.
 *
 * Deliberately excludes `subagentChains` and every other unchanged session
 * field so a checkpoint cannot clone the full session graph into a renderer.
 */
export interface SessionUpdatedEvent {
  sessionId: string;
  chain: Chain;
  activeChainId: string | null;
  updatedAt: string;
}

export interface SessionChangeModelMessage {
  id: string;
  selection: ModelSelection | null;
  modelLabel?: string | null;
}

/** Source of the resolved workspace path. */
export type WorkspaceSource = 'draft' | 'session' | 'default' | 'unbound';

/** Coarse project-directory status (mirrors main project path helpers). */
export type WorkspaceStatus = 'unbound' | 'valid' | 'missing';

/**
 * Trust posture of a bound project directory.
 * - `trusted`: granted and fingerprint-current (or bare project, auto-trusted).
 * - `untrusted`: has a project surface and no grant on record.
 * - `changed`: previously trusted but the security surface fingerprint changed.
 */
export type TrustState = 'trusted' | 'untrusted' | 'changed';

/** Resolved workspace for UI chrome and send gate. */
export interface WorkspaceInfo {
  /** Canonical absolute path when bound; null when unbound. */
  cwd: string | null;
  /** Where the path came from. */
  source: WorkspaceSource;
  /** Directory usability status. */
  status: WorkspaceStatus;
  /**
   * Trust posture of the bound directory. Optional with a `trusted` default
   * so producers that predate trusted-projects keep parsing.
   */
  trust?: TrustState;
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

export interface SessionGetReasoningConfigMessage {
  selection?: ModelSelection | null;
}

export interface SessionGetServiceTierConfigMessage {
  selection?: ModelSelection | null;
}

export interface SessionReasoningConfigResult {
  levels: string[];
  default: string | number | null;
  override: string | number | null;
  supportsReasoning: boolean;
}

/** Per-session service tier override; null clears back to the connection selection (R21). */
export interface SessionSetServiceTierMessage {
  tier: string | null;
}

/** Driver-declared tier descriptor surfaced to selectors (R19, R20). */
export interface ServiceTierOptionView {
  id: string;
  displayName: string | null;
  description: string | null;
  /** Variant mechanism only: requires a streaming request path (R23). */
  requiresStreaming?: boolean;
}

export interface SessionServiceTierConfigResult {
  /** How a selected tier reaches the provider; absent = no tier facet. */
  mechanism: 'request-parameter' | 'model-name-variants' | null;
  tiers: ServiceTierOptionView[];
  /** Connection per-model selection for the active model. */
  selected: string | null;
  /** Session override; wins over the connection selection when set. */
  override: string | null;
  /** Effective tier: override, then connection selection. */
  effective: string | null;
}

export interface SessionWorkspaceChangedEvent {
  workspace: WorkspaceInfo;
}

// ── Trusted projects API ─────────────────────────────────────────────────────

/** One MCP server a project adds or overrides (display-safe fields only). */
export interface TrustReportMcpServer {
  name: string;
  /** `added` when absent from home config; `override` when it shadows one. */
  kind: 'added' | 'override';
  command?: string;
  url?: string;
  args?: string[];
  /** Environment variable names only — never values. */
  envKeys?: string[];
}

/** One permission rule a project sets. */
export interface TrustReportPermission {
  tool: string;
  /** Human-readable rule (mode name or inside/outside pair). */
  rule: string;
  /** True when the rule auto-allows (`allow` or `decide-for-me`). */
  autoAllow: boolean;
}

/** One overridden config field, serialized for display. */
export interface TrustReportConfigOverride {
  key: string;
  projectValue: string;
  homeValue: string;
}

/** One model-selection override (`default_model` or a tier key). */
export interface TrustReportModelOverride {
  key: string;
  connectionId: string;
  modelId: string;
}

/** One project-local definition (agent / skill / personality). */
export interface TrustReportDefinition {
  kind: 'agent' | 'skill' | 'personality';
  name: string;
  /** True when it shadows a home definition of the same name. */
  overridesHome: boolean;
}

/** Surface diff between a project and the home/global configuration. */
export interface ProjectTrustReport {
  /** Canonical absolute project path. */
  projectDir: string;
  /** Whether the project carries any project surface at all. */
  hasSurface: boolean;
  mcpServers: TrustReportMcpServer[];
  permissions: TrustReportPermission[];
  /** `agents_md` fields the project overrides. */
  agentsMdOverrides: TrustReportConfigOverride[];
  modelOverrides: TrustReportModelOverride[];
  /** Remaining overridden top-level config keys. */
  otherConfigOverrides: TrustReportConfigOverride[];
  definitions: TrustReportDefinition[];
  /** Root instruction files present (configured AGENTS.md aliases). */
  instructionFiles: string[];
}

export interface ProjectTrustGetMessage {
  cwd: string;
}

export interface ProjectTrustSetMessage {
  cwd: string;
  trusted: boolean;
}

/** Trust state plus report for one project. */
export interface ProjectTrustInfo {
  projectDir: string;
  state: TrustState;
  /** Null when trusted-and-current (nothing to disclose). */
  report: ProjectTrustReport | null;
}

export interface ProjectTrustChangedEvent {
  projectDir: string;
  state: TrustState;
}

/** Entry shape for the settings trusted-projects list. */
export interface TrustedProjectEntry {
  projectDir: string;
  trustedAt: string;
  /** Live trust state (may be `changed` when the fingerprint drifted). */
  state: TrustState;
}

/** Machine-readable chat:send gate / start failures. */
export type ChatSendErrorKind =
  | 'session_not_found'
  | 'unbound_workspace'
  | 'untrusted_project'
  | 'provider_required'
  | 'session_busy'
  | 'runtime_hydration_failed'
  | 'history_load_failed'
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
  startup: {
    /** Current full startup state; subscribe before requesting this snapshot. */
    snapshot: () => Promise<StartupSnapshot>;
    /** Acknowledge the one allowed degraded → ready transition. */
    continueDegraded: () => Promise<StartupContinueDegradedResult>;
    onChanged: (callback: (snapshot: StartupSnapshot) => void) => () => void;
  };

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
    /** Permanently remove one connection and clear live configuration references to it. */
    deleteConnection: (
      message: ProviderDeleteConnectionMessage,
    ) => Promise<ProviderDeleteConnectionResult>;
    /** Connection-scoped typed model options, including unavailable reasons. */
    modelList: (message?: ProviderModelListMessage) => Promise<readonly ProviderModelOption[]>;
    /** One explicit live model discovery fetch for a connection; never polled (R26). */
    discoverModels: (message: ProviderConnectionIdMessage) => Promise<ProviderDiscoverModelsResult>;
    /** Refresh informational status only; it never changes connection health. */
    refreshStatus: (message: ProviderStatusRefreshMessage) => Promise<ProviderStatusView | null>;
    /**
     * Refresh typed quota for a facet-capable connection (R24). Informational
     * only: the result renders in connection details and analytics and never
     * gates connection usability, routing, or sends (R25).
     */
    refreshQuota: (message: ProviderConnectionIdMessage) => Promise<ProviderStatusView | null>;
  };

  session: {
    list: () => Promise<SessionSummary[]>;
    load: (id: SessionLoadMessage) => Promise<Session | null>;
    /**
     * Activate a session and return its bounded renderer view (session,
     * flattened loaded messages, live snapshot, workspace) in one round-trip.
     * Replaces the prior peek + chat:snapshot + activate sequence for switching.
     */
    open: (message: SessionOpenMessage) => Promise<SessionOpenResult>;
    /** Fetch the next older bounded page for one renderer chain. */
    loadHistoryPage: (message: SessionHistoryPageMessage) => Promise<SessionHistoryPageResult | null>;
    create: () => Promise<Session>;
    /**
     * Enter draft mode: clear active session, abort in-flight chat, clear
     * window history. Does not write a session file.
     */
    clearActive: () => Promise<{ status: string }>;
    delete: (id: SessionDeleteMessage) => Promise<SessionDeleteResult>;
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
    getReasoningConfig: (message?: SessionGetReasoningConfigMessage) => Promise<SessionReasoningConfigResult>;
    /** Per-session service tier override for the active model (R21). */
    setServiceTier: (message: SessionSetServiceTierMessage) => Promise<{ status: string }>;
    getServiceTierConfig: (message?: SessionGetServiceTierConfigMessage) => Promise<SessionServiceTierConfigResult>;
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
    /** A session disappeared; each window receives its own focus snapshot. */
    onDeleted: (callback: (event: SessionDeletedEvent) => void) => () => void;
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

  projectTrust: {
    /** Trust state + surface report for one project dir. */
    get: (message: ProjectTrustGetMessage) => Promise<ProjectTrustInfo>;
    /** Grant or revoke trust; broadcasts trust/workspace events. */
    set: (message: ProjectTrustSetMessage) => Promise<ProjectTrustInfo>;
    /** All trusted-project entries for the settings panel. */
    list: () => Promise<TrustedProjectEntry[]>;
    /** Trust state changed for a project dir. */
    onChanged: (callback: (event: ProjectTrustChangedEvent) => void) => () => void;
  };

  subagents: {
    snapshot: (request: SubagentSnapshotRequest) => Promise<SubagentSnapshot>;
    /** Fetch the full durable transcript for the currently selected row. */
    detail: (request: SubagentDetailRequest) => Promise<SubagentDetailResult>;
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
    /** List the session's background fleet across agent scopes (running-first). */
    list: (request?: BgCommandListRequest) => Promise<BgCommandListResult>;
    /** Send one line of user input; success takes USER ownership of the command. */
    sendInput: (request: BgCommandSendInputRequest) => Promise<BgCommandSendInputResult>;
    /** Terminate a single command in any agent scope of the session. */
    terminate: (request: BgCommandControlRequest) => Promise<BgCommandTerminateResult>;
    /** Release USER input ownership back to the agent. */
    releaseInput: (request: BgCommandControlRequest) => Promise<BgCommandReleaseInputResult>;
    /** Subscribe to background fleet changes (spawn/exit/eviction). */
    onChanged: (callback: (event: BgCommandChangedEvent) => void) => () => void;
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
 
  analytics: {
     overview: (params?: { readonly timeRange?: import('./analytics').AnalyticsTimeRange }) => Promise<import('./analytics').OverviewResult>;
     sessions: (params?: { readonly limit?: number; readonly timeRange?: import('./analytics').AnalyticsTimeRange }) => Promise<import('./analytics').SessionsResult>;
     sessionDetail: (params: { readonly sessionId: string; readonly timeRange?: import('./analytics').AnalyticsTimeRange }) => Promise<import('./analytics').SessionDetailResult>;
     models: (params?: { readonly timeRange?: import('./analytics').AnalyticsTimeRange }) => Promise<import('./analytics').ModelsResult>;
     tools: (params?: { readonly timeRange?: import('./analytics').AnalyticsTimeRange }) => Promise<import('./analytics').ToolsResult>;
     subagents: (params?: { readonly timeRange?: import('./analytics').AnalyticsTimeRange }) => Promise<import('./analytics').SubagentsResult>;
     context: (params?: { readonly sessionId?: string; readonly timeRange?: import('./analytics').AnalyticsTimeRange }) => Promise<import('./analytics').ContextResult>;
   };
}

// ── IPC Channel names ────────────────────────────────────────────────────────

export const IPC_CHANNELS = {
  // Startup — registered before normal application IPC.
  STARTUP_SNAPSHOT: 'startup:snapshot',
  STARTUP_CONTINUE_DEGRADED: 'startup:continue_degraded',
  STARTUP_CHANGED: 'startup:changed',

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
  SUBAGENTS_DETAIL: 'subagents:detail',
  SUBAGENTS_EVENT: 'subagents:event',

  // Config
  CONFIG_GET: 'config:get',
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
  PROVIDERS_DELETE: 'providers:delete',
  PROVIDERS_MODEL_LIST: 'providers:model_list',
  PROVIDERS_DISCOVER_MODELS: 'providers:discover_models',
  PROVIDERS_STATUS_REFRESH: 'providers:status_refresh',
  PROVIDERS_QUOTA_REFRESH: 'providers:quota_refresh',

  // Session
  SESSION_LIST: 'session:list',
  SESSION_LOAD: 'session:load',
  /** Activate a session and return its bounded renderer view in one round-trip. */
  SESSION_OPEN: 'session:open',
  SESSION_HISTORY_PAGE: 'session:history_page',
  SESSION_CREATE: 'session:create',
  /** Clear active session without creating a file (draft / new chat). */
  SESSION_CLEAR_ACTIVE: 'session:clear_active',
  SESSION_DELETE: 'session:delete',
  /** Fired after durable deletion with a per-window working-set snapshot. */
  SESSION_DELETED: 'session:deleted',
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
  SESSION_SET_SERVICE_TIER: 'session:set_service_tier',
  SESSION_GET_SERVICE_TIER_CONFIG: 'session:get_service_tier_config',
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

  // Project trust
  /** Fetch trust state + surface report for one project dir. */
  PROJECT_TRUST_GET: 'project:trust_get',
  /** Grant or revoke trust for one project dir. */
  PROJECT_TRUST_SET: 'project:trust_set',
  /** List trusted-project entries (settings panel). */
  PROJECT_TRUST_LIST: 'project:trust_list',
  /** Push event: trust state changed for one project dir. */
  PROJECT_TRUST_CHANGED: 'project:trust_changed',

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
  BG_CMD_LIST: 'bgcmd:list',
  BG_CMD_SEND_INPUT: 'bgcmd:send_input',
  BG_CMD_TERMINATE: 'bgcmd:terminate',
  BG_CMD_RELEASE_INPUT: 'bgcmd:release_input',
  /** Push event: a session's background fleet changed (spawn/exit/eviction). */
  BG_CMD_CHANGED: 'bgcmd:changed',

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

  // Analytics
  ANALYTICS_OVERVIEW: 'analytics:overview',
  ANALYTICS_SESSIONS: 'analytics:sessions',
  ANALYTICS_SESSION_DETAIL: 'analytics:session_detail',
  ANALYTICS_MODELS: 'analytics:models',
  ANALYTICS_TOOLS: 'analytics:tools',
  ANALYTICS_SUBAGENTS: 'analytics:subagents',
  ANALYTICS_CONTEXT: 'analytics:context',
} as const;

export type IPCChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ── Allowed invoke channels (preload security gate) ──────────────────────────

export const ALLOWED_INVOKE_CHANNELS = [
  IPC_CHANNELS.STARTUP_SNAPSHOT,
  IPC_CHANNELS.STARTUP_CONTINUE_DEGRADED,
  IPC_CHANNELS.CHAT_SEND,
  IPC_CHANNELS.CHAT_CANCEL,
  IPC_CHANNELS.CHAT_QUEUE_NEXT,
  IPC_CHANNELS.CHAT_STOP,
  IPC_CHANNELS.CHAT_SNAPSHOT,
  IPC_CHANNELS.SUBAGENTS_SNAPSHOT,
  IPC_CHANNELS.SUBAGENTS_DETAIL,
  IPC_CHANNELS.CONFIG_GET,
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
  IPC_CHANNELS.PROVIDERS_DELETE,
  IPC_CHANNELS.PROVIDERS_MODEL_LIST,
  IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS,
  IPC_CHANNELS.PROVIDERS_STATUS_REFRESH,
  IPC_CHANNELS.PROVIDERS_QUOTA_REFRESH,
  IPC_CHANNELS.SESSION_LIST,
  IPC_CHANNELS.SESSION_LOAD,
  IPC_CHANNELS.SESSION_OPEN,
  IPC_CHANNELS.SESSION_HISTORY_PAGE,
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
  IPC_CHANNELS.SESSION_SET_SERVICE_TIER,
  IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG,
  IPC_CHANNELS.SESSION_ACTIVITY_LIST,
  IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN,
  IPC_CHANNELS.SESSION_WORKING_SET_GET,
  IPC_CHANNELS.SESSION_WORKING_SET_OPEN_OR_FOCUS,
  IPC_CHANNELS.SESSION_WORKING_SET_CLOSE,
  IPC_CHANNELS.SESSION_WORKING_SET_REMOVE,
  IPC_CHANNELS.SESSION_WORKING_SET_SET_FOCUS,
  IPC_CHANNELS.PROJECT_TRUST_GET,
  IPC_CHANNELS.PROJECT_TRUST_SET,
  IPC_CHANNELS.PROJECT_TRUST_LIST,
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
  IPC_CHANNELS.BG_CMD_LIST,
  IPC_CHANNELS.BG_CMD_SEND_INPUT,
  IPC_CHANNELS.BG_CMD_TERMINATE,
  IPC_CHANNELS.BG_CMD_RELEASE_INPUT,
  IPC_CHANNELS.ASK_QUESTION_SNAPSHOT,
  IPC_CHANNELS.ASK_QUESTION_ANSWER,
  IPC_CHANNELS.ASK_QUESTION_CANCEL,
  IPC_CHANNELS.PERMISSION_APPROVAL_ANSWER,
  IPC_CHANNELS.PERMISSION_SNAPSHOT,
  IPC_CHANNELS.PERMISSION_SET_SESSION_MODE,
  IPC_CHANNELS.PERMISSION_GET_SESSION_MODE,
  IPC_CHANNELS.ANALYTICS_OVERVIEW,
  IPC_CHANNELS.ANALYTICS_SESSIONS,
  IPC_CHANNELS.ANALYTICS_SESSION_DETAIL,
  IPC_CHANNELS.ANALYTICS_MODELS,
  IPC_CHANNELS.ANALYTICS_TOOLS,
  IPC_CHANNELS.ANALYTICS_SUBAGENTS,
  IPC_CHANNELS.ANALYTICS_CONTEXT,
] as const satisfies readonly IPCChannel[];

// ── Allowed event channels (preload security gate) ───────────────────────────

export const ALLOWED_EVENT_CHANNELS = [
  IPC_CHANNELS.STARTUP_CHANGED,
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
  IPC_CHANNELS.SESSION_DELETED,
  IPC_CHANNELS.SESSION_RENAMED,
  IPC_CHANNELS.SESSION_CREATED,
  IPC_CHANNELS.SESSION_UPDATED,
  IPC_CHANNELS.SESSION_WORKSPACE_CHANGED,
  IPC_CHANNELS.SESSION_SUBAGENTS_CHANGED,
  IPC_CHANNELS.SESSION_TODOS_CHANGED,
  IPC_CHANNELS.SESSION_ACTIVITY_CHANGED,
  IPC_CHANNELS.SESSION_WORKING_SET_CHANGED,
  IPC_CHANNELS.PROJECT_TRUST_CHANGED,
  IPC_CHANNELS.RAG_PROGRESS,
  IPC_CHANNELS.AST_PROGRESS,
  IPC_CHANNELS.BG_CMD_CHANGED,
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
