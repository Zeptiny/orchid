// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsTab } from '../../src/renderer/components/Preferences/PermissionsTab';
import type { Config, MCPServerStatus } from '../../src/shared/types/ipc-boundary';

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
    mcp_servers: { context7: { command: 'npx' } },
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

function connectedStatus(tools: string[]): MCPServerStatus[] {
  return [
    { name: 'context7', status: 'connected', toolCount: tools.length, tools, error: null },
  ];
}

describe('PermissionsTab live MCP discovery', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as { orchid?: unknown }).orchid;
  });

  function setupOrchid(initialStatus: MCPServerStatus[]) {
    const status = vi.fn(async () => initialStatus);
    let workspaceListener: (() => void) | null = null;
    let trustListener: (() => void) | null = null;
    const onWorkspaceChanged = vi.fn((callback: () => void) => {
      workspaceListener = callback;
      return () => {
        workspaceListener = null;
      };
    });
    const onTrustChanged = vi.fn((callback: () => void) => {
      trustListener = callback;
      return () => {
        trustListener = null;
      };
    });
    window.orchid = {
      mcp: { status },
      session: { onWorkspaceChanged },
      projectTrust: { onChanged: onTrustChanged },
    } as never;
    return {
      status,
      onWorkspaceChanged,
      onTrustChanged,
      emitWorkspaceChanged: () => workspaceListener?.(),
      emitTrustChanged: () => trustListener?.(),
    };
  }

  it('fetches status on mount and renders live tool rows', async () => {
    const orchid = setupOrchid(connectedStatus(['query-docs']));
    render(<PermissionsTab config={makeConfig()} updateDraft={() => {}} />);

    await waitFor(() => expect(orchid.status).toHaveBeenCalledOnce());
    await screen.findByText('query-docs');
    expect(orchid.onWorkspaceChanged).toHaveBeenCalledOnce();
    expect(orchid.onTrustChanged).toHaveBeenCalledOnce();
  });

  it('refetches when the bound workspace changes', async () => {
    const orchid = setupOrchid([]);
    render(<PermissionsTab config={makeConfig()} updateDraft={() => {}} />);
    await waitFor(() => expect(orchid.status).toHaveBeenCalledTimes(1));

    orchid.status.mockResolvedValue(connectedStatus(['query-docs']));
    act(() => orchid.emitWorkspaceChanged());

    await waitFor(() => expect(orchid.status).toHaveBeenCalledTimes(2));
    await screen.findByText('query-docs');
  });

  it('refetches when project trust changes', async () => {
    const orchid = setupOrchid([]);
    render(<PermissionsTab config={makeConfig()} updateDraft={() => {}} />);
    await waitFor(() => expect(orchid.status).toHaveBeenCalledTimes(1));

    orchid.status.mockResolvedValue(connectedStatus(['query-docs']));
    act(() => orchid.emitTrustChanged());

    await waitFor(() => expect(orchid.status).toHaveBeenCalledTimes(2));
    await screen.findByText('query-docs');
  });

  it('refetches when the configured server set changes', async () => {
    const orchid = setupOrchid(connectedStatus(['query-docs']));
    const { rerender } = render(
      <PermissionsTab config={makeConfig()} updateDraft={() => {}} />,
    );
    await waitFor(() => expect(orchid.status).toHaveBeenCalledTimes(1));

    rerender(
      <PermissionsTab
        config={makeConfig({
          mcp_servers: {
            context7: { command: 'npx' },
            filesystem: { command: 'npx' },
          },
        })}
        updateDraft={() => {}}
      />,
    );

    await waitFor(() => expect(orchid.status).toHaveBeenCalledTimes(2));
  });

  it('unsubscribes from lifecycle events on unmount', () => {
    const orchid = setupOrchid([]);
    const { unmount } = render(
      <PermissionsTab config={makeConfig()} updateDraft={() => {}} />,
    );

    unmount();
    act(() => {
      orchid.emitWorkspaceChanged();
      orchid.emitTrustChanged();
    });
    expect(orchid.status).toHaveBeenCalledTimes(1);
  });
});
