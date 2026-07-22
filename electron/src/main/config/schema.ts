/**
 * Config schema — single source of truth for types, defaults, and validation.
 *
 * Fields ported from Python `src/orchid/config.py`, plus Electron-only
 * `default_project_dir` and UI prefs such as `always_expand_tool_groups`.
 */
import * as path from 'node:path';
import { z } from 'zod';
import type { Config } from '../../shared/types/ipc-boundary';
import { modelSelectionSchema } from '../../shared/types/provider';

export type { Config, RAGConfig, ModelMetadata } from '../../shared/types/ipc-boundary';
export { modelSelectionSchema, type ModelSelection } from '../../shared/types/provider';

// ---------------------------------------------------------------------------
// Nested schemas
// ---------------------------------------------------------------------------

export const ragConfigSchema = z.object({
  chunk_size: z.number().int().positive().default(2000),
  chunk_overlap: z.number().int().nonnegative().default(200),
  top_k: z.number().int().positive().default(5),
  max_file_size: z.number().int().positive().default(512000),
  embedding_model: z
    .string()
    .min(1)
    .default('fastembed/BAAI/bge-small-en-v1.5'),
  // Resource caps for local ONNX embeddings (indexing + search).
  // Defaults keep RAG from saturating all cores / huge tensors.
  embedding_threads: z.number().int().min(1).max(64).default(2),
  embedding_batch_size: z.number().int().min(1).max(256).default(16),
  /** Optional API embedder, bound to the same connection/model identity as chat. */
  embedding_api_model: modelSelectionSchema.nullable().default(null),
});

/**
 * Kept solely so existing config IPC consumers can keep reading the field
 * while connections move to their own store. It must never carry a legacy
 * configured provider, endpoint, or credential.
 */
const deprecatedProvidersSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .refine((providers) => Object.keys(providers).length === 0, {
    message: 'providers is deprecated and must be empty',
  });

// ---------------------------------------------------------------------------
// Main config schema
// ---------------------------------------------------------------------------

export const configSchema = z
  .object({
    default_model: modelSelectionSchema.nullable().default(null),
    tier_models: z
      .record(z.string(), modelSelectionSchema.nullable())
      .default({
        seed: null,
        sprout: null,
        bloom: null,
        crown: null,
      }),
    tier_reasoning_effort: z
      .record(
        z.string(),
        z
          .union([
            z.string().trim().min(1).max(256),
            z.number().int().min(1).max(1_000_000),
          ])
          .nullable(),
      )
      .default({
        seed: null,
        sprout: null,
        bloom: null,
        crown: null,
      }),
    ignored_dirs: z
      .array(z.string())
      .default([
        '.git',
        '.svn',
        '.hg',
        'node_modules',
        '__pycache__',
        'venv',
        '.venv',
        'env',
        'dist',
        'build',
        'target',
        '.idea',
        '.vscode',
        '.vs',
        '.mypy_cache',
        '.pytest_cache',
        '.ruff_cache',
        '.tox',
        '.nox',
        '.eggs',
        '*.egg-info',
      ]),
    command_timeout: z.number().int().positive().default(30),
    read_line_limit: z.number().int().positive().default(1000),
    grep_max_results: z.number().int().positive().default(100),
    directory_tree_depth: z.number().int().positive().default(2),
    theme: z.string().min(1).default('default'),
    personality: z.string().min(1).default('default'),
    rag: ragConfigSchema.default({}),
    ast_max_file_size: z.number().int().positive().default(1_048_576),
    mcp_startup_timeout: z.number().positive().default(60.0),
    mcp_per_server_timeout: z.number().positive().default(10.0),
    mcp_servers: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .default({}),
    providers: deprecatedProvidersSchema.default({}),
    llm_stream_idle_timeout: z.number().positive().default(300.0),
    llm_stream_retries: z.number().int().nonnegative().default(3),
    background_command_idle_timeout: z.number().positive().default(900.0),
    /**
     * Max multi-step tool-loop iterations per stream (AI SDK stopWhen).
     * Python's tool loop is unbounded; 100 is a high practical default.
     */
    max_tool_steps: z.number().int().positive().default(100),
    permission_history_size: z.number().int().min(0).max(50).default(10),
    permissions: z
      .record(
        z.string(),
        z.union([
          z.enum(['allow', 'ask', 'decide-for-me', 'ask-when-flagged']),
          z.object({
            inside: z.enum(['allow', 'ask', 'decide-for-me', 'ask-when-flagged']),
            outside: z.enum(['allow', 'ask', 'decide-for-me', 'ask-when-flagged']),
          }),
        ]),
      )
      .default({}),
    /**
     * Sticky home-config default project directory for new sessions.
     * Empty string is treated as null. When non-null, must be absolute.
     * Never invented from process.cwd().
     */
    default_project_dir: z.preprocess(
      (val) => (val === '' || val === undefined ? null : val),
      z
        .string()
        .nullable()
        .default(null)
        .refine((val) => val === null || path.isAbsolute(val), {
          message: 'default_project_dir must be an absolute path when set',
        }),
    ),
    /**
     * When true, chat tool-activity groups open by default (list individual
     * tool rows). When false (default), groups stay collapsed until clicked.
     */
    always_expand_tool_groups: z.boolean().default(false),
    /**
     * When true, first-run onboarding has been finished or skipped and must
     * not auto-open again. New installs default to false; existing home
     * configs missing this key are upgraded to true at load time.
     */
    has_completed_onboarding: z.boolean().default(false),
  })
  .strict();

/**
 * Deep-partial input type for parsing raw JSON from config files.
 * Every level is optional so partial project configs merge cleanly.
 */
export type ConfigDeepPartialInput = z.input<
  ReturnType<typeof configSchema.deepPartial>
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a full default Config (all fields populated). */
export function defaults(): Config {
  return configSchema.parse({});
}

/**
 * Parse a raw JSON value that may be a partial config (e.g. a project config
 * that only specifies a few overrides).  Returns a deep-partial object
 * suitable for merging with defaults.
 */
export function parsePartial(raw: unknown): ConfigDeepPartialInput {
  return configSchema.deepPartial().parse(raw);
}
