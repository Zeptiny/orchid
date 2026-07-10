/**
 * Config schema — single source of truth for types, defaults, and validation.
 *
 * 22 fields ported from Python `src/orchid/config.py` lines 40–104, plus
 * Electron-only `default_project_dir` for sticky session workspace default.
 */
import * as path from 'node:path';
import { z } from 'zod';
import type { Config } from '../../shared/types/ipc-boundary';

export type { Config, RAGConfig, ModelMetadata } from '../../shared/types/ipc-boundary';

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
});

/**
 * Per-model metadata overrides that can be set in provider config.
 * When present, these override the built-in defaults in model-metadata.ts.
 */
export const modelMetadataOverridesSchema = z.object({
  max_input_tokens: z.number().int().positive().nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  supports_vision: z.boolean().optional(),
  mode: z.enum(['chat', 'completion']).optional(),
});

// ---------------------------------------------------------------------------
// Main config schema
// ---------------------------------------------------------------------------

export const configSchema = z
  .object({
    default_model: z.string().min(1).default('default/mimo-v2.5'),
    tier_models: z
      .record(z.string(), z.string())
      .default({
        seed: 'default/mimo-v2.5',
        sprout: 'default/mimo-v2.5',
        bloom: 'default/mimo-v2.5',
        crown: 'default/mimo-v2.5',
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
      .default({
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
        },
      }),
    providers: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .default({
        default: {
          base_url: 'https://opencode.ai/zen/go/v1',
          litellm_provider: 'openai',
          models: { 'mimo-v2.5': {} },
        },
      }),
    llm_stream_idle_timeout: z.number().positive().default(300.0),
    llm_stream_retries: z.number().int().nonnegative().default(3),
    background_command_idle_timeout: z.number().positive().default(900.0),
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
