/**
 * Tool widget types — shared types for the tool-call widget system.
 *
 * A ToolCallEvent represents a single tool invocation with its full lifecycle:
 * pending → running → completed | error.
 *
 * These events are persisted in sessions and replayed on restore.
 */

// ── Tool call lifecycle ──────────────────────────────────────────────────────

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'error';

/**
 * A structured, persisted tool-call event.
 * Sessions replay exact widget state on restore.
 */
export interface ToolCallEvent {
  /** Unique ID (matches the tool_call.id from the LLM). */
  readonly id: string;
  /** Tool name (e.g. 'edit', 'execute_command', 'read', 'grep'). */
  readonly toolName: string;
  /** Parsed arguments object. */
  readonly args: Record<string, unknown>;
  /** Current lifecycle status. */
  readonly status: ToolCallStatus;
  /** Result content (populated on completion). */
  readonly result: string | null;
  /** Error message (populated on error). */
  readonly error: string | null;
  /** Timestamp when the tool call started. */
  readonly startedAt: string;
  /** Timestamp when the tool call finished (null while running). */
  readonly finishedAt: string | null;
}

// ── Diff data ────────────────────────────────────────────────────────────────

export interface DiffData {
  /** Original file content. */
  readonly original: string;
  /** Modified file content. */
  readonly modified: string;
  /** File path (for syntax highlighting). */
  readonly filePath: string;
  /** Language ID derived from file extension. */
  readonly language: string;
}

// ── Grep result row ──────────────────────────────────────────────────────────

export interface GrepResultRow {
  /** File path. */
  readonly file: string;
  /** Line number (1-indexed). */
  readonly line: number;
  /** Matched text content. */
  readonly text: string;
}

// ── File preview data ────────────────────────────────────────────────────────

export interface FilePreviewData {
  /** File path. */
  readonly filePath: string;
  /** File content (possibly truncated). */
  readonly content: string;
  /** Language ID for syntax highlighting. */
  readonly language: string;
  /** Starting line number (for offset reads). */
  readonly startLine: number;
}

// ── Widget routing map ───────────────────────────────────────────────────────

/** Tools that produce a diff view. */
export const DIFF_TOOLS = new Set([
  'edit',
  'write',
  'replace_symbol',
  'rename_symbol',
]);

/** Tools that produce a terminal view. */
export const TERMINAL_TOOLS = new Set([
  'execute_command',
]);

/** Tools that produce a file preview. */
export const FILE_PREVIEW_TOOLS = new Set([
  'read',
]);

/** Tools that produce a results table. */
export const RESULTS_TABLE_TOOLS = new Set([
  'grep',
]);

// ── Language detection ───────────────────────────────────────────────────────

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.xml': 'xml',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.toml': 'toml',
  '.ini': 'ini',
  '.env': 'shell',
  '.dockerfile': 'dockerfile',
  '.graphql': 'graphql',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

/**
 * Detect language from file path extension.
 * Falls back to 'plaintext' for unknown extensions.
 */
export function detectLanguage(filePath: string): string {
  const ext = filePath.lastIndexOf('.');
  if (ext === -1) return 'plaintext';
  const extension = filePath.slice(ext).toLowerCase();
  return EXT_TO_LANGUAGE[extension] ?? 'plaintext';
}
