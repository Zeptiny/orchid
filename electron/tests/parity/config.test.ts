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

// ── Expected config fields (23 total) ──────────────────────────────────────

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
  { field: 'providers', type: 'record', defaultValue: undefined }, // complex default
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
      expect(cfg).toHaveProperty('ast_max_file_size');
      expect(cfg).toHaveProperty('mcp_startup_timeout');
      expect(cfg).toHaveProperty('mcp_per_server_timeout');
      expect(cfg).toHaveProperty('mcp_servers');
      expect(cfg).toHaveProperty('providers');
      expect(cfg).toHaveProperty('llm_stream_idle_timeout');
      expect(cfg).toHaveProperty('llm_stream_retries');
      expect(cfg).toHaveProperty('background_command_idle_timeout');
      expect(cfg).toHaveProperty('max_tool_steps');
      expect(cfg).toHaveProperty('default_project_dir');
      expect(cfg).toHaveProperty('always_expand_tool_groups');
      expect(cfg).toHaveProperty('has_completed_onboarding');

      // RAG nested fields (5)
      expect(cfg.rag).toHaveProperty('chunk_size');
      expect(cfg.rag).toHaveProperty('chunk_overlap');
      expect(cfg.rag).toHaveProperty('top_k');
      expect(cfg.rag).toHaveProperty('max_file_size');
      expect(cfg.rag).toHaveProperty('embedding_model');
    });

    it('top-level field count matches expected (25 top-level + 8 rag nested fields)', () => {
      const cfg = defaults();
      // Top-level keys count
      const topLevelKeys = Object.keys(cfg);
      expect(topLevelKeys).toHaveLength(25); // 25 top-level fields (rag is nested)

      // RAG nested keys count
      const ragKeys = Object.keys(cfg.rag);
      expect(ragKeys).toHaveLength(8);
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

    it('providers remains an empty deprecated compatibility map', () => {
      const cfg = defaults();
      expect(cfg.providers).toEqual({});
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
    });

    it('array fields are arrays', () => {
      const cfg = defaults();
      expect(Array.isArray(cfg.ignored_dirs)).toBe(true);
    });

    it('record fields are objects', () => {
      const cfg = defaults();
      expect(typeof cfg.tier_models).toBe('object');
      expect(typeof cfg.mcp_servers).toBe('object');
      expect(typeof cfg.providers).toBe('object');
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
