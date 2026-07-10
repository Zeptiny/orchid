/**
 * Config Parity Tests — U28.
 *
 * Verifies that all 22 config fields from the Python TUI are ported to the TS/Electron app.
 * Tests STRUCTURE (fields exist, types correct, defaults match), not behavior.
 */
import { describe, it, expect } from 'vitest';
import { configSchema, defaults } from '../../src/main/config/schema';

// ── Expected config fields (22 total) ──────────────────────────────────────

interface ConfigFieldExpectation {
  field: string;
  type: string;
  defaultValue: unknown;
  envOverride?: string;
}

const EXPECTED_FIELDS: ConfigFieldExpectation[] = [
  { field: 'default_model', type: 'string', defaultValue: 'default/mimo-v2.5', envOverride: 'ORCHID_DEFAULT_MODEL' },
  { field: 'tier_models', type: 'record', defaultValue: { seed: 'default/mimo-v2.5', sprout: 'default/mimo-v2.5', bloom: 'default/mimo-v2.5', crown: 'default/mimo-v2.5' } },
  { field: 'ignored_dirs', type: 'array', defaultValue: undefined }, // complex default, checked separately
  { field: 'command_timeout', type: 'number', defaultValue: 30, envOverride: 'ORCHID_COMMAND_TIMEOUT' },
  { field: 'read_line_limit', type: 'number', defaultValue: 1000, envOverride: 'ORCHID_READ_LINE_LIMIT' },
  { field: 'grep_max_results', type: 'number', defaultValue: 100, envOverride: 'ORCHID_GREP_MAX_RESULTS' },
  { field: 'directory_tree_depth', type: 'number', defaultValue: 2, envOverride: 'ORCHID_DIRECTORY_TREE_DEPTH' },
  { field: 'theme', type: 'string', defaultValue: 'default', envOverride: 'ORCHID_THEME' },
  { field: 'personality', type: 'string', defaultValue: 'default', envOverride: 'ORCHID_PERSONALITY' },
  { field: 'rag', type: 'object', defaultValue: undefined }, // nested, checked separately
  { field: 'ast_max_file_size', type: 'number', defaultValue: 1_048_576, envOverride: 'ORCHID_AST_MAX_FILE_SIZE' },
  { field: 'mcp_startup_timeout', type: 'number', defaultValue: 60.0, envOverride: 'ORCHID_MCP_STARTUP_TIMEOUT' },
  { field: 'mcp_per_server_timeout', type: 'number', defaultValue: 10.0, envOverride: 'ORCHID_MCP_PER_SERVER_TIMEOUT' },
  { field: 'mcp_servers', type: 'record', defaultValue: undefined }, // complex default
  { field: 'providers', type: 'record', defaultValue: undefined }, // complex default
  { field: 'llm_stream_idle_timeout', type: 'number', defaultValue: 300.0, envOverride: 'ORCHID_LLM_STREAM_IDLE_TIMEOUT' },
  { field: 'llm_stream_retries', type: 'number', defaultValue: 3, envOverride: 'ORCHID_LLM_STREAM_RETRIES' },
  { field: 'background_command_idle_timeout', type: 'number', defaultValue: 900.0, envOverride: 'ORCHID_BG_CMD_IDLE_TIMEOUT' },
];

const EXPECTED_RAG_FIELDS = [
  { field: 'chunk_size', type: 'number', defaultValue: 2000, envOverride: 'ORCHID_RAG_CHUNK_SIZE' },
  { field: 'chunk_overlap', type: 'number', defaultValue: 200, envOverride: 'ORCHID_RAG_CHUNK_OVERLAP' },
  { field: 'top_k', type: 'number', defaultValue: 5, envOverride: 'ORCHID_RAG_TOP_K' },
  { field: 'max_file_size', type: 'number', defaultValue: 512000, envOverride: 'ORCHID_RAG_MAX_FILE_SIZE' },
  { field: 'embedding_model', type: 'string', defaultValue: 'fastembed/BAAI/bge-small-en-v1.5', envOverride: 'ORCHID_RAG_EMBEDDING_MODEL' },
  { field: 'embedding_threads', type: 'number', defaultValue: 2, envOverride: 'ORCHID_RAG_EMBEDDING_THREADS' },
  { field: 'embedding_batch_size', type: 'number', defaultValue: 16, envOverride: 'ORCHID_RAG_EMBEDDING_BATCH_SIZE' },
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Config Parity', () => {
  describe('schema completeness', () => {
    it('all top-level fields exist in schema', () => {
      const cfg = defaults();

      // Top-level scalar fields (13)
      expect(cfg).toHaveProperty('default_model');
      expect(cfg).toHaveProperty('tier_models');
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
      expect(cfg).toHaveProperty('default_project_dir');

      // RAG nested fields (5)
      expect(cfg.rag).toHaveProperty('chunk_size');
      expect(cfg.rag).toHaveProperty('chunk_overlap');
      expect(cfg.rag).toHaveProperty('top_k');
      expect(cfg.rag).toHaveProperty('max_file_size');
      expect(cfg.rag).toHaveProperty('embedding_model');
    });

    it('top-level field count matches expected (19 top-level + 8 rag nested fields)', () => {
      const cfg = defaults();
      // Top-level keys count
      const topLevelKeys = Object.keys(cfg);
      expect(topLevelKeys).toHaveLength(19); // 19 top-level fields (rag is nested)

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
          expect(cfg[expected.field as keyof typeof cfg], `Field '${expected.field}' default`).toEqual(expected.defaultValue);
        }
      }
    });

    it('rag nested fields have correct defaults', () => {
      const cfg = defaults();

      for (const expected of EXPECTED_RAG_FIELDS) {
        expect(cfg.rag[expected.field as keyof typeof cfg.rag], `RAG field '${expected.field}' default`).toBe(expected.defaultValue);
      }
    });

    it('ignored_dirs has 20+ default entries', () => {
      const cfg = defaults();
      expect(cfg.ignored_dirs.length).toBeGreaterThanOrEqual(20);
      expect(cfg.ignored_dirs).toContain('.git');
      expect(cfg.ignored_dirs).toContain('node_modules');
      expect(cfg.ignored_dirs).toContain('__pycache__');
    });

    it('mcp_servers has context7 default', () => {
      const cfg = defaults();
      expect(cfg.mcp_servers).toHaveProperty('context7');
      expect(cfg.mcp_servers['context7']!['command']).toBe('npx');
    });

    it('providers has default provider', () => {
      const cfg = defaults();
      expect(cfg.providers).toHaveProperty('default');
      expect(cfg.providers['default']!['base_url']).toBe('https://opencode.ai/zen/go/v1');
    });
  });

  describe('field types', () => {
    it('string fields are strings', () => {
      const cfg = defaults();
      expect(typeof cfg.default_model).toBe('string');
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
      const parsed = configSchema.parse({ default_model: 'custom/model' });
      expect(parsed.default_model).toBe('custom/model');
      expect(parsed.command_timeout).toBe(30); // default
      expect(parsed.rag.chunk_size).toBe(2000); // default
    });
  });
});
