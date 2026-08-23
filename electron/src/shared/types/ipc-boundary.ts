/**
 * IPC Boundary Types — types that cross the main↔renderer IPC boundary.
 *
 * These types are the canonical source for the IPC contract. Both main-process
 * modules and renderer modules import from here, inverting the dependency so
 * renderer never reaches into main/.
 *
 * Rule: only pure cross-boundary contract definitions live here. No Zod
 * schemas and no main-process imports.
 */

import type { ModelSelection } from './provider';
import type { PermissionMode } from './permission';
import type { RemoteMachineRecord } from './machine';
import { COMPACTION_MODES } from './message';

// ── Startup ─────────────────────────────────────────────────────────────────

export const STARTUP_STEP_DEFINITIONS = [
  { id: 'opening_window', label: 'Opening window' },
  { id: 'settings_providers', label: 'Loading settings and providers' },
  { id: 'agents_tools', label: 'Loading agents and tools' },
  { id: 'tool_workers', label: 'Starting tool workers' },
  { id: 'preparing_interface', label: 'Preparing the application interface' },
] as const;

export type StartupStepId = (typeof STARTUP_STEP_DEFINITIONS)[number]['id'];

export type StartupStepState = 'pending' | 'active' | 'complete' | 'skipped' | 'warning' | 'failed';
export type StartupPhase = 'starting' | 'ready' | 'degraded' | 'failed';
export type ToolWorkerStartupOutcome = 'disabled' | 'success' | 'failure';

export interface StartupStep {
  readonly id: StartupStepId;
  readonly label: string;
  readonly state: StartupStepState;
  /** Monotonic elapsed time once the step has settled; never wall-clock data. */
  readonly durationMs: number | null;
}

export interface StartupSnapshot {
  /** Main-owned monotonic revision; renderers ignore revisions at or below their floor. */
  readonly revision: number;
  readonly phase: StartupPhase;
  readonly steps: readonly StartupStep[];
}

export interface StartupContinueDegradedResult {
  readonly ok: boolean;
  readonly snapshot: StartupSnapshot;
}

// ── Session ─────────────────────────────────────────────────────────────────

export interface SessionSummary {
  readonly id: string;
  readonly name: string;
  /** Display-only historical model label; not an executable provider reference. */
  readonly modelLabel: string | null;
  /**
   * Absolute working directory for the session.
   * `null` when unbound or for legacy sessions without a stored cwd.
   */
  readonly cwd: string | null;
  readonly chainCount: number;
  readonly updatedAt: number;
}

export type SessionExecutionState =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'needs_attention';

export type SessionActivityPhase =
  | 'agent'
  | 'tool'
  | 'subagent'
  | 'command'
  | null;

/** Process-wide execution status for one independently running session. */
export interface SessionActivity {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly state: SessionExecutionState;
  readonly phase: SessionActivityPhase;
  readonly detail: string | null;
  readonly startedAt: number | null;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly unread: boolean;
  readonly backgroundProcessCount: number;
  readonly canCancel: boolean;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface RAGConfig {
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  max_file_size: number;
  embedding_model: string;
  /**
   * ONNX Runtime intra/inter-op thread count for embedding inference.
   * Caps CPU use during RAG indexing / search (default 2).
   */
  embedding_threads: number;
  /**
   * Max texts embedded in one ONNX forward pass (memory + peak CPU).
   * Default 16 (was a hard-coded 100).
   */
  embedding_batch_size: number;
  embedding_api_timeout: number;
  embedding_api_retries: number;
  model_download_inactivity_timeout: number;
  model_download_total_timeout: number;
  /** Optional connection-scoped API embedding model; null keeps ONNX local. */
  embedding_api_model: ModelSelection | null;
}

/** Write-enforcement policy applied when a governing AGENTS.md is not in context. */
export type AgentsMdEnforcePolicy = 'block' | 'inject' | 'warn' | 'off';

/**
 * AGENTS.md discovery, injection, and write-enforcement settings. See the
 * `agents_md` block in the config schema for field defaults.
 */
export interface AgentsMdConfig {
  enabled: boolean;
  /** Ordered instruction-file aliases; first present per directory wins. */
  filenames: string[];
  max_file_bytes: number;
  max_chain_depth: number;
  enforce_on_write: AgentsMdEnforcePolicy;
  inject_on_read: boolean;
  /** When true, also consider `AGENTS.local.md` as a lowest-precedence alias. */
  include_local: boolean;
}

/**
 * Index auto-refresh settings (tool mutations, watcher events, and command
 * dirty-scans feed one debounced refresh pipeline). See the `index_refresh`
 * block in the config schema for field defaults.
 */
export interface IndexRefreshConfig {
  /** Refresh the RAG vector index for detected mutations. */
  rag: boolean;
  /** Refresh the AST symbol index for detected mutations. */
  ast: boolean;
  /** Watch the bound workspace for external changes. */
  watch: boolean;
  /** Coalescing window (ms) before a project's refresh batch flushes. */
  debounce_ms: number;
}

/**
 * Subagent live-event batching, admission, retention, and prompt-context
 * settings. See the `subagents` block in the config schema for field defaults.
 * All knobs are collected here so later units (persistence, admission,
 * eviction, prompt bounding) do not churn the schema.
 */
export interface SubagentsConfig {
  /** Max delta events delivered in one batched flush across all subagents. */
  event_max_per_flush: number;
  /** Soft byte budget (KB) for one batched flush; overflow is deferred. */
  event_byte_budget_kb: number;
  /** Min interval (ms) between per-subagent `usage` deltas; 0 emits every one. */
  usage_event_interval_ms: number;
  /** Renderer hydration event buffer cap (KB) before revision-floor reseed. */
  hydration_buffer_kb: number;
  /** Window (ms) batching near-simultaneous terminal persistence flushes. */
  terminal_wave_ms: number;
  /** Max concurrently running subagents across all sessions. */
  max_active_global: number;
  /** Max concurrently running subagents within one session. */
  max_active_per_session: number;
  /** Max queued (admitted-but-not-started) subagents before rejection. */
  max_queued: number;
  /** Bounded count of recent terminal summaries retained after eviction. */
  terminal_retention: number;
  /** Recent terminal summaries included in the dynamic system prompt. */
  prompt_recent_terminal: number;
  /** Task-text cap (chars) for terminal summaries rendered into the prompt. */
  prompt_task_max_chars: number;
}

export { COMPACTION_MODES };
export type CompactionMode = (typeof COMPACTION_MODES)[number];

export interface CompactionScopeConfig {
  mode: CompactionMode;
  threshold: number;
  model: ModelSelection | null;
  agent_name: string;
  preserve_percent: number;
  min_compactable_tokens: number;
  mechanical_reclaim: boolean;
  hysteresis_delta: number;
  /** R31/R33: last K user messages kept in model view; null = all (subagent default). */
  keep_last_user_messages: number | null;
  /** R33: pin the session's first user message across every compaction cycle. */
  pin_first_user_message: boolean;
}

export interface CompactionConfig {
  main: CompactionScopeConfig;
  subagents: CompactionScopeConfig;
}

export type PermissionModeValue = PermissionMode;

export type PermissionRule =
  | PermissionModeValue
  | { inside: PermissionModeValue; outside: PermissionModeValue };

export interface Config {
  /**
   * The selected connection and model for new work. `null` keeps Orchid in
   * local-only mode until the user chooses a provider connection.
   */
  default_model: ModelSelection | null;
  /** Per-tier connection-scoped selections. A null tier falls back to the nullable default. */
  tier_models: Record<string, ModelSelection | null>;
  /** Per-tier reasoning effort override. Null tier falls back to connection default. */
  tier_reasoning_effort: Record<string, string | number | null>;
  ignored_dirs: string[];
  command_timeout: number;
  read_line_limit: number;
  grep_max_results: number;
  directory_tree_depth: number;
  tool_worker_pool_size: number;
  /**
   * Worker slots reserved for main-agent tool work so background subagents
   * cannot starve the visible agent (review F-06). Clamped to the pool size.
   */
  tool_worker_pool_main_agent_reserved: number;
  theme: string;
  personality: string;
  rag: RAGConfig;
  agents_md: AgentsMdConfig;
  index_refresh: IndexRefreshConfig;
  subagents: SubagentsConfig;
  compaction: CompactionConfig;
  ast_max_file_size: number;
  mcp_startup_timeout: number;
  mcp_per_server_timeout: number;
  mcp_servers: Record<string, Record<string, unknown>>;
  llm_stream_idle_timeout: number;
  llm_stream_retries: number;
  /** Raw provider request/response debug capture gate (issue 146). */
  debug_capture_requests: boolean;
  background_command_idle_timeout: number;
  /**
   * Max seconds after a turn starts before a still-default-named session is
   * auto-named from the current in-flight history. `0` disables the deadline;
   * naming then only happens when a turn completes or is interrupted.
   */
  session_title_max_wait_seconds: number;
  /**
   * Max multi-step tool-loop iterations per LLM stream (AI SDK stopWhen).
   * Default 100 — high enough for real agent workloads, not unbounded.
   */
  max_tool_steps: number;
  permission_history_size: number;
  permissions: Record<string, PermissionRule>;
  /**
   * Sticky default project directory for new sessions / draft workspace.
   * Absolute path when set; `null` when unbound (never invented from process.cwd()).
   */
  default_project_dir: string | null;
  /**
   * When true, compact tool-activity groups in the chat stream start expanded
   * (showing individual tool rows). Default false — groups stay collapsed.
   */
  always_expand_tool_groups: boolean;
  /**
   * When true, first-run onboarding has been finished or skipped.
   * New installs default to false; missing key on existing home configs
   * is treated as true at load so upgrades are not re-onboarded.
   */
  has_completed_onboarding: boolean;
  command_max_output_bytes: number;
  tool_output_inline_threshold: number;
  approval_timeout: number;
  subagent_wait_timeout: number;
  web_fetch_timeout: number;
  web_fetch_max_body_bytes: number;
  web_fetch_user_agent: string;
  bg_prompt_max_entries: number;
  bg_prompt_tail_lines: number;
  bg_prompt_tail_chars: number;
  mcp_result_max_bytes: number;
  max_background_processes: number;
  bg_output_head_bytes: number;
  bg_output_tail_bytes: number;
  grep_per_file_timeout: number;
  read_output_long_poll_max: number;
  llm_retry_backoff_base: number;
  llm_retry_max_delay: number;
  /**
   * User-added SSH remote machines. The implicit local machine is never
   * stored here; it is synthesized by the machine registry at read time.
   */
  machines: RemoteMachineRecord[];
}

// ── MCP ─────────────────────────────────────────────────────────────────────

export type MCPServerStatusValue = 'starting' | 'connected' | 'failed' | 'unavailable';

export interface MCPServerStatus {
  /** Server name (key from mcp_servers config). */
  name: string;
  /** Current lifecycle state. */
  status: MCPServerStatusValue;
  /** Number of tools discovered from this server. */
  toolCount: number;
  /** Un-namespaced names of tools discovered from this server. */
  tools: string[];
  /** Error message if status is "failed" or "unavailable", null otherwise. */
  error: string | null;
}

// ── RAG Store ───────────────────────────────────────────────────────────────

export interface RAGStoreStatus {
  totalChunks: number;
  totalFiles: number;
  lastIndexed: string | null;
  lastIndexDuration: number | null;
  /** When the background index auto-refresh last landed RAG work (null = never). */
  lastAutoRefresh: string | null;
}

/**
 * rag:status IPC response — store status plus the workspace-watcher slice.
 * `watcher` is additive and optional: it is absent when introspection is
 * unavailable, and consumers must tolerate its absence.
 */
export interface RAGStatusResponse extends RAGStoreStatus {
  /** Whether the workspace watcher has a live instance for this project. */
  watcher?: { watching: boolean };
}

// ── AST Store ───────────────────────────────────────────────────────────────

export interface ASTStoreStatus {
  totalFiles: number;
  totalSymbols: number;
  lastIndexed: string | null;
  lastIndexDuration: number | null;
  /** When the background index auto-refresh last landed AST work (null = never). */
  lastAutoRefresh: string | null;
}

// ── Index auto-refresh ───────────────────────────────────────────────────────

/**
 * `index:auto_refresh` push event — the background index auto-refresh
 * lifecycle for one project, as a phase machine:
 *
 * - `started`: a flush is running for the listed indexes (`true` = that index
 *   has work in this flush).
 * - `landed`: work completed for the listed indexes; carries fresh post-flush
 *   store statuses for each refreshed index.
 * - `settled`: the flush finished (landed, failed, timed out, or was
 *   requeued) — clears any in-progress indication. Always paired with a
 *   preceding `started`.
 */
export type IndexAutoRefreshEvent =
  | { phase: 'started'; rag: boolean; ast: boolean }
  | { phase: 'settled'; rag: boolean; ast: boolean }
  | {
      phase: 'landed';
      /** Fresh RAG store status (absent when RAG did not land work). */
      rag?: RAGStatusResponse;
      /** Fresh AST store status (absent when AST did not land work). */
      ast?: ASTStoreStatus;
    };

// ── RAG Indexer ─────────────────────────────────────────────────────────────

export interface RAGIndexResult {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  filesDeleted: number;
  chunksCreated: number;
  errors: string[];
  durationSeconds: number;
}

/** Queryable snapshot of an in-flight (or idle) index run. */
export interface IndexRunState<TProgress> {
  indexing: boolean;
  progress: TProgress | null;
}

/**
 * Live progress while a RAG index run is in flight (worker → main → renderer).
 */
export interface RAGIndexProgress {
  phase: 'discovering' | 'indexing' | 'finalizing' | 'done';
  /** Files processed so far (0 … total). */
  done: number;
  /** Total project files discovered for this run. */
  total: number;
  /** Relative path of the file currently being processed (if any). */
  currentFile?: string;
  filesIndexed: number;
  filesSkipped: number;
  chunksCreated: number;
  filesDeleted: number;
  /** Wall time so far in seconds (best-effort). */
  elapsedSeconds: number;
}

// ── AST Indexer ─────────────────────────────────────────────────────────────

export interface ASTIndexResult {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  filesDeleted: number;
  symbolsExtracted: number;
  errors: string[];
  durationSeconds: number;
}

/**
 * Live progress while an AST index run is in flight (worker → main → renderer).
 */
export interface ASTIndexProgress {
  phase: 'discovering' | 'indexing' | 'finalizing' | 'done';
  /** Files processed so far (0 … total). */
  done: number;
  /** Total source files discovered for this run. */
  total: number;
  /** Relative path of the file currently being processed (if any). */
  currentFile?: string;
  filesIndexed: number;
  filesSkipped: number;
  symbolsExtracted: number;
  filesDeleted: number;
  /** Wall time so far in seconds (best-effort). */
  elapsedSeconds: number;
}

// ── Updater ─────────────────────────────────────────────────────────────────

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error';

export interface UpdaterState {
  status: UpdateStatus;
  version: string | null;
  releaseNotes: string | null;
  progress: number | null;
  error: string | null;
}

// ── Commands ────────────────────────────────────────────────────────────────

export interface CommandContext {
  /** Create a new session and load it. */
  onCreateSession: () => Promise<void>;
  /** Load a session by ID. */
  onLoadSession: (id: string) => Promise<void>;
  /** Delete a session by ID. */
  onDeleteSession: (id: string) => Promise<void>;
  /** Rename the active session. */
  onRenameSession: (id: string, name: string) => Promise<void>;
  /** Get the active session ID (or null). */
  getActiveSessionId: () => string | null;
  /** Get the active session name (or null). */
  getActiveSessionName: () => string | null;
  /** Set the theme. */
  onSetTheme: (name: string) => Promise<void>;
  /** Set the personality. */
  onSetPersonality: (name: string) => Promise<void>;
  /** Set the active model selection. */
  onSetModel: (model: string) => Promise<void>;
  /** Return available model labels. */
  getAvailableModels: () => string[];
  /** Current model shown in the UI (session model or default). */
  getCurrentModel: () => string;
  /** Open settings (emits event for U24 Preferences). */
  onOpenSettings: () => void;
  /**
   * Open the project folder picker (binds draft/session + sticky default).
   * Used by `/cd` and workspace chrome.
   */
  onPickProjectDir?: () => Promise<void>;
  /** Index RAG in background. */
  onIndexRAG: () => Promise<void>;
  /** Index AST in background. */
  onIndexAST: () => Promise<void>;
  /** Clear RAG index. */
  onClearRAG: () => Promise<void>;
  /** Compact the active session's context (user-initiated /compact). */
  onCompact: () => Promise<void>;
  /** Show a notification message. */
  onNotify: (message: string, severity?: 'info' | 'warning' | 'error') => void;
  /** Close the command palette. */
  onClose: () => void;
}
