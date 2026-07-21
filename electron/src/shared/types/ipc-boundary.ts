/**
 * IPC Boundary Types — types that cross the main↔renderer IPC boundary.
 *
 * These types are the canonical source for the IPC contract. Both main-process
 * modules and renderer modules import from here, inverting the dependency so
 * renderer never reaches into main/.
 *
 * Rule: only pure interfaces and type aliases live here. No Zod schemas, no
 * runtime code, no main-process imports.
 */

import type { ModelSelection } from './provider';

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

export interface ModelMetadata {
  /** Maximum input tokens the model accepts. Null if unknown. */
  max_input_tokens: number | null;
  /** Maximum output tokens the model can generate. Null if unknown. */
  max_output_tokens: number | null;
  /** Whether the model supports image/vision inputs. */
  supports_vision: boolean;
}

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
  /** Optional connection-scoped API embedding model; null keeps ONNX local. */
  embedding_api_model: ModelSelection | null;
}

/** Non-secret notice about provider compatibility state discarded on load. */
export interface ConfigDiagnostic {
  readonly code: 'legacy-provider-config-reset';
  readonly message: string;
}

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
  theme: string;
  personality: string;
  rag: RAGConfig;
  ast_max_file_size: number;
  mcp_startup_timeout: number;
  mcp_per_server_timeout: number;
  mcp_servers: Record<string, Record<string, unknown>>;
  /**
   * Deprecated IPC compatibility field. Provider connections live outside
   * layered config; this map is always empty and must not carry credentials.
   */
  providers: Record<string, Record<string, unknown>>;
  llm_stream_idle_timeout: number;
  llm_stream_retries: number;
  background_command_idle_timeout: number;
  /**
   * Max multi-step tool-loop iterations per LLM stream (AI SDK stopWhen).
   * Default 100 — high enough for real agent workloads, not unbounded.
   */
  max_tool_steps: number;
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
  /** Error message if status is "failed" or "unavailable", null otherwise. */
  error: string | null;
}

// ── RAG Store ───────────────────────────────────────────────────────────────

export interface RAGStoreStatus {
  totalChunks: number;
  totalFiles: number;
  lastIndexed: string | null;
  lastIndexDuration: number | null;
}

// ── AST Store ───────────────────────────────────────────────────────────────

export interface ASTStoreStatus {
  totalFiles: number;
  totalSymbols: number;
  lastIndexed: string | null;
  lastIndexDuration: number | null;
}

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
  /**
   * U1 compatibility hook for the legacy command palette. It has no model
   * candidates until U8 replaces it with a connection-scoped selection.
   */
  onSetModel: (model: string) => Promise<void>;
  /** U1 returns no model candidates; U8 supplies typed selections. */
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
  /** Show a notification message. */
  onNotify: (message: string, severity?: 'info' | 'warning' | 'error') => void;
  /** Close the command palette. */
  onClose: () => void;
}
