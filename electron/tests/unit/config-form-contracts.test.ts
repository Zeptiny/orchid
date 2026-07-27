/**
 * Configuration form contracts (U7): draft merge boundary and valid zero values.
 */
import { describe, expect, it } from 'vitest';
import { defaults } from '../../src/main/config/schema';
import {
  applyConfigDraft,
  configNumberPatch,
  mergeConfigDraft,
  parseConfigNumber,
} from '../../src/renderer/utils/config-draft';
import type { Config } from '../../src/shared/types/ipc-boundary';
import type { ConfigPatch } from '../../src/shared/types/ipc';

/** Known Config keys that applyConfigDraft must honor (guards silent drops). */
const KNOWN_CONFIG_KEYS = [
  'default_model',
  'tier_models',
  'ignored_dirs',
  'command_timeout',
  'read_line_limit',
  'grep_max_results',
  'directory_tree_depth',
  'theme',
  'personality',
  'rag',
  'subagents',
  'ast_max_file_size',
  'mcp_startup_timeout',
  'mcp_per_server_timeout',
  'mcp_servers',
  'providers',
  'llm_stream_idle_timeout',
  'llm_stream_retries',
  'background_command_idle_timeout',
  'max_tool_steps',
  'default_project_dir',
  'always_expand_tool_groups',
  'has_completed_onboarding',
  'tier_reasoning_effort',
  'permission_history_size',
  'permissions',
  'command_max_output_bytes',
  'tool_output_inline_threshold',
  'approval_timeout',
  'subagent_wait_timeout',
  'web_fetch_timeout',
  'web_fetch_max_body_bytes',
  'web_fetch_user_agent',
  'bg_prompt_max_entries',
  'bg_prompt_tail_lines',
  'bg_prompt_tail_chars',
  'mcp_result_max_bytes',
  'max_background_processes',
  'bg_output_head_bytes',
  'bg_output_tail_bytes',
  'grep_per_file_timeout',
  'read_output_long_poll_max',
  'llm_retry_backoff_base',
  'llm_retry_max_delay',
] as const satisfies ReadonlyArray<keyof Config>;

describe('parseConfigNumber', () => {
  it('accepts valid zero when min is 0', () => {
    expect(parseConfigNumber('0', 0)).toBe(0);
    expect(parseConfigNumber('0', 0, { integer: true })).toBe(0);
  });

  it('rejects zero when min is positive', () => {
    expect(parseConfigNumber('0', 1)).toBeNull();
    expect(parseConfigNumber('0', 1, { integer: true })).toBeNull();
  });

  it('accepts positive integers and floats within min', () => {
    expect(parseConfigNumber('3', 0, { integer: true })).toBe(3);
    expect(parseConfigNumber('30.5', 1)).toBe(30.5);
  });

  it('rejects non-integers when integer mode is required', () => {
    expect(parseConfigNumber('12.5', 1, { integer: true })).toBeNull();
  });

  it('rejects empty and non-numeric input', () => {
    expect(parseConfigNumber('', 0)).toBeNull();
    expect(parseConfigNumber('abc', 0)).toBeNull();
  });
});

describe('configNumberPatch', () => {
  it('builds typed numeric patches including zero', () => {
    expect(configNumberPatch('llm_stream_retries', 0)).toEqual({
      llm_stream_retries: 0,
    });
    expect(configNumberPatch('command_timeout', 30)).toEqual({
      command_timeout: 30,
    });
  });
});

describe('mergeConfigDraft', () => {
  it('replaces full MCP editor maps so delete and rename are not resurrected', () => {
    const first = mergeConfigDraft({}, {
      mcp_servers: {
        old: { command: 'old-command' },
        keep: { command: 'keep-command' },
      },
    });
    const renamed = mergeConfigDraft(first, {
      mcp_servers: {
        renamed: { command: 'old-command' },
        keep: { command: 'keep-command' },
      },
    });

    expect(renamed.mcp_servers).toEqual({
      renamed: { command: 'old-command' },
      keep: { command: 'keep-command' },
    });
  });

  it('continues to accumulate incremental permission edits and tombstones', () => {
    const first = mergeConfigDraft({}, { permissions: { grep: 'ask' } });
    const second = mergeConfigDraft(first, { permissions: { write: 'allow', grep: null } });

    expect(second.permissions).toEqual({ grep: null, write: 'allow' });
  });
});

describe('applyConfigDraft', () => {
  it('merges scalar patches without broad casts losing nested config', () => {
    const base = defaults();
    const draft: ConfigPatch = {
      theme: 'bluey',
      llm_stream_retries: 0,
      rag: { chunk_overlap: 0 },
    };
    const next = applyConfigDraft(base, draft);
    expect(next.theme).toBe('bluey');
    expect(next.llm_stream_retries).toBe(0);
    expect(next.rag.chunk_overlap).toBe(0);
    expect(next.rag.chunk_size).toBe(base.rag.chunk_size);
    expect(next.rag.embedding_model).toBe(base.rag.embedding_model);
  });

  it('applies every known Config key from a full patch (no silent drops)', () => {
    const base = defaults();
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'gpt-4o',
    };
    const draft: ConfigPatch = {
      default_model: selection,
      tier_models: { seed: selection, bloom: null },
      tier_reasoning_effort: { seed: 'low', bloom: null },
      ignored_dirs: ['.git', 'node_modules'],
      command_timeout: 0,
      read_line_limit: 1,
      grep_max_results: 2,
      directory_tree_depth: 3,
      theme: 'bluey',
      personality: 'terse',
      subagents: {
        event_max_per_flush: 50,
        usage_event_interval_ms: 0,
        max_active_global: 2,
      },
      rag: {
        chunk_size: 100,
        chunk_overlap: 0,
        top_k: 1,
        max_file_size: 1024,
        embedding_model: 'fastembed/test',
        embedding_threads: 1,
        embedding_batch_size: 1,
        embedding_api_timeout: 15,
        embedding_api_retries: 2,
        embedding_api_model: selection,
      },
      ast_max_file_size: 4,
      mcp_startup_timeout: 5,
      mcp_per_server_timeout: 6,
      mcp_servers: { keep: { command: 'npx' }, drop: null },
      providers: {},
      llm_stream_idle_timeout: 10,
      llm_stream_retries: 0,
      background_command_idle_timeout: 30,
      max_tool_steps: 7,
      default_project_dir: null,
      always_expand_tool_groups: true,
      has_completed_onboarding: true,
      permission_history_size: 5,
      permissions: { grep: 'allow' },
      command_max_output_bytes: 2_000_000,
      tool_output_inline_threshold: 10_000,
      approval_timeout: 300,
      subagent_wait_timeout: 120,
      web_fetch_timeout: 15,
      web_fetch_max_body_bytes: 5_000_000,
      web_fetch_user_agent: 'TestAgent/1.0',
      bg_prompt_max_entries: 3,
      bg_prompt_tail_lines: 4,
      bg_prompt_tail_chars: 250,
      mcp_result_max_bytes: 1_000_000,
      max_background_processes: 32,
      bg_output_head_bytes: 262_144,
      bg_output_tail_bytes: 262_144,
      grep_per_file_timeout: 5,
      read_output_long_poll_max: 30,
      llm_retry_backoff_base: 0.5,
      llm_retry_max_delay: 15,
    };

    const next = applyConfigDraft(base, draft);

    for (const key of KNOWN_CONFIG_KEYS) {
      expect(next).toHaveProperty(key);
    }

    expect(next.default_model).toEqual(selection);
    expect(next.tier_models.seed).toEqual(selection);
    expect(next.tier_models.bloom).toBeNull();
    expect(next.tier_reasoning_effort.seed).toBe('low');
    expect(next.tier_reasoning_effort.bloom).toBeNull();
    expect(next.ignored_dirs).toEqual(['.git', 'node_modules']);
    expect(next.command_timeout).toBe(0);
    expect(next.read_line_limit).toBe(1);
    expect(next.grep_max_results).toBe(2);
    expect(next.directory_tree_depth).toBe(3);
    expect(next.theme).toBe('bluey');
    expect(next.personality).toBe('terse');
    expect(next.subagents.event_max_per_flush).toBe(50);
    expect(next.subagents.usage_event_interval_ms).toBe(0);
    expect(next.subagents.max_active_global).toBe(2);
    expect(next.subagents.event_byte_budget_kb).toBe(base.subagents.event_byte_budget_kb);
    expect(next.rag).toEqual(draft.rag);
    expect(next.ast_max_file_size).toBe(4);
    expect(next.mcp_startup_timeout).toBe(5);
    expect(next.mcp_per_server_timeout).toBe(6);
    expect(next.mcp_servers).toEqual({ keep: { command: 'npx' } });
    expect(next.providers).toEqual({});
    expect(next.llm_stream_idle_timeout).toBe(10);
    expect(next.llm_stream_retries).toBe(0);
    expect(next.background_command_idle_timeout).toBe(30);
    expect(next.max_tool_steps).toBe(7);
    expect(next.default_project_dir).toBeNull();
    expect(next.always_expand_tool_groups).toBe(true);
    expect(next.has_completed_onboarding).toBe(true);
    expect(next.permission_history_size).toBe(5);
    expect(next.permissions).toEqual({ grep: 'allow' });
    expect(next.command_max_output_bytes).toBe(2_000_000);
    expect(next.tool_output_inline_threshold).toBe(10_000);
    expect(next.approval_timeout).toBe(300);
    expect(next.subagent_wait_timeout).toBe(120);
    expect(next.web_fetch_timeout).toBe(15);
    expect(next.web_fetch_max_body_bytes).toBe(5_000_000);
    expect(next.web_fetch_user_agent).toBe('TestAgent/1.0');
    expect(next.bg_prompt_max_entries).toBe(3);
    expect(next.bg_prompt_tail_lines).toBe(4);
    expect(next.bg_prompt_tail_chars).toBe(250);
    expect(next.mcp_result_max_bytes).toBe(1_000_000);
    expect(next.max_background_processes).toBe(32);
    expect(next.bg_output_head_bytes).toBe(262_144);
    expect(next.bg_output_tail_bytes).toBe(262_144);
    expect(next.grep_per_file_timeout).toBe(5);
    expect(next.read_output_long_poll_max).toBe(30);
    expect(next.llm_retry_backoff_base).toBe(0.5);
    expect(next.llm_retry_max_delay).toBe(15);
  });

  it('accepts zero for numeric fields that allow min 0', () => {
    const base = defaults();
    const next = applyConfigDraft(base, {
      llm_stream_retries: 0,
      command_timeout: 0,
      rag: { chunk_overlap: 0 },
    });
    expect(next.llm_stream_retries).toBe(0);
    expect(next.command_timeout).toBe(0);
    expect(next.rag.chunk_overlap).toBe(0);
  });

  it('applies mcp_servers tombstones as deletes', () => {
    const base = {
      ...defaults(),
      mcp_servers: {
        keep: { command: 'npx' },
        drop: { command: 'node' },
      },
    };
    const next = applyConfigDraft(base, {
      mcp_servers: {
        keep: { command: 'npx', args: ['-y'] },
        drop: null,
      },
    });
    expect(next.mcp_servers).toEqual({
      keep: { command: 'npx', args: ['-y'] },
    });
  });

  it('preserves model selection contracts on default_model and tier_models', () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'gpt-4o',
    };
    const base = defaults();
    const next = applyConfigDraft(base, {
      default_model: selection,
      tier_models: {
        seed: selection,
        bloom: null,
      },
    });
    expect(next.default_model).toEqual(selection);
    expect(next.tier_models.seed).toEqual(selection);
    expect(next.tier_models.bloom).toBeNull();
    expect(next.tier_models.sprout).toBe(base.tier_models.sprout);
  });

  it('applies tier_reasoning_effort null entry as tombstone', () => {
    const base = {
      ...defaults(),
      tier_reasoning_effort: { seed: 'high', bloom: 'low' } as Record<string, string | number | null>,
    };
    const next = applyConfigDraft(base, {
      tier_reasoning_effort: { seed: null },
    });
    expect(next.tier_reasoning_effort.seed).toBeNull();
    expect(next.tier_reasoning_effort.bloom).toBe('low');
  });

  it('applies tier_reasoning_effort string entry', () => {
    const base = defaults();
    const next = applyConfigDraft(base, {
      tier_reasoning_effort: { bloom: 'medium' },
    });
    expect(next.tier_reasoning_effort.bloom).toBe('medium');
  });

  it('applies tier_reasoning_effort number entry', () => {
    const base = defaults();
    const next = applyConfigDraft(base, {
      tier_reasoning_effort: { seed: 8192 },
    });
    expect(next.tier_reasoning_effort.seed).toBe(8192);
  });

  it('leaves base tier_reasoning_effort untouched for undefined entries', () => {
    const base = {
      ...defaults(),
      tier_reasoning_effort: { seed: 'high', bloom: 'low' } as Record<string, string | number | null>,
    };
    const next = applyConfigDraft(base, {
      tier_reasoning_effort: { sprout: 'medium' },
    });
    expect(next.tier_reasoning_effort.seed).toBe('high');
    expect(next.tier_reasoning_effort.bloom).toBe('low');
    expect(next.tier_reasoning_effort.sprout).toBe('medium');
  });
});

describe('GeneralTab / RAGTab zero-value source contracts', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const prefs = path.resolve(__dirname, '../../src/renderer/components/Preferences');

  it('GeneralTab accepts zero stream retries via min-0 integer parse', () => {
    const source = fs.readFileSync(path.join(prefs, 'GeneralTab.tsx'), 'utf8');
    expect(source).toContain("handleIntChange('llm_stream_retries'");
    expect(source).toContain('min={0}');
    expect(source).toContain('parseConfigNumber');
    expect(source).toContain('configNumberPatch');
    expect(source).not.toContain('as ConfigPatch');
  });

  it('RAGTab accepts zero chunk overlap via min-0 integer parse', () => {
    const source = fs.readFileSync(path.join(prefs, 'RAGTab.tsx'), 'utf8');
    expect(source).toContain("handleNumberChange('chunk_overlap'");
    expect(source).toContain(', 0)');
    expect(source).toContain('parseConfigNumber');
    expect(source).toContain('NumericRAGConfigKey');
    expect(source).not.toContain('as RAGConfig');
  });

  it('ConfigView uses typed applyConfigDraft instead of broad cast', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/components/ConfigView.tsx'),
      'utf8',
    );
    expect(source).toContain('applyConfigDraft');
    expect(source).not.toContain('as Config');
    expect(source).toContain('DialogSurface');
  });
});
