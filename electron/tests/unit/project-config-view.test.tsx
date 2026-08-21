// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ProjectConfigView,
} from '../../src/renderer/components/ProjectConfigView';
import {
  readTierOverrides,
} from '../../src/renderer/components/Preferences/ProjectTierModelsTab';
import {
  fieldInputId,
  isPlainRecord,
  readGlobalValue,
  readStoredOverride,
  toInputValue,
} from '../../src/renderer/utils/project-config';
import type { DefinitionsListResult } from '../../src/shared/types/definitions';
import type { Config } from '../../src/shared/types/ipc-boundary';

const noop = () => {};

const PROJECT_DIR = '/home/user/projects/orchid';

const MOCK_CONFIG = {
  default_model: null,
  tier_models: { seed: null, sprout: null, bloom: null, crown: null },
  tier_reasoning_effort: { seed: null, sprout: null, bloom: null, crown: null },
  ignored_dirs: ['.git'],
  command_timeout: 30,
  read_line_limit: 1000,
  grep_max_results: 100,
  directory_tree_depth: 2,
  tool_worker_pool_size: 2,
  tool_worker_pool_main_agent_reserved: 1,
  theme: 'default',
  personality: 'default',
  agents_md: {
    enabled: true,
    filenames: ['AGENTS.md', 'CLAUDE.md'],
    max_file_bytes: 32768,
    max_chain_depth: 8,
    enforce_on_write: 'warn',
    inject_on_read: true,
    include_local: false,
  },
  rag: {
    chunk_size: 2000,
    chunk_overlap: 200,
    top_k: 5,
    max_file_size: 512000,
    embedding_model: 'fastembed/BAAI/bge-small-en-v1.5',
    embedding_threads: 2,
    embedding_batch_size: 16,
    embedding_api_timeout: 30,
    embedding_api_retries: 3,
    model_download_inactivity_timeout: 30,
    model_download_total_timeout: 900,
    embedding_api_model: null,
  },
  subagents: {
    event_max_per_flush: 200,
    event_byte_budget_kb: 64,
    usage_event_interval_ms: 1000,
    hydration_buffer_kb: 256,
    terminal_wave_ms: 250,
    max_active_global: 8,
    max_active_per_session: 4,
    max_queued: 32,
    terminal_retention: 25,
    prompt_recent_terminal: 5,
    prompt_task_max_chars: 200,
  },
  compaction: {
    main: {
      mode: 'simple',
      threshold: 0.8,
      model: null,
      agent_name: 'compactor',
      preserve_percent: 0.25,
      min_compactable_tokens: 4000,
      mechanical_reclaim: true,
      hysteresis_delta: 0.1,
      keep_last_user_messages: 10,
      pin_first_user_message: true,
    },
    subagents: {
      mode: 'simple',
      threshold: 0.85,
      model: null,
      agent_name: 'compactor-subagent',
      preserve_percent: 0.25,
      min_compactable_tokens: 4000,
      mechanical_reclaim: true,
      hysteresis_delta: 0.1,
      keep_last_user_messages: null,
      pin_first_user_message: true,
    },
  },
  ast_max_file_size: 1048576,
  mcp_startup_timeout: 60,
  mcp_per_server_timeout: 10,
  mcp_servers: {},
  llm_stream_idle_timeout: 300,
  llm_stream_retries: 3,
  background_command_idle_timeout: 900,
  max_tool_steps: 100,
  permission_history_size: 10,
  permissions: {},
  default_project_dir: null,
  always_expand_tool_groups: false,
  has_completed_onboarding: false,
  command_max_output_bytes: 1048576,
  tool_output_inline_threshold: 20000,
  approval_timeout: 600,
  subagent_wait_timeout: 300,
  web_fetch_timeout: 30,
  web_fetch_max_body_bytes: 10485760,
  web_fetch_user_agent: 'Orchid/1.0 web-fetch (Electron)',
  bg_prompt_max_entries: 5,
  bg_prompt_tail_lines: 8,
  bg_prompt_tail_chars: 500,
  mcp_result_max_bytes: 5242880,
  session_title_max_wait_seconds: 15,
  max_background_processes: 64,
  bg_output_head_bytes: 524288,
  bg_output_tail_bytes: 524288,
  grep_per_file_timeout: 10,
  read_output_long_poll_max: 60,
  llm_retry_backoff_base: 0.2,
  llm_retry_max_delay: 30,
} satisfies Config;

const MOCK_DEFINITIONS = {
  projectDir: PROJECT_DIR,
  skills: [
    {
      name: 'deploy-check',
      description: 'Verify a deploy',
      requires: [],
      content: '# Deploy workflow',
      resources: [],
      scope: 'project',
      path: `${PROJECT_DIR}/.orchid/skills/deploy-check/SKILL.md`,
      overriddenByProject: false,
    },
  ],
  agents: [
    {
      name: 'code-reviewer',
      type: 'subagent',
      tier: 'bloom',
      description: 'Reviews code changes',
      system_prompt: 'Review carefully.',
      allowed_tools: ['read', 'grep'],
      allowed_skills: ['*'],
      scope: 'project',
      path: `${PROJECT_DIR}/.orchid/agents/code-reviewer/AGENT.md`,
      overriddenByProject: false,
    },
  ],
  personalities: [
    {
      name: 'default',
      content: 'Be helpful.',
      scope: 'global',
      path: '/home/user/.orchid/personalities/default.md',
      overriddenByProject: false,
    },
    {
      name: 'project-voice',
      content: 'Project tone guidance.',
      scope: 'project',
      path: `${PROJECT_DIR}/.orchid/personalities/project-voice.md`,
      overriddenByProject: false,
    },
  ],
  availableTools: ['read', 'grep', 'write'],
  availableSkills: ['deploy-check'],
} satisfies DefinitionsListResult;

function mockOrchid(overrides: Record<string, unknown> = {}) {
  const readProject = vi.fn().mockResolvedValue({ projectDir: PROJECT_DIR, overrides });
  const getHome = vi.fn().mockResolvedValue(MOCK_CONFIG);
  const saveProject = vi.fn().mockResolvedValue(undefined);
  const savePermissionScope = vi.fn().mockResolvedValue({ status: 'saved' });
  const list = vi.fn().mockResolvedValue(MOCK_DEFINITIONS);
  (window as Record<string, unknown>).orchid = {
    config: { readProject, getHome, saveProject, savePermissionScope },
    definitions: { list },
  };
  return { readProject, getHome, saveProject, savePermissionScope, list };
}

function renderView() {
  return render(
    <ProjectConfigView projectDir={PROJECT_DIR} onNewChat={noop} onClose={noop} />,
  );
}

function inputById(key: string): HTMLInputElement {
  return document.querySelector(`input[id="${fieldInputId(key)}"]`) as HTMLInputElement;
}

function selectById(key: string): HTMLSelectElement {
  return document.querySelector(`select[id="${fieldInputId(key)}"]`) as HTMLSelectElement;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
  fireEvent.change(input, { target: { value } });
}

async function renderLoaded(overrides: Record<string, unknown> = {}) {
  const mocks = mockOrchid(overrides);
  const result = renderView();
  await waitFor(() => {
    expect(screen.queryByText('Loading project configuration…')).toBeNull();
  });
  return { ...mocks, ...result };
}

async function switchTab(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  await user.click(screen.getByRole('tab', { name: label }));
}

function renderStatic(): string {
  return renderToStaticMarkup(
    <ProjectConfigView projectDir={PROJECT_DIR} onNewChat={noop} onClose={noop} />,
  );
}

beforeEach(() => {
  mockOrchid();
});

afterEach(() => {
  cleanup();
  delete (window as Record<string, unknown>).orchid;
});

describe('ProjectConfigView', () => {
  it('renders the project basename, full path, and header actions', () => {
    const html = renderStatic();
    expect(html).toContain('orchid');
    expect(html).toContain('/home/user/projects/orchid');
    expect(html).toContain('New Chat');
    expect(html).toContain('Reset All');
    expect(html).toContain('Back');
  });

  it('renders all ten tab buttons', () => {
    const html = renderStatic();
    for (const label of [
      'General',
      'Permissions',
      'MCP Servers',
      'Tier Models',
      'RAG',
      'AGENTS.md',
      'Skills',
      'Agents',
      'Personalities',
    ]) {
      expect(html).toContain(label);
    }
  });

  it('starts in a loading state before overrides resolve', () => {
    const html = renderStatic();
    expect(html).toContain('Loading project configuration');
    expect(html).not.toContain('Tool Limits');
  });

  it('loads placeholders from the home-only config', async () => {
    const { getHome } = await renderLoaded();
    expect(getHome).toHaveBeenCalledTimes(1);
    expect(inputById('command_timeout').placeholder).toBe('30');
  });

  it('general tab fields render with global placeholders after load', async () => {
    await renderLoaded();
    const timeoutInput = inputById('command_timeout');
    expect(timeoutInput).not.toBeNull();
    expect(timeoutInput.placeholder).toBe('30');
    expect(timeoutInput.value).toBe('');

    const agentInput = inputById('web_fetch_user_agent');
    expect(agentInput.placeholder).toBe('Orchid/1.0 web-fetch (Electron)');
  });

  it('rag tab fields render after switching tabs', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    expect(document.querySelector(`input[id="${fieldInputId('rag.chunk_size')}"]`)).toBeNull();

    await switchTab(user, 'RAG');
    const ragInput = inputById('rag.chunk_size');
    expect(ragInput).not.toBeNull();
    expect(ragInput.placeholder).toBe('2000');
    expect(ragInput.value).toBe('');
  });

  it('mcp tab renders timeout fields with placeholders', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await switchTab(user, 'MCP Servers');
    expect(inputById('mcp_startup_timeout').placeholder).toBe('60');
    expect(inputById('mcp_per_server_timeout').placeholder).toBe('10');
    expect(inputById('mcp_result_max_bytes').placeholder).toBe('5242880');
  });

  it('mcp tab renders the project server editor and saves deletions as tombstones', async () => {
    const user = userEvent.setup();
    const { saveProject } = await renderLoaded({
      mcp_servers: {
        docs: { command: 'npx', args: ['-y', 'docs-mcp'] },
      },
    });
    await switchTab(user, 'MCP Servers');

    expect(screen.getByText('docs')).toBeTruthy();
    expect(screen.getByText('+ Add Server')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.queryByText('docs')).toBeNull();
    expect(screen.getByText('Unsaved')).toBeTruthy();

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(saveProject).toHaveBeenCalledWith({
        projectDir: PROJECT_DIR,
        updates: { mcp_servers: { docs: null } },
      });
    });
  });

  it('mcp tab shows home-only servers as inherited and read-only', async () => {
    const user = userEvent.setup();
    const getHome = vi.fn().mockResolvedValue({
      ...MOCK_CONFIG,
      mcp_servers: { shared: { command: 'shared-mcp' } },
    });
    const readProject = vi.fn().mockResolvedValue({ projectDir: PROJECT_DIR, overrides: {} });
    (window as Record<string, unknown>).orchid = {
      config: {
        readProject,
        getHome,
        saveProject: vi.fn(),
        savePermissionScope: vi.fn().mockResolvedValue({ status: 'saved' }),
      },
      definitions: { list: vi.fn().mockResolvedValue(MOCK_DEFINITIONS) },
    };
    renderView();
    await waitFor(() => {
      expect(screen.queryByText('Loading project configuration…')).toBeNull();
    });
    await switchTab(user, 'MCP Servers');

    expect(screen.getByText('shared')).toBeTruthy();
    expect(screen.getByText('inherited from global')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Override' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('mcp tab commits a new project server through the add editor', async () => {
    const user = userEvent.setup();
    const { saveProject } = await renderLoaded();
    await switchTab(user, 'MCP Servers');

    await user.click(screen.getByText('+ Add Server'));
    await user.click(screen.getByLabelText('Server ID'));
    await user.keyboard('docs');
    await user.click(screen.getByLabelText('Command'));
    await user.keyboard('npx');
    await user.click(screen.getByText('Add Server'));

    expect(screen.getByText('docs')).toBeTruthy();
    expect(screen.getByText('Unsaved')).toBeTruthy();

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(saveProject).toHaveBeenCalledWith({
        projectDir: PROJECT_DIR,
        updates: { mcp_servers: { docs: { command: 'npx' } } },
      });
    });
  });

  it('mcp tab commits an Override seeded from an inherited home server', async () => {
    const user = userEvent.setup();
    const getHome = vi.fn().mockResolvedValue({
      ...MOCK_CONFIG,
      mcp_servers: { shared: { command: 'shared-mcp', args: ['-v'] } },
    });
    const readProject = vi.fn().mockResolvedValue({ projectDir: PROJECT_DIR, overrides: {} });
    const saveProject = vi.fn().mockResolvedValue(undefined);
    (window as Record<string, unknown>).orchid = {
      config: {
        readProject,
        getHome,
        saveProject,
        savePermissionScope: vi.fn().mockResolvedValue({ status: 'saved' }),
      },
      definitions: { list: vi.fn().mockResolvedValue(MOCK_DEFINITIONS) },
    };
    renderView();
    await waitFor(() => {
      expect(screen.queryByText('Loading project configuration…')).toBeNull();
    });
    await switchTab(user, 'MCP Servers');

    await user.click(screen.getByRole('button', { name: 'Override' }));
    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('shared-mcp');
    await user.click(screen.getByText('Add Server'));

    expect(screen.getByText('overrides global')).toBeTruthy();

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(saveProject).toHaveBeenCalledWith({
        projectDir: PROJECT_DIR,
        updates: {
          mcp_servers: { shared: { command: 'shared-mcp', args: ['-v'] } },
        },
      });
    });
  });

  it('tier models tab renders project-scope assignments instead of a global-only notice', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await switchTab(user, 'Tier Models');
    expect(screen.queryByText('Tier models are configured globally')).toBeNull();
    expect(screen.getByText('Default model')).toBeTruthy();
    expect(screen.getByText(/Unset tiers inherit the global assignment/)).toBeTruthy();
  });

  it('field change updates draft and shows dirty state', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const input = inputById('command_timeout');
    await user.click(input);
    await user.keyboard('60');

    expect(screen.getByText('Unsaved')).toBeTruthy();
    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
  });

  it('save calls saveProject with correct payload', async () => {
    const user = userEvent.setup();
    const { saveProject, readProject } = await renderLoaded();
    const input = inputById('command_timeout');
    await user.click(input);
    await user.keyboard('60');

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(saveProject).toHaveBeenCalledWith({
        projectDir: PROJECT_DIR,
        updates: { command_timeout: 60 },
      });
    });
    expect(readProject).toHaveBeenCalledTimes(2);
  });

  it('RAG nested key mapping produces nested rag object in save payload', async () => {
    const user = userEvent.setup();
    const { saveProject } = await renderLoaded();
    await switchTab(user, 'RAG');
    const input = inputById('rag.chunk_size');
    setInputValue(input, '4000');

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(saveProject).toHaveBeenCalledWith({
        projectDir: PROJECT_DIR,
        updates: { rag: { chunk_size: 4000 } },
      });
    });
  });

  it('per-field reset stages null tombstone', async () => {
    const user = userEvent.setup();
    const { saveProject } = await renderLoaded({ command_timeout: 60 });
    const input = inputById('command_timeout');
    expect(input.value).toBe('60');

    const resetButton = screen.getByLabelText('Reset Command Timeout (s) to global');
    await user.click(resetButton);

    expect(input.value).toBe('');
    expect(screen.getByText('Unsaved')).toBeTruthy();

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(saveProject).toHaveBeenCalledWith({
        projectDir: PROJECT_DIR,
        updates: { command_timeout: null },
      });
    });
  });

  it('reset all stages nulls for all overridden fields across tabs', async () => {
    const user = userEvent.setup();
    const { saveProject } = await renderLoaded({
      command_timeout: 60,
      web_fetch_timeout: 45,
      rag: { chunk_size: 4000 },
    });

    const resetAllButton = screen.getByText('Reset All').closest('button') as HTMLButtonElement;
    await user.click(resetAllButton);

    expect(inputById('command_timeout').value).toBe('');
    expect(inputById('web_fetch_timeout').value).toBe('');
    await switchTab(user, 'RAG');
    expect(inputById('rag.chunk_size').value).toBe('');
    expect(screen.getByText('Unsaved')).toBeTruthy();

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(saveProject).toHaveBeenCalledWith({
        projectDir: PROJECT_DIR,
        updates: {
          command_timeout: null,
          web_fetch_timeout: null,
          rag: { chunk_size: null },
        },
      });
    });
  });

  it('agents-md tab stages a nested agents_md override', async () => {
    const user = userEvent.setup();
    const { saveProject } = await renderLoaded();
    await switchTab(user, 'AGENTS.md');

    const enforceSelect = selectById('agents_md.enforce_on_write');
    expect(enforceSelect).not.toBeNull();
    expect(enforceSelect.options[0].textContent).toBe('Inherit global (warn)');

    await user.selectOptions(enforceSelect, 'block');
    expect(screen.getByText('Unsaved')).toBeTruthy();

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(saveProject).toHaveBeenCalledWith({
        projectDir: PROJECT_DIR,
        updates: { agents_md: { enforce_on_write: 'block' } },
      });
    });
  });

  it('boolean select stages a true override', async () => {
    const user = userEvent.setup();
    const { saveProject } = await renderLoaded();
    const expandSelect = selectById('always_expand_tool_groups');
    expect(expandSelect.value).toBe('');
    expect(expandSelect.options[0].textContent).toBe('Inherit global (disabled)');

    await user.selectOptions(expandSelect, 'true');

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(saveProject).toHaveBeenCalledWith({
        projectDir: PROJECT_DIR,
        updates: { always_expand_tool_groups: true },
      });
    });
  });

  it('ignored dirs list stages an array override', async () => {
    const user = userEvent.setup();
    const { saveProject } = await renderLoaded();
    const input = inputById('ignored_dirs');
    expect(input.placeholder).toBe('.git');

    setInputValue(input, '.git, node_modules');

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(saveProject).toHaveBeenCalledWith({
        projectDir: PROJECT_DIR,
        updates: { ignored_dirs: ['.git', 'node_modules'] },
      });
    });
  });

  it('permissions tab shows stored project rules and saves via savePermissionScope', async () => {
    const user = userEvent.setup();
    const { savePermissionScope, saveProject } = await renderLoaded({
      permissions: { grep: 'ask' },
    });
    await switchTab(user, 'Permissions');

    const grepSelect = screen.getByLabelText('grep — inside project') as HTMLSelectElement;
    expect(grepSelect.value).toBe('ask');

    await user.selectOptions(grepSelect, 'allow');
    expect(screen.getByText('Unsaved')).toBeTruthy();

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(savePermissionScope).toHaveBeenCalledWith({
        scope: 'project',
        updates: { grep: { inside: 'allow', outside: 'ask' } },
        expectedProjectDir: PROJECT_DIR,
      });
    });
    expect(saveProject).not.toHaveBeenCalled();
  });

  it('permissions tab inherits global rules without marking them as overrides', async () => {
    const user = userEvent.setup();
    const homeWithPermissions = { ...MOCK_CONFIG, permissions: { web_fetch: 'allow' } };
    const readProject = vi.fn().mockResolvedValue({ projectDir: PROJECT_DIR, overrides: {} });
    const getHome = vi.fn().mockResolvedValue(homeWithPermissions);
    (window as Record<string, unknown>).orchid = {
      config: {
        readProject,
        getHome,
        saveProject: vi.fn(),
        savePermissionScope: vi.fn().mockResolvedValue({ status: 'saved' }),
      },
      definitions: { list: vi.fn().mockResolvedValue(MOCK_DEFINITIONS) },
    };
    renderView();
    await waitFor(() => {
      expect(screen.queryByText('Loading project configuration…')).toBeNull();
    });
    await switchTab(user, 'Permissions');

    const webFetchSelect = screen.getByLabelText('web_fetch permission mode') as HTMLSelectElement;
    expect(webFetchSelect.value).toBe('allow');

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it('skills tab renders embedded SkillsTab with project scope', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await switchTab(user, 'Skills');
    await waitFor(() => {
      expect(screen.getByText('deploy-check')).toBeTruthy();
    });
    expect(screen.queryByText('Save')).toBeNull();
    expect(screen.queryByText('Reset All')).toBeNull();
  });

  it('agents tab renders embedded AgentsTab', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await switchTab(user, 'Agents');
    await waitFor(() => {
      expect(screen.getByText('code-reviewer')).toBeTruthy();
    });
  });

  it('personalities tab renders embedded PersonalitiesTab', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await switchTab(user, 'Personalities');
    await waitFor(() => {
      expect(screen.getByText('project-voice')).toBeTruthy();
    });
  });

  it('save failure displays the error message from the rejected promise', async () => {
    const user = userEvent.setup();
    const { saveProject } = await renderLoaded();
    const input = inputById('command_timeout');
    await user.click(input);
    await user.keyboard('60');

    saveProject.mockRejectedValueOnce(new Error('disk full'));

    const saveButton = screen.getByText('Save').closest('button') as HTMLButtonElement;
    await user.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText('disk full')).toBeTruthy();
    });
  });

  it('load failure displays a configuration error message', async () => {
    const readProject = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const getHome = vi.fn().mockResolvedValue(MOCK_CONFIG);
    (window as Record<string, unknown>).orchid = {
      config: { readProject, getHome, saveProject: vi.fn(), savePermissionScope: vi.fn() },
      definitions: { list: vi.fn().mockResolvedValue(MOCK_DEFINITIONS) },
    };

    renderView();

    await waitFor(() => {
      expect(screen.getByText('Failed to load project configuration.')).toBeTruthy();
    });
  });

  it('isPlainRecord guard prevents crash on non-object overrides', async () => {
    const readProject = vi.fn().mockResolvedValue({ projectDir: PROJECT_DIR, overrides: [1, 2, 3] });
    const getHome = vi.fn().mockResolvedValue(MOCK_CONFIG);
    (window as Record<string, unknown>).orchid = {
      config: { readProject, getHome, saveProject: vi.fn(), savePermissionScope: vi.fn() },
      definitions: { list: vi.fn().mockResolvedValue(MOCK_DEFINITIONS) },
    };

    renderView();
    await waitFor(() => {
      expect(screen.queryByText('Loading project configuration…')).toBeNull();
    });

    expect(screen.getByText('Tool Limits')).toBeTruthy();
    const input = inputById('command_timeout');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('30');
  });
});

describe('ProjectConfigView helpers', () => {
  it('isPlainRecord accepts plain objects and rejects arrays, null, primitives', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([1, 2, 3])).toBe(false);
    expect(isPlainRecord('string')).toBe(false);
    expect(isPlainRecord(42)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
  });

  it('readStoredOverride reads top-level and nested rag keys', () => {
    const overrides = { command_timeout: 60, rag: { chunk_size: 4000 } };
    expect(readStoredOverride(overrides, 'command_timeout')).toBe(60);
    expect(readStoredOverride(overrides, 'rag.chunk_size')).toBe(4000);
    expect(readStoredOverride(overrides, 'rag.top_k')).toBeUndefined();
    expect(readStoredOverride(overrides, 'missing')).toBeUndefined();
  });

  it('readStoredOverride returns undefined for rag keys when rag is not a record', () => {
    expect(readStoredOverride({ rag: [1] }, 'rag.chunk_size')).toBeUndefined();
    expect(readStoredOverride({ rag: 'bad' }, 'rag.chunk_size')).toBeUndefined();
  });

  it('readTierOverrides preserves explicit-null tier masks and drops invalid entries', () => {
    const overrides = readTierOverrides({
      tier_models: {
        seed: null,
        sprout: { connectionId: 'conn-a', modelId: 'model-b' },
        bloom: 'not-a-selection',
      },
    });
    expect(overrides.tierModels).toEqual({
      seed: null,
      sprout: { connectionId: 'conn-a', modelId: 'model-b' },
    });
  });

  it('readGlobalValue reads top-level and nested rag values from config', () => {
    expect(readGlobalValue(MOCK_CONFIG, 'command_timeout')).toBe(30);
    expect(readGlobalValue(MOCK_CONFIG, 'rag.chunk_size')).toBe(2000);
    expect(readGlobalValue(null, 'command_timeout')).toBeUndefined();
  });

  it('toInputValue converts values for input elements', () => {
    expect(toInputValue(null)).toBe('');
    expect(toInputValue(undefined)).toBe('');
    expect(toInputValue(42)).toBe(42);
    expect(toInputValue('hello')).toBe('hello');
    expect(toInputValue(['.git', 'dist'])).toBe('.git, dist');
    expect(toInputValue(true)).toBe('true');
  });

  it('fieldInputId sanitizes keys into valid DOM ids', () => {
    expect(fieldInputId('command_timeout')).toBe('project-config-command-timeout');
    expect(fieldInputId('rag.chunk_size')).toBe('project-config-rag-chunk-size');
  });
});
