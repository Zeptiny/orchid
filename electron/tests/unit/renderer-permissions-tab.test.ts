import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PermissionsTab } from '../../src/renderer/components/Preferences/PermissionsTab';
import type { Config, PermissionRule } from '../../src/shared/types/ipc-boundary';
import { applyConfigDraft, mergeConfigDraft } from '../../src/renderer/utils/config-draft';
import type { ConfigPatch } from '../../src/shared/types/ipc';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    default_model: null,
    tier_models: {},
    tier_reasoning_effort: {},
    ignored_dirs: [],
    command_timeout: 30,
    read_line_limit: 1000,
    grep_max_results: 100,
    directory_tree_depth: 2,
    theme: 'default',
    personality: 'default',
    rag: {
      chunk_size: 1000,
      chunk_overlap: 200,
      top_k: 5,
      max_file_size: 1_000_000,
      embedding_model: 'Xenova/all-MiniLM-L6-v2',
      embedding_threads: 2,
      embedding_batch_size: 16,
      embedding_api_model: null,
    },
    ast_max_file_size: 1_048_576,
    mcp_startup_timeout: 60,
    mcp_per_server_timeout: 10,
    mcp_servers: {},
    providers: {},
    llm_stream_idle_timeout: 300,
    llm_stream_retries: 3,
    background_command_idle_timeout: 900,
    max_tool_steps: 100,
    permission_history_size: 10,
    permissions: {},
    default_project_dir: null,
    always_expand_tool_groups: false,
    has_completed_onboarding: true,
    ...overrides,
  };
}

function renderTab(config: Config): string {
  const node: ReactElement = createElement(PermissionsTab, {
    config,
    updateDraft: () => {},
  });
  return renderToStaticMarkup(node);
}

function selectedValue(html: string, selectId: string): string | null {
  const start = html.indexOf(`id="${selectId}"`);
  if (start === -1) return null;
  const end = html.indexOf('</select>', start);
  const block = html.slice(start, end);
  const match =
    block.match(/<option[^>]*\bselected\b[^>]*\bvalue="([^"]*)"/) ??
    block.match(/<option[^>]*\bvalue="([^"]*)"[^>]*\bselected\b/);
  return match?.[1] ?? null;
}

describe('PermissionsTab grouping', () => {
  it('renders separate global and active-project scope controls', () => {
    const html = renderToStaticMarkup(createElement(PermissionsTab, {
      config: makeConfig(),
      updateDraft: () => {},
      scope: 'project',
      projectDir: '/work/project',
      onScopeChange: () => {},
    }));
    expect(html).toContain('Permission configuration scope');
    expect(html).toContain('Global');
    expect(html).toContain('Project');
    expect(html).toContain('/work/project');
    expect(html).toContain('active project scope');
    expect(html).not.toContain('>All</button>');
  });

  it('withholds project editors while a new workspace scope is loading', () => {
    const html = renderToStaticMarkup(createElement(PermissionsTab, {
      config: makeConfig({ permissions: { write: 'allow' } }),
      updateDraft: () => {},
      scope: 'project',
      projectDir: '/work/old-project',
      projectLoading: true,
      onScopeChange: () => {},
    }));

    expect(html).toContain('Loading project permissions');
    expect(html).not.toContain('id="perm-write-inside"');
  });

  it('renders one section per risk class plus MCP', () => {
    const html = renderTab(makeConfig());
    for (const title of [
      'Read-only tools',
      'Mutation tools',
      'Execution tools',
      'Delegation tools',
      'Network tools',
      'MCP tools',
    ]) {
      expect(html).toContain(title);
    }
  });

  it('renders every built-in tool row', () => {
    const html = renderTab(makeConfig());
    for (const tool of [
      'read',
      'grep',
      'glob',
      'rag_search',
      'read_directory',
      'read_output',
      'get_file_skeleton',
      'get_function',
      'find_symbol_references',
      'plan_symbol_rename',
      'list_mcp_resources',
      'read_mcp_resource',
      'todo_list',
      'wait_for_subagent',
      'skill',
      'ask_question',
      'write',
      'edit',
      'apply_patch',
      'replace_symbol',
      'rename_symbol',
      'todo_create',
      'todo_update',
      'todo_delete',
      'rag_index',
      'ast_index',
      'execute_command',
      'send_input',
      'terminate_command',
      'delegate_to_subagent',
      'interrupt_subagents',
      'answer_subagent',
      'web_fetch',
    ]) {
      expect(html).toContain(`>${tool}</span>`);
    }
  });

  it('shows inside/outside selectors for file tools and a single selector otherwise', () => {
    const html = renderTab(makeConfig());
    expect(html).toContain('id="perm-read-inside"');
    expect(html).toContain('id="perm-read-outside"');
    expect(html).toContain('id="perm-apply_patch-inside"');
    expect(html).toContain('id="perm-apply_patch-outside"');
    expect(html).toContain('id="perm-grep-inside"');
    expect(html).toContain('id="perm-grep-outside"');
    expect(html).not.toContain('id="perm-rag_search-inside"');
    expect(html).toContain('id="perm-rag_search"');
    expect(html).toContain('id="perm-execute_command"');
    expect(html).toContain('Inside project');
    expect(html).toContain('Outside project');
  });

  it('renders all four modes in each selector', () => {
    const html = renderTab(makeConfig());
    const start = html.indexOf('id="perm-execute_command"');
    const block = html.slice(start, html.indexOf('</select>', start));
    for (const mode of ['allow', 'ask', 'decide-for-me', 'ask-when-flagged']) {
      expect(block).toContain(`value="${mode}"`);
    }
  });
});

describe('PermissionsTab defaults and overrides', () => {
  it('shows risk-class defaults when no overrides are set', () => {
    const html = renderTab(makeConfig());
    expect(selectedValue(html, 'perm-grep-inside')).toBe('allow');
    expect(selectedValue(html, 'perm-grep-outside')).toBe('ask');
    expect(selectedValue(html, 'perm-execute_command')).toBe('ask');
    expect(selectedValue(html, 'perm-web_fetch')).toBe('ask');
    expect(selectedValue(html, 'perm-read-inside')).toBe('allow');
    expect(selectedValue(html, 'perm-read-outside')).toBe('ask');
    expect(selectedValue(html, 'perm-write-inside')).toBe('ask');
    expect(selectedValue(html, 'perm-write-outside')).toBe('ask');
  });

  it('reflects object rules per slot for file tools', () => {
    const html = renderTab(
      makeConfig({
        permissions: { read: { inside: 'decide-for-me', outside: 'allow' } },
      }),
    );
    expect(selectedValue(html, 'perm-read-inside')).toBe('decide-for-me');
    expect(selectedValue(html, 'perm-read-outside')).toBe('allow');
  });

  it('applies a string rule on a file tool to both slots', () => {
    const html = renderTab(makeConfig({ permissions: { edit: 'allow' } }));
    expect(selectedValue(html, 'perm-edit-inside')).toBe('allow');
    expect(selectedValue(html, 'perm-edit-outside')).toBe('allow');
  });

  it('reflects string rules for non-file tools', () => {
    const html = renderTab(
      makeConfig({ permissions: { execute_command: 'ask-when-flagged' } }),
    );
    expect(selectedValue(html, 'perm-execute_command')).toBe('ask-when-flagged');
  });

  it('marks overridden rows and counts them in the section header', () => {
    const html = renderTab(makeConfig({ permissions: { grep: 'ask' } }));
    expect(html).toContain('1 custom');
  });
});

describe('PermissionsTab MCP section', () => {
  it('shows an empty state when no servers are configured', () => {
    const html = renderTab(makeConfig());
    expect(html).toContain('No MCP servers configured');
  });

  it('groups a configured server with an all-tools wildcard row', () => {
    const html = renderTab(
      makeConfig({ mcp_servers: { context7: { command: 'npx' } } }),
    );
    expect(html).toContain('>context7</span>');
    expect(html).toContain('mcp::context7::*');
    expect(html).toContain('id="perm-mcp-context7-all"');
    expect(selectedValue(html, 'perm-mcp-context7-all')).toBe('ask');
  });

  it('lists per-tool overrides and derives servers from permission keys', () => {
    const permissions: Record<string, PermissionRule> = {
      'mcp::context7::resolve-library-id': 'allow',
    };
    const html = renderTab(makeConfig({ permissions }));
    expect(html).toContain('>resolve-library-id</span>');
    expect(html).toContain('id="perm-mcp::context7::resolve-library-id"');
    expect(selectedValue(html, 'perm-mcp::context7::resolve-library-id')).toBe('allow');
  });

  it('lists live tools reported by connected MCP servers', () => {
    const html = renderToStaticMarkup(
      createElement(PermissionsTab, {
        config: makeConfig({ mcp_servers: { context7: { command: 'npx' } } }),
        updateDraft: () => {},
        mcpStatus: [
          {
            name: 'context7',
            status: 'connected' as const,
            toolCount: 2,
            tools: ['resolve-library-id', 'query-docs'],
            error: null,
          },
        ],
      }),
    );
    expect(html).toContain('>query-docs</span>');
    expect(html).toContain('>resolve-library-id</span>');
    expect(html).toContain('id="perm-mcp::context7::query-docs"');
    expect(selectedValue(html, 'perm-mcp::context7::query-docs')).toBe('ask');
  });

  it('merges live tools with existing per-tool overrides', () => {
    const permissions: Record<string, PermissionRule> = {
      'mcp::context7::query-docs': 'allow',
    };
    const html = renderToStaticMarkup(
      createElement(PermissionsTab, {
        config: makeConfig({
          mcp_servers: { context7: { command: 'npx' } },
          permissions,
        }),
        updateDraft: () => {},
        mcpStatus: [
          {
            name: 'context7',
            status: 'connected' as const,
            toolCount: 2,
            tools: ['resolve-library-id', 'query-docs'],
            error: null,
          },
        ],
      }),
    );
    expect(selectedValue(html, 'perm-mcp::context7::query-docs')).toBe('allow');
    expect(selectedValue(html, 'perm-mcp::context7::resolve-library-id')).toBe('ask');
  });

  it('shows servers discovered only through live status', () => {
    const html = renderToStaticMarkup(
      createElement(PermissionsTab, {
        config: makeConfig(),
        updateDraft: () => {},
        mcpStatus: [
          {
            name: 'runtime-only',
            status: 'connected' as const,
            toolCount: 1,
            tools: ['ping'],
            error: null,
          },
        ],
      }),
    );
    expect(html).toContain('>runtime-only</span>');
    expect(html).toContain('mcp::runtime-only::*');
    expect(html).toContain('>ping</span>');
  });

  it('flags servers that are not connected', () => {
    const html = renderToStaticMarkup(
      createElement(PermissionsTab, {
        config: makeConfig({ mcp_servers: { broken: { command: 'nope' } } }),
        updateDraft: () => {},
        mcpStatus: [
          {
            name: 'broken',
            status: 'failed' as const,
            toolCount: 0,
            tools: [],
            error: 'ENOENT',
          },
        ],
      }),
    );
    expect(html).toContain('>failed</span>');
  });
});

describe('PermissionsTab reset button', () => {
  it('is disabled when there are no overrides', () => {
    const html = renderTab(makeConfig());
    expect(html).toMatch(/Reset all to defaults/);
    const button = html.slice(html.indexOf('<button'), html.indexOf('Reset all to defaults'));
    expect(button).toContain('disabled');
  });

  it('is enabled when overrides exist', () => {
    const html = renderTab(makeConfig({ permissions: { grep: 'ask' } }));
    const start = html.lastIndexOf('<button', html.indexOf('Reset all to defaults'));
    const button = html.slice(start, html.indexOf('Reset all to defaults'));
    expect(button).not.toContain('disabled');
  });

  it('clears every override through the draft merge', () => {
    const base = makeConfig({
      permissions: {
        grep: 'ask',
        read: { inside: 'allow', outside: 'decide-for-me' },
        'mcp::context7::*': 'allow',
      },
    });
    const cleared = applyConfigDraft(base, {
      permissions: Object.fromEntries(
        Object.keys(base.permissions).map((key): [string, null] => [key, null]),
      ),
    });
    expect(cleared.permissions).toEqual({});
  });

  it('accumulates sequential edits and lets a later edit replace a reset tombstone', () => {
    const base = makeConfig({ permissions: { grep: 'allow' } });
    let draft: ConfigPatch = {};
    draft = mergeConfigDraft(draft, { permissions: { grep: 'ask' } });
    draft = mergeConfigDraft(draft, { permissions: { edit: 'decide-for-me' } });
    draft = mergeConfigDraft(draft, { permissions: { grep: null } });
    draft = mergeConfigDraft(draft, { permissions: { grep: 'ask-when-flagged' } });

    expect(applyConfigDraft(base, draft).permissions).toEqual({
      grep: 'ask-when-flagged',
      edit: 'decide-for-me',
    });
  });
});
