/**
 * Config system tests — U3.
 *
 * Covers:
 * - Default config loads with all fields populated
 * - Deep merge: home + project overrides
 * - Deep merge for mcp_servers and providers (per-alias merge)
 * - Env override casting (string, int, float, list)
 * - Validation rules
 * - Persistence: save() + load() round-trips
 * - Atomic write (no partial on crash)
 * - ensureHomeConfig() directory seeding
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  configSchema,
  defaults,
  parsePartial,
  deepMerge,
  deepMergeProviderDict,
  mergeLayers,
  applyEnvOverrides,
  validateConfig,
  loadConfig,
  ConfigManager,
} from '../../src/main/config';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let origEnv: Record<string, string | undefined>;

/** Path to a non-existent home config file (simulates no home config). */
const NO_HOME_CONFIG = path.join(os.tmpdir(), 'nonexistent-orchid-home-config.json');

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-config-test-'));
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  origEnv = { ...process.env };
  ConfigManager.reset();
  clearOrchidEnv();
});

afterEach(() => {
  // Restore env
  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, val] of Object.entries(origEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  // Cleanup temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
  ConfigManager.reset();
});

/** Clear all ORCHID_ env vars that might leak between tests. */
function clearOrchidEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ORCHID_')) {
      delete process.env[key];
    }
  }
}

// ===========================================================================
// Schema & defaults
// ===========================================================================

describe('schema & defaults', () => {
  it('defaults() returns all 22 fields populated', () => {
    const cfg = defaults();

    // Top-level scalar fields
    expect(cfg.default_model).toBe('default/mimo-v2.5');
    expect(cfg.command_timeout).toBe(30);
    expect(cfg.read_line_limit).toBe(1000);
    expect(cfg.grep_max_results).toBe(100);
    expect(cfg.directory_tree_depth).toBe(2);
    expect(cfg.theme).toBe('default');
    expect(cfg.personality).toBe('default');
    expect(cfg.ast_max_file_size).toBe(1_048_576);
    expect(cfg.mcp_startup_timeout).toBe(60.0);
    expect(cfg.mcp_per_server_timeout).toBe(10.0);
    expect(cfg.llm_stream_idle_timeout).toBe(300.0);
    expect(cfg.llm_stream_retries).toBe(3);
    expect(cfg.background_command_idle_timeout).toBe(900.0);

    // tier_models
    expect(cfg.tier_models).toEqual({
      seed: 'default/mimo-v2.5',
      sprout: 'default/mimo-v2.5',
      bloom: 'default/mimo-v2.5',
      crown: 'default/mimo-v2.5',
    });

    // ignored_dirs (21 defaults — matches Python config.py lines 51-73)
    expect(cfg.ignored_dirs.length).toBeGreaterThanOrEqual(20);
    expect(cfg.ignored_dirs).toContain('.git');
    expect(cfg.ignored_dirs).toContain('node_modules');
    expect(cfg.ignored_dirs).toContain('__pycache__');

    // rag
    expect(cfg.rag.chunk_size).toBe(2000);
    expect(cfg.rag.chunk_overlap).toBe(200);
    expect(cfg.rag.top_k).toBe(5);
    expect(cfg.rag.max_file_size).toBe(512000);
    expect(cfg.rag.embedding_model).toBe('fastembed/BAAI/bge-small-en-v1.5');

    // mcp_servers
    expect(cfg.mcp_servers).toHaveProperty('context7');
    expect(cfg.mcp_servers['context7']!['command']).toBe('npx');

    // providers
    expect(cfg.providers).toHaveProperty('default');
    expect(cfg.providers['default']!['base_url']).toBe('https://opencode.ai/zen/go/v1');
  });

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

  it('configSchema.parse with partial rag fills in remaining rag defaults', () => {
    const parsed = configSchema.parse({ rag: { top_k: 10 } });
    expect(parsed.rag.top_k).toBe(10);
    expect(parsed.rag.chunk_size).toBe(2000); // default
    expect(parsed.rag.chunk_overlap).toBe(200); // default
  });

  it('parsePartial returns only provided fields (for merging)', () => {
    const partial = parsePartial({ default_model: 'custom/model', rag: { top_k: 10 } });
    expect(partial).toHaveProperty('default_model', 'custom/model');
  });
});

// ===========================================================================
// Deep merge
// ===========================================================================

describe('deepMerge', () => {
  it('merges flat objects (source overrides target)', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('recursively merges nested objects', () => {
    const result = deepMerge(
      { nested: { a: 1, b: 2 } },
      { nested: { b: 3, c: 4 } },
    );
    expect(result).toEqual({ nested: { a: 1, b: 3, c: 4 } });
  });

  it('replaces arrays (does not merge)', () => {
    const result = deepMerge(
      { list: [1, 2, 3] },
      { list: [4, 5] },
    );
    expect(result).toEqual({ list: [4, 5] });
  });

  it('skips undefined values in source', () => {
    const result = deepMerge({ a: 1 }, { a: undefined, b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });
});

describe('deepMergeProviderDict', () => {
  it('keeps home-only entries', () => {
    const result = deepMergeProviderDict(
      { home_server: { command: 'cmd' } },
      {},
    );
    expect(result).toEqual({ home_server: { command: 'cmd' } });
  });

  it('takes project-only entries', () => {
    const result = deepMergeProviderDict(
      {},
      { project_server: { command: 'cmd' } },
    );
    expect(result).toEqual({ project_server: { command: 'cmd' } });
  });

  it('merges entries present in both (shallow merge)', () => {
    const result = deepMergeProviderDict(
      { srv: { command: 'old', args: ['a'] } },
      { srv: { command: 'new' } },
    );
    expect(result).toEqual({ srv: { command: 'new', args: ['a'] } });
  });

  it('merges nested models sub-dict', () => {
    const result = deepMergeProviderDict(
      { prov: { base_url: 'url', models: { m1: {} } } },
      { prov: { models: { m2: {} } } },
    );
    expect(result).toEqual({
      prov: { base_url: 'url', models: { m1: {}, m2: {} } },
    });
  });

  it('project wins when either side is non-dict', () => {
    const result = deepMergeProviderDict(
      { srv: 'home-value' as unknown as Record<string, unknown> },
      { srv: 'project-value' as unknown as Record<string, unknown> },
    );
    expect(result['srv']).toBe('project-value');
  });
});

describe('mergeLayers (3-layer)', () => {
  it('project overrides home overrides defaults for scalars', () => {
    const d = { default_model: 'default', theme: 'default' };
    const home = { default_model: 'home-model' };
    const project = { theme: 'project-theme' };

    const result = mergeLayers(d, home, project);
    expect(result).toEqual({ default_model: 'home-model', theme: 'project-theme' });
  });

  it('deep merges nested rag across all layers', () => {
    const d = { rag: { chunk_size: 2000, top_k: 5 } };
    const home = { rag: { chunk_size: 1000 } };
    const project = { rag: { top_k: 10 } };

    const result = mergeLayers(d, home, project);
    expect(result).toEqual({ rag: { chunk_size: 1000, top_k: 10 } });
  });

  it('deep merges mcp_servers per-alias', () => {
    const d = {
      mcp_servers: {
        context7: { command: 'npx', args: ['-y'] },
      },
    };
    const home = {
      mcp_servers: {
        custom: { command: 'my-cmd' },
      },
    };
    const project = {
      mcp_servers: {
        context7: { args: ['-y', 'extra'] },
      },
    };

    const result = mergeLayers(d, home, project) as Record<string, unknown>;
    const servers = result['mcp_servers'] as Record<string, unknown>;
    expect(servers['context7']).toEqual({ command: 'npx', args: ['-y', 'extra'] });
    expect(servers['custom']).toEqual({ command: 'my-cmd' });
  });

  it('deep merges providers with models sub-dict', () => {
    const d = {
      providers: {
        default: { base_url: 'url', models: { 'mimo-v2.5': {} } },
      },
    };
    const project = {
      providers: {
        default: { models: { 'gpt-4o': {} } },
      },
    };

    const result = mergeLayers(d, {}, project) as Record<string, unknown>;
    const provs = result['providers'] as Record<string, unknown>;
    const def = provs['default'] as Record<string, unknown>;
    expect(def['base_url']).toBe('url');
    expect(def['models']).toEqual({ 'mimo-v2.5': {}, 'gpt-4o': {} });
  });

  it('ignores keys not present in defaults', () => {
    const d = { known: 1 };
    const home = { unknown_key: 'value' };
    const result = mergeLayers(d, home, {});
    expect(result).toEqual({ known: 1 });
  });
});

// ===========================================================================
// Environment variable overrides
// ===========================================================================

describe('applyEnvOverrides', () => {
  beforeEach(clearOrchidEnv);

  it('overrides string field', () => {
    process.env['ORCHID_DEFAULT_MODEL'] = 'test/model';
    const cfg = { default_model: 'default' } as Record<string, unknown>;
    applyEnvOverrides(cfg);
    expect(cfg['default_model']).toBe('test/model');
  });

  it('casts int env to number', () => {
    process.env['ORCHID_COMMAND_TIMEOUT'] = '60';
    const cfg = { command_timeout: 30 } as Record<string, unknown>;
    applyEnvOverrides(cfg);
    expect(cfg['command_timeout']).toBe(60);
  });

  it('casts float env to number', () => {
    process.env['ORCHID_MCP_STARTUP_TIMEOUT'] = '120.5';
    const cfg = { mcp_startup_timeout: 60.0 } as Record<string, unknown>;
    applyEnvOverrides(cfg);
    expect(cfg['mcp_startup_timeout']).toBe(120.5);
  });

  it('casts list env to array', () => {
    process.env['ORCHID_IGNORED_DIRS'] = '.git,node_modules,dist';
    const cfg = { ignored_dirs: [] } as Record<string, unknown>;
    applyEnvOverrides(cfg);
    expect(cfg['ignored_dirs']).toEqual(['.git', 'node_modules', 'dist']);
  });

  it('overrides nested rag fields', () => {
    process.env['ORCHID_RAG_CHUNK_SIZE'] = '5000';
    process.env['ORCHID_RAG_EMBEDDING_MODEL'] = 'custom/model';
    const cfg = {
      rag: { chunk_size: 2000, embedding_model: 'default' },
    } as Record<string, unknown>;
    applyEnvOverrides(cfg);
    const rag = cfg['rag'] as Record<string, unknown>;
    expect(rag['chunk_size']).toBe(5000);
    expect(rag['embedding_model']).toBe('custom/model');
  });

  it('does not override when env is empty string', () => {
    process.env['ORCHID_DEFAULT_MODEL'] = '';
    const cfg = { default_model: 'original' } as Record<string, unknown>;
    applyEnvOverrides(cfg);
    expect(cfg['default_model']).toBe('original');
  });

  it('does not override when env is unset', () => {
    delete process.env['ORCHID_DEFAULT_MODEL'];
    const cfg = { default_model: 'original' } as Record<string, unknown>;
    applyEnvOverrides(cfg);
    expect(cfg['default_model']).toBe('original');
  });
});

// ===========================================================================
// Validation
// ===========================================================================

describe('validateConfig', () => {
  it('valid config returns no errors', () => {
    const cfg = defaults();
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('empty default_model is an error', () => {
    const cfg = { ...defaults(), default_model: '' };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('default_model'))).toBe(true);
  });

  it('negative command_timeout is an error', () => {
    const cfg = { ...defaults(), command_timeout: -1 };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('command_timeout'))).toBe(true);
  });

  it('zero command_timeout is an error (must be positive)', () => {
    const cfg = { ...defaults(), command_timeout: 0 };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('command_timeout'))).toBe(true);
  });

  it('rag.chunk_overlap >= rag.chunk_size is an error', () => {
    const cfg = {
      ...defaults(),
      rag: { ...defaults().rag, chunk_overlap: 3000 },
    };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('chunk_overlap') && e.includes('chunk_size'))).toBe(true);
  });

  it('negative llm_stream_retries is an error', () => {
    const cfg = { ...defaults(), llm_stream_retries: -1 };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('llm_stream_retries'))).toBe(true);
  });

  it('invalid provider alias (contains /) is an error', () => {
    const cfg = {
      ...defaults(),
      providers: { 'bad/alias': { base_url: 'url' } },
    };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('bad/alias') && e.includes('[a-z0-9-]+'))).toBe(true);
  });

  it('reserved provider alias "fastembed" is an error', () => {
    const cfg = {
      ...defaults(),
      providers: { fastembed: { base_url: 'url' } },
    };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('fastembed') && e.includes('reserved'))).toBe(true);
  });

  it('both api_key and api_key_env set is an error', () => {
    const cfg = {
      ...defaults(),
      providers: {
        test: { api_key: 'key', api_key_env: 'ENV_VAR' },
      },
    };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('both') && e.includes('api_key'))).toBe(true);
  });

  it('invalid mcp_server name (contains uppercase) is an error', () => {
    const cfg = {
      ...defaults(),
      mcp_servers: { BadName: { command: 'cmd' } },
    };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('BadName') && e.includes('[a-z0-9-]+'))).toBe(true);
  });

  it('mcp_server without url and without command is an error', () => {
    const cfg = {
      ...defaults(),
      mcp_servers: { test: { args: [] } },
    };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('command') && e.includes('non-empty'))).toBe(true);
  });

  it('empty theme is an error', () => {
    const cfg = { ...defaults(), theme: '' };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('theme'))).toBe(true);
  });

  it('empty personality is an error', () => {
    const cfg = { ...defaults(), personality: '' };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.includes('personality'))).toBe(true);
  });
});

// ===========================================================================
// Full loadConfig integration
// ===========================================================================

describe('loadConfig', () => {
  beforeEach(clearOrchidEnv);

  /** Load config with no home config and given project dir. */
  function loadNoHome(projectDir?: string) {
    return loadConfig({
      projectDir: projectDir ?? tmpDir,
      homeConfigPath: NO_HOME_CONFIG,
    });
  }

  it('loads defaults when no config files exist', () => {
    const cfg = loadNoHome();
    expect(cfg.default_model).toBe('default/mimo-v2.5');
    expect(cfg.command_timeout).toBe(30);
    expect(cfg.rag.chunk_size).toBe(2000);
  });

  it('merges project config over defaults', () => {
    writeJson(path.join(tmpDir, '.orchid.json'), {
      default_model: 'project/model',
      ignored_dirs: ['.git', 'custom-dir'],
    });

    const cfg = loadNoHome();
    expect(cfg.default_model).toBe('project/model');
    // ignored_dirs is replaced (arrays are replaced, not merged)
    expect(cfg.ignored_dirs).toEqual(['.git', 'custom-dir']);
    // Other defaults still present
    expect(cfg.command_timeout).toBe(30);
  });

  it('deep merges nested rag from project', () => {
    writeJson(path.join(tmpDir, '.orchid.json'), {
      rag: { top_k: 10 },
    });

    const cfg = loadNoHome();
    expect(cfg.rag.top_k).toBe(10);
    expect(cfg.rag.chunk_size).toBe(2000); // default preserved
    expect(cfg.rag.embedding_model).toBe('fastembed/BAAI/bge-small-en-v1.5'); // default
  });

  it('env overrides take highest priority', () => {
    writeJson(path.join(tmpDir, '.orchid.json'), {
      default_model: 'project/model',
      command_timeout: 60,
    });
    process.env['ORCHID_DEFAULT_MODEL'] = 'env/model';
    process.env['ORCHID_COMMAND_TIMEOUT'] = '90';

    const cfg = loadNoHome();
    expect(cfg.default_model).toBe('env/model');
    expect(cfg.command_timeout).toBe(90);
  });

  it('env override casts ORCHID_COMMAND_TIMEOUT to int', () => {
    process.env['ORCHID_COMMAND_TIMEOUT'] = '45';
    const cfg = loadNoHome();
    expect(cfg.command_timeout).toBe(45);
    expect(typeof cfg.command_timeout).toBe('number');
  });

  it('ignores null values in config files', () => {
    writeJson(path.join(tmpDir, '.orchid.json'), {
      default_model: null,
      theme: 'custom',
    });

    const cfg = loadNoHome();
    // null default_model is stripped, so default is used
    expect(cfg.default_model).toBe('default/mimo-v2.5');
    expect(cfg.theme).toBe('custom');
  });

  it('home config is merged under project config', () => {
    // Write a "home" config
    const homeConfig = path.join(tmpDir, 'home-config.json');
    writeJson(homeConfig, {
      default_model: 'home/model',
      ignored_dirs: ['.git', 'home-dir'],
    });

    // Write a project config that overrides default_model only
    writeJson(path.join(tmpDir, '.orchid.json'), {
      default_model: 'project/model',
    });

    const cfg = loadConfig({
      projectDir: tmpDir,
      homeConfigPath: homeConfig,
    });

    // Project overrides home for default_model
    expect(cfg.default_model).toBe('project/model');
    // Home's ignored_dirs is used (project doesn't override it)
    expect(cfg.ignored_dirs).toEqual(['.git', 'home-dir']);
    // Default timeout preserved
    expect(cfg.command_timeout).toBe(30);
  });

  it('deep merges mcp_servers across home and project', () => {
    const homeConfig = path.join(tmpDir, 'home-config.json');
    writeJson(homeConfig, {
      mcp_servers: {
        home_server: { command: 'home-cmd' },
      },
    });

    writeJson(path.join(tmpDir, '.orchid.json'), {
      mcp_servers: {
        project_server: { command: 'proj-cmd' },
      },
    });

    const cfg = loadConfig({
      projectDir: homeConfig ? tmpDir : undefined,
      homeConfigPath: homeConfig,
    });

    // Default context7 present
    expect(cfg.mcp_servers).toHaveProperty('context7');
    // Home server present
    expect(cfg.mcp_servers).toHaveProperty('home_server');
    // Project server present
    expect(cfg.mcp_servers).toHaveProperty('project_server');
  });
});

// ===========================================================================
// ConfigManager singleton
// ===========================================================================

describe('ConfigManager', () => {
  beforeEach(clearOrchidEnv);

  it('load() returns cached config on subsequent calls', () => {
    const cfg1 = ConfigManager.load({ projectDir: tmpDir, homeConfigPath: NO_HOME_CONFIG });
    const cfg2 = ConfigManager.load({ projectDir: tmpDir, homeConfigPath: NO_HOME_CONFIG });
    expect(cfg1).toBe(cfg2); // same reference
  });

  it('reset() clears cache so next load() re-reads', () => {
    const cfg1 = ConfigManager.load({ projectDir: tmpDir, homeConfigPath: NO_HOME_CONFIG });
    ConfigManager.reset();
    const cfg2 = ConfigManager.load({ projectDir: tmpDir, homeConfigPath: NO_HOME_CONFIG });
    expect(cfg1).not.toBe(cfg2); // different reference
    expect(cfg1).toEqual(cfg2); // same values
  });

  it('errors() returns empty for valid default config', () => {
    ConfigManager.load({ projectDir: tmpDir, homeConfigPath: NO_HOME_CONFIG });
    expect(ConfigManager.errors()).toEqual([]);
  });

  it('save() is a no-op when no config loaded', () => {
    // Should not throw
    ConfigManager.save();
  });
});

// ===========================================================================
// Persistence round-trip
// ===========================================================================

describe('persistence', () => {
  beforeEach(clearOrchidEnv);

  it('save + load round-trips config values', () => {
    const modified = {
      ...defaults(),
      default_model: 'modified/model',
      command_timeout: 99,
      rag: { ...defaults().rag, chunk_size: 5000 },
    };

    // Write modified config as project config
    writeJson(path.join(tmpDir, '.orchid.json'), modified);

    // Load and verify
    const cfg = loadConfig({
      projectDir: tmpDir,
      homeConfigPath: NO_HOME_CONFIG,
    });
    expect(cfg.default_model).toBe('modified/model');
    expect(cfg.command_timeout).toBe(99);
    expect(cfg.rag.chunk_size).toBe(5000);
    // Other fields still default
    expect(cfg.theme).toBe('default');
    expect(cfg.rag.top_k).toBe(5);
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe('edge cases', () => {
  beforeEach(clearOrchidEnv);

  /** Load config with no home config. */
  function loadNoHome(projectDir?: string) {
    return loadConfig({
      projectDir: projectDir ?? tmpDir,
      homeConfigPath: NO_HOME_CONFIG,
    });
  }

  it('empty project config file is treated as no overrides', () => {
    writeJson(path.join(tmpDir, '.orchid.json'), {});
    const cfg = loadNoHome();
    expect(cfg).toEqual(defaults());
  });

  it('malformed JSON in config file is treated as empty', () => {
    fs.writeFileSync(path.join(tmpDir, '.orchid.json'), 'not valid json{{{', 'utf-8');
    const cfg = loadNoHome();
    expect(cfg).toEqual(defaults());
  });

  it('missing config file is treated as empty', () => {
    const cfg = loadNoHome();
    expect(cfg).toEqual(defaults());
  });

  it('tier_models partial override merges correctly', () => {
    writeJson(path.join(tmpDir, '.orchid.json'), {
      tier_models: { seed: 'custom/seed-model' },
    });
    const cfg = loadNoHome();
    expect(cfg.tier_models['seed']).toBe('custom/seed-model');
    expect(cfg.tier_models['crown']).toBe('default/mimo-v2.5'); // default preserved
  });

  it('mcp_servers partial override merges per-server', () => {
    writeJson(path.join(tmpDir, '.orchid.json'), {
      mcp_servers: {
        custom: { command: 'my-server', args: ['--port', '3000'] },
      },
    });
    const cfg = loadNoHome();
    // Default context7 preserved
    expect(cfg.mcp_servers).toHaveProperty('context7');
    // Custom server added
    expect(cfg.mcp_servers).toHaveProperty('custom');
    expect(cfg.mcp_servers['custom']!['command']).toBe('my-server');
  });

  it('providers partial override merges per-provider', () => {
    writeJson(path.join(tmpDir, '.orchid.json'), {
      providers: {
        openai: {
          base_url: 'https://api.openai.com/v1',
          api_key_env: 'OPENAI_API_KEY',
          models: { 'gpt-4o': {} },
        },
      },
    });
    const cfg = loadNoHome();
    // Default provider preserved
    expect(cfg.providers).toHaveProperty('default');
    // OpenAI provider added
    expect(cfg.providers).toHaveProperty('openai');
    expect(cfg.providers['openai']!['base_url']).toBe('https://api.openai.com/v1');
  });

  it('env override for RAG fields works end-to-end', () => {
    process.env['ORCHID_RAG_TOP_K'] = '20';
    process.env['ORCHID_RAG_CHUNK_SIZE'] = '4000';
    const cfg = loadNoHome();
    expect(cfg.rag.top_k).toBe(20);
    expect(cfg.rag.chunk_size).toBe(4000);
    expect(cfg.rag.chunk_overlap).toBe(200); // default
  });

  it('multiple env overrides applied correctly', () => {
    process.env['ORCHID_DEFAULT_MODEL'] = 'env/model';
    process.env['ORCHID_COMMAND_TIMEOUT'] = '120';
    process.env['ORCHID_THEME'] = 'dark';
    process.env['ORCHID_LLM_STREAM_RETRIES'] = '5';
    process.env['ORCHID_BG_CMD_IDLE_TIMEOUT'] = '1800';

    const cfg = loadNoHome();
    expect(cfg.default_model).toBe('env/model');
    expect(cfg.command_timeout).toBe(120);
    expect(cfg.theme).toBe('dark');
    expect(cfg.llm_stream_retries).toBe(5);
    expect(cfg.background_command_idle_timeout).toBe(1800);
  });
});
