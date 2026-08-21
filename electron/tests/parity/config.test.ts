/**
 * Config Parity Tests — U28.
 *
 * Protects the configuration contract established by the desktop migration.
 * Tests STRUCTURE (fields exist, types correct, defaults match), not behavior.
 */
import { describe, it, expect } from 'vitest';
import { configSchema, defaults } from '../../src/main/config/schema';

const DEFAULT_SELECTION = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelId: 'vendor/models/gpt-4o',
};

// ── Expected config fields (41 total) ──────────────────────────────────────

interface ConfigFieldExpectation {
  field: string;
  type: string;
  defaultValue: unknown;
  envOverride?: string;
}

const EXPECTED_FIELDS: ConfigFieldExpectation[] = [
  { field: 'default_model', type: 'nullable ModelSelection', defaultValue: null },
  {
    field: 'tier_models',
    type: 'record',
    defaultValue: { seed: null, sprout: null, bloom: null, crown: null },
  },
  {
    field: 'tier_reasoning_effort',
    type: 'record',
    defaultValue: { seed: null, sprout: null, bloom: null, crown: null },
  },
  { field: 'ignored_dirs', type: 'array', defaultValue: undefined }, // complex default, checked separately
  {
    field: 'command_timeout',
    type: 'number',
    defaultValue: 30,
    envOverride: 'ORCHID_COMMAND_TIMEOUT',
  },
  {
    field: 'read_line_limit',
    type: 'number',
    defaultValue: 1000,
    envOverride: 'ORCHID_READ_LINE_LIMIT',
  },
  {
    field: 'grep_max_results',
    type: 'number',
    defaultValue: 100,
    envOverride: 'ORCHID_GREP_MAX_RESULTS',
  },
  {
    field: 'directory_tree_depth',
    type: 'number',
    defaultValue: 2,
    envOverride: 'ORCHID_DIRECTORY_TREE_DEPTH',
  },
  { field: 'theme', type: 'string', defaultValue: 'default', envOverride: 'ORCHID_THEME' },
  {
    field: 'personality',
    type: 'string',
    defaultValue: 'default',
    envOverride: 'ORCHID_PERSONALITY',
  },
  { field: 'rag', type: 'object', defaultValue: undefined }, // nested, checked separately
  { field: 'agents_md', type: 'object', defaultValue: undefined }, // nested, checked separately
  { field: 'subagents', type: 'object', defaultValue: undefined }, // nested, checked separately
  {
    field: 'ast_max_file_size',
    type: 'number',
    defaultValue: 1_048_576,
    envOverride: 'ORCHID_AST_MAX_FILE_SIZE',
  },
  {
    field: 'mcp_startup_timeout',
    type: 'number',
    defaultValue: 60.0,
    envOverride: 'ORCHID_MCP_STARTUP_TIMEOUT',
  },
  {
    field: 'mcp_per_server_timeout',
    type: 'number',
    defaultValue: 10.0,
    envOverride: 'ORCHID_MCP_PER_SERVER_TIMEOUT',
  },
  { field: 'mcp_servers', type: 'record', defaultValue: undefined }, // complex default
  {
    field: 'llm_stream_idle_timeout',
    type: 'number',
    defaultValue: 300.0,
    envOverride: 'ORCHID_LLM_STREAM_IDLE_TIMEOUT',
  },
  {
    field: 'llm_stream_retries',
    type: 'number',
    defaultValue: 3,
    envOverride: 'ORCHID_LLM_STREAM_RETRIES',
  },
  {
    field: 'background_command_idle_timeout',
    type: 'number',
    defaultValue: 900.0,
    envOverride: 'ORCHID_BG_CMD_IDLE_TIMEOUT',
  },
  // Electron-only: deadline for auto-naming a default session mid-turn.
  {
    field: 'session_title_max_wait_seconds',
    type: 'number',
    defaultValue: 15,
  },
  // Electron-only: AI SDK tool-loop cap (Python is unbounded)
  {
    field: 'max_tool_steps',
    type: 'number',
    defaultValue: 100,
    envOverride: 'ORCHID_MAX_TOOL_STEPS',
  },
  // Desktop UI preference outside the migrated core configuration contract.
  { field: 'always_expand_tool_groups', type: 'boolean', defaultValue: false },
  { field: 'has_completed_onboarding', type: 'boolean', defaultValue: false },
  // Electron-only: worker-pool main-agent reservation (no env override).
  { field: 'tool_worker_pool_main_agent_reserved', type: 'number', defaultValue: 1 },
  {
    field: 'command_max_output_bytes',
    type: 'number',
    defaultValue: 1_048_576,
    envOverride: 'ORCHID_COMMAND_MAX_OUTPUT_BYTES',
  },
  {
    field: 'tool_output_inline_threshold',
    type: 'number',
    defaultValue: 20_000,
    envOverride: 'ORCHID_TOOL_OUTPUT_INLINE_THRESHOLD',
  },
  {
    field: 'approval_timeout',
    type: 'number',
    defaultValue: 600,
    envOverride: 'ORCHID_APPROVAL_TIMEOUT',
  },
  {
    field: 'subagent_wait_timeout',
    type: 'number',
    defaultValue: 300,
    envOverride: 'ORCHID_SUBAGENT_WAIT_TIMEOUT',
  },
  {
    field: 'web_fetch_timeout',
    type: 'number',
    defaultValue: 30,
    envOverride: 'ORCHID_WEB_FETCH_TIMEOUT',
  },
  {
    field: 'web_fetch_max_body_bytes',
    type: 'number',
    defaultValue: 10_485_760,
    envOverride: 'ORCHID_WEB_FETCH_MAX_BODY',
  },
  {
    field: 'web_fetch_user_agent',
    type: 'string',
    defaultValue: 'Orchid/1.0 web-fetch (Electron)',
    envOverride: 'ORCHID_WEB_FETCH_USER_AGENT',
  },
  {
    field: 'bg_prompt_max_entries',
    type: 'number',
    defaultValue: 5,
    envOverride: 'ORCHID_BG_PROMPT_MAX_ENTRIES',
  },
  {
    field: 'bg_prompt_tail_lines',
    type: 'number',
    defaultValue: 8,
    envOverride: 'ORCHID_BG_PROMPT_TAIL_LINES',
  },
  {
    field: 'bg_prompt_tail_chars',
    type: 'number',
    defaultValue: 500,
    envOverride: 'ORCHID_BG_PROMPT_TAIL_CHARS',
  },
  {
    field: 'mcp_result_max_bytes',
    type: 'number',
    defaultValue: 5_242_880,
    envOverride: 'ORCHID_MCP_RESULT_MAX_BYTES',
  },
  {
    field: 'max_background_processes',
    type: 'number',
    defaultValue: 64,
    envOverride: 'ORCHID_MAX_BG_PROCESSES',
  },
  {
    field: 'bg_output_head_bytes',
    type: 'number',
    defaultValue: 524_288,
    envOverride: 'ORCHID_BG_OUTPUT_HEAD_BYTES',
  },
  {
    field: 'bg_output_tail_bytes',
    type: 'number',
    defaultValue: 524_288,
    envOverride: 'ORCHID_BG_OUTPUT_TAIL_BYTES',
  },
  {
    field: 'grep_per_file_timeout',
    type: 'number',
    defaultValue: 10,
    envOverride: 'ORCHID_GREP_PER_FILE_TIMEOUT',
  },
  {
    field: 'read_output_long_poll_max',
    type: 'number',
    defaultValue: 60,
    envOverride: 'ORCHID_READ_OUTPUT_LONG_POLL_MAX',
  },
  {
    field: 'llm_retry_backoff_base',
    type: 'number',
    defaultValue: 0.2,
    envOverride: 'ORCHID_LLM_RETRY_BACKOFF_BASE',
  },
  {
    field: 'llm_retry_max_delay',
    type: 'number',
    defaultValue: 30,
    envOverride: 'ORCHID_LLM_RETRY_MAX_DELAY',
  },
];

const EXPECTED_AGENTS_MD_FIELDS = [
  { field: 'enabled', type: 'boolean', defaultValue: true },
  { field: 'filenames', type: 'array', defaultValue: ['AGENTS.md', 'CLAUDE.md'] },
  { field: 'max_file_bytes', type: 'number', defaultValue: 32768 },
  { field: 'max_chain_depth', type: 'number', defaultValue: 8 },
  { field: 'enforce_on_write', type: 'string', defaultValue: 'warn' },
  { field: 'inject_on_read', type: 'boolean', defaultValue: true },
  { field: 'include_local', type: 'boolean', defaultValue: false },
];

const EXPECTED_SUBAGENTS_FIELDS = [
  { field: 'event_max_per_flush', type: 'number', defaultValue: 200 },
  { field: 'event_byte_budget_kb', type: 'number', defaultValue: 64 },
  { field: 'usage_event_interval_ms', type: 'number', defaultValue: 1000 },
  { field: 'hydration_buffer_kb', type: 'number', defaultValue: 256 },
  { field: 'terminal_wave_ms', type: 'number', defaultValue: 250 },
  { field: 'max_active_global', type: 'number', defaultValue: 8 },
  { field: 'max_active_per_session', type: 'number', defaultValue: 4 },
  { field: 'max_queued', type: 'number', defaultValue: 32 },
  { field: 'terminal_retention', type: 'number', defaultValue: 25 },
  { field: 'prompt_recent_terminal', type: 'number', defaultValue: 5 },
  { field: 'prompt_task_max_chars', type: 'number', defaultValue: 200 },
];

const EXPECTED_RAG_FIELDS = [
  { field: 'chunk_size', type: 'number', defaultValue: 2000, envOverride: 'ORCHID_RAG_CHUNK_SIZE' },
  {
    field: 'chunk_overlap',
    type: 'number',
    defaultValue: 200,
    envOverride: 'ORCHID_RAG_CHUNK_OVERLAP',
  },
  { field: 'top_k', type: 'number', defaultValue: 5, envOverride: 'ORCHID_RAG_TOP_K' },
  {
    field: 'max_file_size',
    type: 'number',
    defaultValue: 512000,
    envOverride: 'ORCHID_RAG_MAX_FILE_SIZE',
  },
  {
    field: 'embedding_model',
    type: 'string',
    defaultValue: 'fastembed/BAAI/bge-small-en-v1.5',
    envOverride: 'ORCHID_RAG_EMBEDDING_MODEL',
  },
  {
    field: 'embedding_threads',
    type: 'number',
    defaultValue: 2,
    envOverride: 'ORCHID_RAG_EMBEDDING_THREADS',
  },
  {
    field: 'embedding_batch_size',
    type: 'number',
    defaultValue: 16,
    envOverride: 'ORCHID_RAG_EMBEDDING_BATCH_SIZE',
  },
  {
    field: 'embedding_api_timeout',
    type: 'number',
    defaultValue: 30,
    envOverride: 'ORCHID_RAG_EMBEDDING_API_TIMEOUT',
  },
  {
    field: 'embedding_api_retries',
    type: 'number',
    defaultValue: 3,
    envOverride: 'ORCHID_RAG_EMBEDDING_API_RETRIES',
  },
];

const EXPECTED_COMPACTION_MAIN_FIELDS = [
  { field: 'mode', defaultValue: 'simple' },
  { field: 'threshold', defaultValue: 0.8 },
  { field: 'model', defaultValue: null },
  { field: 'agent_name', defaultValue: 'compactor' },
  { field: 'preserve_percent', defaultValue: 0.25 },
  { field: 'min_compactable_tokens', defaultValue: 4000 },
  { field: 'mechanical_reclaim', defaultValue: true },
  { field: 'hysteresis_delta', defaultValue: 0.1 },
  { field: 'keep_last_user_messages', defaultValue: 10 },
  { field: 'pin_first_user_message', defaultValue: true },
];

const EXPECTED_COMPACTION_SUBAGENTS_FIELDS = [
  { field: 'mode', defaultValue: 'simple' },
  { field: 'threshold', defaultValue: 0.85 },
  { field: 'model', defaultValue: null },
  { field: 'agent_name', defaultValue: 'compactor-subagent' },
  { field: 'preserve_percent', defaultValue: 0.25 },
  { field: 'min_compactable_tokens', defaultValue: 4000 },
  { field: 'mechanical_reclaim', defaultValue: true },
  { field: 'hysteresis_delta', defaultValue: 0.1 },
  { field: 'keep_last_user_messages', defaultValue: null },
  { field: 'pin_first_user_message', defaultValue: true },
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Config Parity', () => {
  describe('schema completeness', () => {
    it('all top-level fields exist in schema', () => {
      const cfg = defaults();

      // Top-level scalar fields (13)
      expect(cfg).toHaveProperty('default_model');
      expect(cfg).toHaveProperty('tier_models');
      expect(cfg).toHaveProperty('tier_reasoning_effort');
      expect(cfg).toHaveProperty('ignored_dirs');
      expect(cfg).toHaveProperty('command_timeout');
      expect(cfg).toHaveProperty('read_line_limit');
      expect(cfg).toHaveProperty('grep_max_results');
      expect(cfg).toHaveProperty('directory_tree_depth');
      expect(cfg).toHaveProperty('theme');
      expect(cfg).toHaveProperty('personality');
      expect(cfg).toHaveProperty('rag');
      expect(cfg).toHaveProperty('agents_md');
      expect(cfg).toHaveProperty('subagents');
      expect(cfg).toHaveProperty('ast_max_file_size');
      expect(cfg).toHaveProperty('mcp_startup_timeout');
      expect(cfg).toHaveProperty('mcp_per_server_timeout');
      expect(cfg).toHaveProperty('mcp_servers');
      expect(cfg).toHaveProperty('llm_stream_idle_timeout');
      expect(cfg).toHaveProperty('llm_stream_retries');
      expect(cfg).toHaveProperty('background_command_idle_timeout');
      expect(cfg).toHaveProperty('session_title_max_wait_seconds');
      expect(cfg).toHaveProperty('max_tool_steps');
      expect(cfg).toHaveProperty('default_project_dir');
      expect(cfg).toHaveProperty('always_expand_tool_groups');
      expect(cfg).toHaveProperty('has_completed_onboarding');
      expect(cfg).toHaveProperty('command_max_output_bytes');
      expect(cfg).toHaveProperty('tool_output_inline_threshold');
      expect(cfg).toHaveProperty('approval_timeout');
      expect(cfg).toHaveProperty('subagent_wait_timeout');
      expect(cfg).toHaveProperty('web_fetch_timeout');
      expect(cfg).toHaveProperty('web_fetch_max_body_bytes');
      expect(cfg).toHaveProperty('web_fetch_user_agent');
      expect(cfg).toHaveProperty('bg_prompt_max_entries');
      expect(cfg).toHaveProperty('bg_prompt_tail_lines');
      expect(cfg).toHaveProperty('bg_prompt_tail_chars');
      expect(cfg).toHaveProperty('mcp_result_max_bytes');
      expect(cfg).toHaveProperty('max_background_processes');
      expect(cfg).toHaveProperty('bg_output_head_bytes');
      expect(cfg).toHaveProperty('bg_output_tail_bytes');
      expect(cfg).toHaveProperty('grep_per_file_timeout');
      expect(cfg).toHaveProperty('read_output_long_poll_max');
      expect(cfg).toHaveProperty('llm_retry_backoff_base');
      expect(cfg).toHaveProperty('llm_retry_max_delay');
      expect(cfg).toHaveProperty('tool_worker_pool_size');
      expect(cfg).toHaveProperty('tool_worker_pool_main_agent_reserved');

      // RAG nested fields (7)
      expect(cfg.rag).toHaveProperty('chunk_size');
      expect(cfg.rag).toHaveProperty('chunk_overlap');
      expect(cfg.rag).toHaveProperty('top_k');
      expect(cfg.rag).toHaveProperty('max_file_size');
      expect(cfg.rag).toHaveProperty('embedding_model');
      expect(cfg.rag).toHaveProperty('embedding_api_timeout');
      expect(cfg.rag).toHaveProperty('embedding_api_retries');

      // AGENTS.md nested fields (7)
      expect(cfg.agents_md).toHaveProperty('enabled');
      expect(cfg.agents_md).toHaveProperty('filenames');
      expect(cfg.agents_md).toHaveProperty('max_file_bytes');
      expect(cfg.agents_md).toHaveProperty('max_chain_depth');
      expect(cfg.agents_md).toHaveProperty('enforce_on_write');
      expect(cfg.agents_md).toHaveProperty('inject_on_read');
      expect(cfg.agents_md).toHaveProperty('include_local');

      // Subagents nested fields (11)
      expect(cfg.subagents).toHaveProperty('event_max_per_flush');
      expect(cfg.subagents).toHaveProperty('event_byte_budget_kb');
      expect(cfg.subagents).toHaveProperty('usage_event_interval_ms');
      expect(cfg.subagents).toHaveProperty('hydration_buffer_kb');
      expect(cfg.subagents).toHaveProperty('terminal_wave_ms');
      expect(cfg.subagents).toHaveProperty('max_active_global');
      expect(cfg.subagents).toHaveProperty('max_active_per_session');
      expect(cfg.subagents).toHaveProperty('max_queued');
      expect(cfg.subagents).toHaveProperty('terminal_retention');
      expect(cfg.subagents).toHaveProperty('prompt_recent_terminal');
      expect(cfg.subagents).toHaveProperty('prompt_task_max_chars');
    });

    it('top-level field count matches expected (48 top-level + 12 rag + 7 agents_md + 11 subagents nested fields)', () => {
      const cfg = defaults();
      // Top-level keys count
      const topLevelKeys = Object.keys(cfg);
      expect(topLevelKeys).toHaveLength(48); // 48 top-level fields (rag, agents_md, subagents, compaction are nested)

      // RAG nested keys count
      const ragKeys = Object.keys(cfg.rag);
      expect(ragKeys).toHaveLength(12);

      // AGENTS.md nested keys count
      const agentsMdKeys = Object.keys(cfg.agents_md);
      expect(agentsMdKeys).toHaveLength(7);

      // Subagents nested keys count
      const subagentsKeys = Object.keys(cfg.subagents);
      expect(subagentsKeys).toHaveLength(11);
    });
  });

  describe('default values', () => {
    it('scalar fields have correct defaults', () => {
      const cfg = defaults();

      for (const expected of EXPECTED_FIELDS) {
        if (expected.defaultValue !== undefined) {
          expect(
            cfg[expected.field as keyof typeof cfg],
            `Field '${expected.field}' default`,
          ).toEqual(expected.defaultValue);
        }
      }
    });

    it('rag nested fields have correct defaults', () => {
      const cfg = defaults();

      for (const expected of EXPECTED_RAG_FIELDS) {
        expect(
          cfg.rag[expected.field as keyof typeof cfg.rag],
          `RAG field '${expected.field}' default`,
        ).toBe(expected.defaultValue);
      }
    });

    it('agents_md nested fields have correct defaults', () => {
      const cfg = defaults();

      for (const expected of EXPECTED_AGENTS_MD_FIELDS) {
        expect(
          cfg.agents_md[expected.field as keyof typeof cfg.agents_md],
          `AGENTS.md field '${expected.field}' default`,
        ).toEqual(expected.defaultValue);
      }
    });

    it('subagents nested fields have correct defaults', () => {
      const cfg = defaults();

      for (const expected of EXPECTED_SUBAGENTS_FIELDS) {
        expect(
          cfg.subagents[expected.field as keyof typeof cfg.subagents],
          `Subagents field '${expected.field}' default`,
        ).toBe(expected.defaultValue);
      }
    });

    it('compaction main scope has correct defaults', () => {
      const cfg = defaults();
      for (const expected of EXPECTED_COMPACTION_MAIN_FIELDS) {
        expect(
          (cfg.compaction.main as unknown as Record<string, unknown>)[expected.field],
          `compaction.main.${expected.field} default`,
        ).toEqual(expected.defaultValue);
      }
      // Explicit pin for review-gate assertions
      expect(cfg.compaction.main.threshold).toBe(0.8);
      expect(cfg.compaction.main.preserve_percent).toBe(0.25);
      expect(cfg.compaction.main.min_compactable_tokens).toBe(4000);
      expect(cfg.compaction.main.hysteresis_delta).toBe(0.1);
      expect(cfg.compaction.main.mode).toBe('simple');
      expect(cfg.compaction.main.mechanical_reclaim).toBe(true);
      expect(cfg.compaction.main.agent_name).toBe('compactor');
      expect(cfg.compaction.main.keep_last_user_messages).toBe(10);
      expect(cfg.compaction.main.pin_first_user_message).toBe(true);
    });

    it('compaction subagents scope has correct defaults', () => {
      const cfg = defaults();
      for (const expected of EXPECTED_COMPACTION_SUBAGENTS_FIELDS) {
        expect(
          (cfg.compaction.subagents as unknown as Record<string, unknown>)[expected.field],
          `compaction.subagents.${expected.field} default`,
        ).toEqual(expected.defaultValue);
      }
      // Selective threshold delta is intentional (0.85 vs 0.8)
      expect(cfg.compaction.subagents.threshold).toBe(0.85);
      expect(cfg.compaction.subagents.preserve_percent).toBe(0.25);
      expect(cfg.compaction.subagents.min_compactable_tokens).toBe(4000);
      expect(cfg.compaction.subagents.hysteresis_delta).toBe(0.1);
      expect(cfg.compaction.subagents.mode).toBe('simple');
      expect(cfg.compaction.subagents.mechanical_reclaim).toBe(true);
      expect(cfg.compaction.subagents.agent_name).toBe('compactor-subagent');
      // R32: subagent scope pins ALL user messages by default (null = all)
      expect(cfg.compaction.subagents.keep_last_user_messages).toBeNull();
      expect(cfg.compaction.subagents.pin_first_user_message).toBe(true);
    });

    it('compaction agent_name rejects bad names (allowlist)', () => {
      expect(() => configSchema.parse({ compaction: { main: { agent_name: 'bad name!' } } })).toThrow();
      expect(() => configSchema.parse({ compaction: { main: { agent_name: '' } } })).toThrow();
      expect(() => configSchema.parse({ compaction: { main: { agent_name: 'a'.repeat(65) } } })).toThrow();
      expect(() => configSchema.parse({ compaction: { subagents: { agent_name: 'also bad!' } } })).toThrow();
      expect(() => configSchema.parse({ compaction: { main: { agent_name: 'my-compactor_1' } } })).toThrow();
      expect(() => configSchema.parse({ compaction: { subagents: { agent_name: 'compactor' } } })).toThrow();
      expect(() => configSchema.parse({ compaction: { main: { agent_name: 'compactor' } } })).not.toThrow();
      expect(() => configSchema.parse({ compaction: { subagents: { agent_name: 'compactor-subagent' } } })).not.toThrow();
    });

    it('ignored_dirs has 20+ default entries', () => {
      const cfg = defaults();
      expect(cfg.ignored_dirs.length).toBeGreaterThanOrEqual(20);
      expect(cfg.ignored_dirs).toContain('.git');
      expect(cfg.ignored_dirs).toContain('node_modules');
      expect(cfg.ignored_dirs).toContain('__pycache__');
    });

    it('mcp_servers defaults to empty (recommended servers are opt-in)', () => {
      const cfg = defaults();
      expect(cfg.mcp_servers).toEqual({});
    });
  });

  describe('field types', () => {
    it('model selections are nullable typed values', () => {
      const cfg = defaults();
      expect(cfg.default_model).toBeNull();
      expect(cfg.tier_models).toEqual({ seed: null, sprout: null, bloom: null, crown: null });
      const parsed = configSchema.parse({ default_model: DEFAULT_SELECTION });
      expect(parsed.default_model).toEqual(DEFAULT_SELECTION);
      expect(() => configSchema.parse({ default_model: 'legacy/model' })).toThrow();
    });

    it('string fields are strings', () => {
      const cfg = defaults();
      expect(typeof cfg.theme).toBe('string');
      expect(typeof cfg.personality).toBe('string');
      expect(typeof cfg.rag.embedding_model).toBe('string');
    });

    it('number fields are numbers', () => {
      const cfg = defaults();
      expect(typeof cfg.command_timeout).toBe('number');
      expect(typeof cfg.read_line_limit).toBe('number');
      expect(typeof cfg.grep_max_results).toBe('number');
      expect(typeof cfg.directory_tree_depth).toBe('number');
      expect(typeof cfg.ast_max_file_size).toBe('number');
      expect(typeof cfg.mcp_startup_timeout).toBe('number');
      expect(typeof cfg.mcp_per_server_timeout).toBe('number');
      expect(typeof cfg.llm_stream_idle_timeout).toBe('number');
      expect(typeof cfg.llm_stream_retries).toBe('number');
      expect(typeof cfg.background_command_idle_timeout).toBe('number');
      expect(typeof cfg.session_title_max_wait_seconds).toBe('number');
    });

    it('array fields are arrays', () => {
      const cfg = defaults();
      expect(Array.isArray(cfg.ignored_dirs)).toBe(true);
    });

    it('record fields are objects', () => {
      const cfg = defaults();
      expect(typeof cfg.tier_models).toBe('object');
      expect(typeof cfg.mcp_servers).toBe('object');
    });
  });

  describe('configSchema.parse with defaults', () => {
    it('configSchema.parse({}) returns same as defaults()', () => {
      const parsed = configSchema.parse({});
      expect(parsed).toEqual(defaults());
    });

    it('configSchema.parse with partial input fills in defaults', () => {
      const parsed = configSchema.parse({ default_model: DEFAULT_SELECTION });
      expect(parsed.default_model).toEqual(DEFAULT_SELECTION);
      expect(parsed.command_timeout).toBe(30); // default
      expect(parsed.rag.chunk_size).toBe(2000); // default
    });
  });
});
