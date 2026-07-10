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

// ── Session ─────────────────────────────────────────────────────────────────

export interface SessionSummary {
  readonly id: string;
  readonly name: string;
  readonly model: string | undefined;
  readonly chainCount: number;
  readonly updatedAt: number;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface ModelMetadata {
  /** Maximum input tokens the model accepts. Null if unknown. */
  max_input_tokens: number | null;
  /** Maximum output tokens the model can generate. Null if unknown. */
  max_output_tokens: number | null;
  /** Whether the model supports image/vision inputs. */
  supports_vision: boolean;
  /** Model operating mode. */
  mode: 'chat' | 'completion';
}

/**
 * A model discovered from a provider's `GET /models` endpoint.
 * Used by the renderer model picker to show available models.
 */
export interface DiscoveredModel {
  /** The model ID (e.g., 'gpt-4o', 'claude-3-5-sonnet-20241022'). */
  readonly id: string;
  /** Optional human-readable name. */
  readonly name?: string;
  /** Optional model owner/organization. */
  readonly owned_by?: string;
}

export interface RAGConfig {
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  max_file_size: number;
  embedding_model: string;
}

export interface Config {
  default_model: string;
  tier_models: Record<string, string>;
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
  providers: Record<string, Record<string, unknown>>;
  llm_stream_idle_timeout: number;
  llm_stream_retries: number;
  background_command_idle_timeout: number;
  /**
   * Sticky default project directory for new sessions / draft workspace.
   * Absolute path when set; `null` when unbound (never invented from process.cwd()).
   */
  default_project_dir: string | null;
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
   * Set the model for the active session (and local UI chrome).
   * `model` is a `provider/model` id from the providers config.
   */
  onSetModel: (model: string) => Promise<void>;
  /** Models available for /model picker (`provider/model` ids). */
  getAvailableModels: () => string[];
  /** Current model shown in the UI (session model or default). */
  getCurrentModel: () => string;
  /** Open settings (emits event for U24 Preferences). */
  onOpenSettings: () => void;
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
