/**
 * Config schema — single source of truth for types, defaults, and validation.
 */
import * as path from 'node:path';
import { z } from 'zod';
import type { Config } from '../../shared/types/ipc-boundary';
import { PERMISSION_MODE_VALUES } from '../../shared/types/permission';
import { modelSelectionSchema } from '../../shared/types/provider';
import { COMPACTION_MODES } from '../../shared/types/message';
export { COMPACTION_MODES };

export type {
  Config,
  RAGConfig,
  AgentsMdConfig,
  AgentsMdEnforcePolicy,
  SubagentsConfig,
  CompactionConfig,
  CompactionScopeConfig,
  CompactionMode,
} from '../../shared/types/ipc-boundary';
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
  embedding_api_timeout: z.number().positive().default(30),
  embedding_api_retries: z.number().int().min(0).max(10).default(3),
  /** Abort a model download that stops making progress. */
  model_download_inactivity_timeout: z.number().positive().default(30),
  /** Hard cap for one model-file download, even if bytes continue flowing. */
  model_download_total_timeout: z.number().positive().default(900),
  /** Optional API embedder, bound to the same connection/model identity as chat. */
  embedding_api_model: modelSelectionSchema.nullable().default(null),
});

export const permissionRuleSchema = z.union([
  z.enum(PERMISSION_MODE_VALUES),
  z.object({
    inside: z.enum(PERMISSION_MODE_VALUES),
    outside: z.enum(PERMISSION_MODE_VALUES),
  }).strict(),
]);

export const permissionsConfigSchema = z.record(z.string(), permissionRuleSchema);

/** Write-enforcement policies for unseen governing AGENTS.md files. */
export const AGENTS_MD_ENFORCE_POLICIES = ['block', 'inject', 'warn', 'off'] as const;

/**
 * AGENTS.md discovery, injection, and write-enforcement settings. Mirrors the
 * `rag` nested object: per-field defaults, referenced as `agents_md` with an
 * explicit `.default({})` so partial project overrides deep-merge cleanly.
 */
export const agentsMdConfigSchema = z.object({
  enabled: z.boolean().default(true),
  filenames: z.array(z.string()).max(16).default(['AGENTS.md', 'CLAUDE.md']),
  // Bounded so a hostile project `.orchid.json` cannot OOM the main process
  // (`readAgentsMdContent` does `Buffer.alloc(max_file_bytes)`) or walk forever.
  max_file_bytes: z.number().int().positive().max(2_097_152).default(32768),
  max_chain_depth: z.number().int().positive().max(32).default(8),
  enforce_on_write: z.enum(AGENTS_MD_ENFORCE_POLICIES).default('warn'),
  inject_on_read: z.boolean().default(true),
  include_local: z.boolean().default(false),
});

/**
 * Subagent live-event batching, admission, retention, and prompt-context
 * settings. Mirrors the `rag`/`agents_md` nested objects: per-field defaults,
 * referenced as `subagents` with an explicit `.default({})` so partial project
 * overrides deep-merge cleanly. All knobs for the live/durable separation
 * (batcher, persistence wave, admission, eviction, prompt bounding) are
 * collected here in one unit to avoid repeated schema churn.
 */
export const subagentsConfigSchema = z.object({
  event_max_per_flush: z.number().int().min(1).max(100_000).default(200),
  event_byte_budget_kb: z.number().int().min(1).max(65_536).default(64),
  usage_event_interval_ms: z.number().int().min(0).max(3_600_000).default(1000),
  hydration_buffer_kb: z.number().int().min(1).max(65_536).default(256),
  terminal_wave_ms: z.number().int().min(0).max(60_000).default(250),
  max_active_global: z.number().int().min(1).max(256).default(8),
  max_active_per_session: z.number().int().min(1).max(256).default(4),
  max_queued: z.number().int().min(0).max(1024).default(32),
  terminal_retention: z.number().int().min(0).max(1000).default(25),
  prompt_recent_terminal: z.number().int().min(0).max(100).default(5),
  prompt_task_max_chars: z.number().int().min(0).max(100_000).default(200),
});

export const compactionScopeSchema = z.object({
  mode: z.enum(COMPACTION_MODES).default('simple'),
  threshold: z.number().min(0.1).max(0.95).default(0.8),
  model: modelSelectionSchema.nullable().default(null),
  agent_name: z.literal('compactor').default('compactor'),
  preserve_percent: z.number().min(0.05).max(0.9).default(0.25),
  // Deprecated: replaced by preserve_percent. Parsed (accepted) but ignored.
  // The transform is pure (schema only); the deprecation warning is emitted
  // from the config load path (loader.ts loadConfig) so users know to migrate.
  keep_recent_chains: z.number().int().min(0).max(100).optional().transform(() => undefined),
  min_compactable_tokens: z.number().int().min(0).max(1_000_000).default(4000),
  mechanical_reclaim: z.boolean().default(true),
  hysteresis_delta: z.number().min(0).max(0.5).default(0.1),
  // R31/R33: the last K user messages stay in the model view across compaction
  // (never flagged). null disables tail pinning for the main scope. The
  // subagent scope overrides this to null (= ALL user messages pinned, R32).
  keep_last_user_messages: z.number().int().min(1).max(1000).nullable().default(10),
  // R33: pin the session's FIRST user message so the opening intent survives
  // every compaction cycle. Harmless under the subagent all-pin default.
  pin_first_user_message: z.boolean().default(true),
});

export const compactionSubagentsScopeSchema = compactionScopeSchema
  .extend({
    threshold: z.number().min(0.1).max(0.95).default(0.85),
    agent_name: z.literal('compactor-subagent').default('compactor-subagent'),
    // R32 hard guarantee: every user message stays in model view for a
    // subagent run's entire lifetime. null = ALL (no tail cap).
    keep_last_user_messages: z.number().int().min(1).max(1000).nullable().default(null),
    pin_first_user_message: z.boolean().default(true),
  });

export const compactionConfigSchema = z.object({
  main: compactionScopeSchema.default({}),
  subagents: compactionSubagentsScopeSchema.default({}),
}).default({});

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
    tool_worker_pool_size: z.number().int().min(0).max(8).default(2),
    /**
     * Worker slots reserved for main-agent tool work. Main-agent tasks dispatch
     * ahead of subagent tasks and keep this many workers guaranteed; the rest
     * are guaranteed to subagent work, so neither lane can starve the other
     * (review F-06). Clamped to `[0, tool_worker_pool_size - 1]` by the pool;
     * a configured 0 floors to 1 so a queued subagent wave cannot starve the
     * visible main agent.
     */
    tool_worker_pool_main_agent_reserved: z.number().int().min(0).max(8).default(1),
    theme: z.string().min(1).default('default'),
    personality: z.string().min(1).default('default'),
    rag: ragConfigSchema.default({}),
    agents_md: agentsMdConfigSchema.default({}),
    subagents: subagentsConfigSchema.default({}),
    compaction: compactionConfigSchema,
    ast_max_file_size: z.number().int().positive().default(1_048_576),
    mcp_startup_timeout: z.number().positive().default(60.0),
    mcp_per_server_timeout: z.number().positive().default(10.0),
    mcp_servers: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .default({}),
    llm_stream_idle_timeout: z.number().positive().default(300.0),
    llm_stream_retries: z.number().int().nonnegative().default(3),
    background_command_idle_timeout: z.number().positive().default(900.0),
    /**
     * Max seconds to wait after a turn starts before auto-naming a
     * default-named session from the current (possibly still in-flight)
     * conversation history. 0 disables the deadline entirely; naming then
     * only happens when a turn completes or is interrupted.
     */
    session_title_max_wait_seconds: z.number().min(0).default(15),
    /**
     * Max multi-step tool-loop iterations per stream (AI SDK stopWhen).
     */
    max_tool_steps: z.number().int().positive().default(100),
    permission_history_size: z.number().int().min(0).max(50).default(10),
    permissions: z
      .record(z.string(), permissionRuleSchema)
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
    command_max_output_bytes: z.number().int().positive().default(1_048_576),
    tool_output_inline_threshold: z.number().int().positive().default(20_000),
    approval_timeout: z.number().positive().max(3600).default(600),
    subagent_wait_timeout: z.number().positive().max(3600).default(300),
    web_fetch_timeout: z.number().positive().max(300).default(30),
    web_fetch_max_body_bytes: z.number().int().positive().default(10_485_760),
    web_fetch_user_agent: z.string().min(1).default('Orchid/1.0 web-fetch (Electron)'),
    bg_prompt_max_entries: z.number().int().min(1).max(50).default(5),
    bg_prompt_tail_lines: z.number().int().min(1).max(100).default(8),
    bg_prompt_tail_chars: z.number().int().positive().default(500),
    mcp_result_max_bytes: z.number().int().positive().default(5_242_880),
    max_background_processes: z.number().int().min(1).max(256).default(64),
    bg_output_head_bytes: z.number().int().positive().default(524_288),
    bg_output_tail_bytes: z.number().int().positive().default(524_288),
    grep_per_file_timeout: z.number().positive().default(10),
    read_output_long_poll_max: z.number().positive().max(300).default(60),
    llm_retry_backoff_base: z.number().min(0.01).max(10).default(0.2),
    llm_retry_max_delay: z.number().positive().max(300).default(30),
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
