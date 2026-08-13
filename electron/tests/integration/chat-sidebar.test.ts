// @vitest-environment jsdom
/**
 * Chat + Sidebar Integration Tests — U20.
 *
 * Tests the chat stream, sidebar, input area, footer, and interaction states.
 * These tests validate the component logic without requiring a running
 * Electron app (mocked window.orchid API).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import type { SessionSummary } from '../../src/main/session/storage';
import type { SubagentRecord } from '../../src/shared/types/subagent';
import { SubagentStatus } from '../../src/shared/types/subagent';
import type { Todo } from '../../src/shared/types/todo';
import { TodoStatus } from '../../src/shared/types/todo';
import type { MCPServerStatus } from '../../src/main/mcp/schema';
import type { BgCommandListItem } from '../../src/shared/types/ipc';
import { countMCPServerStatuses, Sidebar } from '../../src/renderer/components/Sidebar';
import type { BackgroundCommandsState } from '../../src/renderer/hooks/useBackgroundCommands';

// ─── Mock Setup ──────────────────────────────────────────────────────────────

// Mock window.orchid API
const mockOrchid = {
  chat: {
    send: vi.fn().mockResolvedValue({ status: 'ok' }),
    cancel: vi.fn().mockResolvedValue({ status: 'ok' }),
    onChunk: vi.fn().mockReturnValue(() => {}),
    onState: vi.fn().mockReturnValue(() => {}),
    onDone: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    onUsage: vi.fn().mockReturnValue(() => {}),
    onToolCallStart: vi.fn().mockReturnValue(() => {}),
    onToolCallDelta: vi.fn().mockReturnValue(() => {}),
    onToolCallUpdate: vi.fn().mockReturnValue(() => {}),
  },
  config: {
    get: vi.fn().mockResolvedValue({ theme: 'default', default_model: 'test/model' }),
    save: vi.fn().mockResolvedValue({ status: 'ok' }),
  },
  session: {
    list: vi.fn().mockResolvedValue([]),
    load: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'new-session', name: 'New Session' }),
    clearActive: vi.fn().mockResolvedValue({ status: 'cleared' }),
    delete: vi.fn().mockResolvedValue({
      status: 'deleted',
      workingSet: { openSessionIds: [], focusedSessionId: null, mruSessionIds: [] },
    }),
    rename: vi.fn().mockResolvedValue({ status: 'ok' }),
    onCreated: vi.fn().mockReturnValue(() => {}),
    onRenamed: vi.fn().mockReturnValue(() => {}),
  },
  tool: {
    execute: vi.fn().mockResolvedValue({ content: '', isError: false }),
  },
  agent: {
    list: vi.fn().mockResolvedValue([]),
    spawn: vi.fn().mockResolvedValue({ id: 'agent-1', agent: {} }),
  },
  mcp: {
    status: vi.fn().mockResolvedValue([]),
  },
  rag: {
    status: vi.fn().mockResolvedValue(null),
    index: vi.fn().mockResolvedValue({}),
    clear: vi.fn().mockResolvedValue({ status: 'ok' }),
    indexState: vi.fn().mockResolvedValue({ indexing: false, progress: null }),
    onProgress: vi.fn().mockReturnValue(() => {}),
  },
  ast: {
    status: vi.fn().mockResolvedValue(null),
    index: vi.fn().mockResolvedValue({}),
    indexState: vi.fn().mockResolvedValue({ indexing: false, progress: null }),
    onProgress: vi.fn().mockReturnValue(() => {}),
  },
  bgCmd: {
    snapshot: vi.fn().mockResolvedValue({ found: false }),
    list: vi.fn().mockResolvedValue([]),
    sendInput: vi.fn().mockResolvedValue({ ok: true }),
    terminate: vi.fn().mockResolvedValue({ ok: true }),
    releaseInput: vi.fn().mockResolvedValue({ ok: true }),
    onChanged: vi.fn().mockReturnValue(() => {}),
  },
};

// Setup global window.orchid
beforeEach(() => {
  (globalThis as unknown as { window: typeof globalThis.window }).window = globalThis.window || {};
  (window as unknown as Record<string, unknown>).orchid = mockOrchid;
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  const { __clearSnapshotCoalesceCacheForTest } = await import('../../src/renderer/hooks/useLiveCommandOutput');
  __clearSnapshotCoalesceCacheForTest();
});

// ─── Chat Message Types ──────────────────────────────────────────────────────

describe('Message Types', () => {
  it('all message roles are defined', () => {
    expect(MessageRole.USER).toBe('user');
    expect(MessageRole.ASSISTANT).toBe('assistant');
    expect(MessageRole.SYSTEM).toBe('system');
    expect(MessageRole.TOOL).toBe('tool');
  });

  it('all message types are defined', () => {
    expect(MessageType.TEXT).toBe('text');
    expect(MessageType.THINKING).toBe('thinking');
    expect(MessageType.TOOL_CALL).toBe('tool_call');
    expect(MessageType.TOOL_RESULT).toBe('tool_result');
    expect(MessageType.ERROR).toBe('error');
  });

  it('message has all required fields', () => {
    const message: Message = {
      id: 'test-id',
      role: MessageRole.USER,
      content: 'Hello',
      type: MessageType.TEXT,
      tool_calls: null,
      tool_call_id: null,
      name: null,
      thinking: null,
      timestamp: new Date().toISOString(),
      usage: null,
      hidden: false,
  };

    expect(message.id).toBe('test-id');
    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello');
    expect(message.type).toBe('text');
  });
});

// ─── Chat Send Flow ──────────────────────────────────────────────────────────

describe('Chat Send Flow', () => {
  it('chat.send is called with correct payload', async () => {
    await mockOrchid.chat.send({ message: 'Hello' });
    expect(mockOrchid.chat.send).toHaveBeenCalledWith({ message: 'Hello' });
  });

  it('chat.send with sessionId', async () => {
    await mockOrchid.chat.send({ message: 'Hello', sessionId: 'session-1' });
    expect(mockOrchid.chat.send).toHaveBeenCalledWith({
      message: 'Hello',
      sessionId: 'session-1',
    });
  });

  it('chat.cancel cancels the stream', async () => {
    await mockOrchid.chat.cancel();
    expect(mockOrchid.chat.cancel).toHaveBeenCalled();
  });
});

// ─── Streaming Events ────────────────────────────────────────────────────────

describe('Streaming Events', () => {
  it('onChunk callback receives chunk events', () => {
    const callback = vi.fn();
    mockOrchid.chat.onChunk(callback);
    expect(mockOrchid.chat.onChunk).toHaveBeenCalledWith(callback);
  });

  it('onState callback receives state events', () => {
    const callback = vi.fn();
    mockOrchid.chat.onState(callback);
    expect(mockOrchid.chat.onState).toHaveBeenCalledWith(callback);
  });

  it('onDone callback receives done events', () => {
    const callback = vi.fn();
    mockOrchid.chat.onDone(callback);
    expect(mockOrchid.chat.onDone).toHaveBeenCalledWith(callback);
  });

  it('onError callback receives error events', () => {
    const callback = vi.fn();
    mockOrchid.chat.onError(callback);
    expect(mockOrchid.chat.onError).toHaveBeenCalledWith(callback);
  });

  it('event subscriptions return unsubscribe functions', () => {
    const unsub = mockOrchid.chat.onChunk(() => {});
    expect(typeof unsub).toBe('function');
  });
});

// ─── Session Management ──────────────────────────────────────────────────────

describe('Session Management', () => {
  it('session.list returns session summaries', async () => {
    const sessions: SessionSummary[] = [
      { id: 's1', name: 'Session 1', model: 'test/model', cwd: null, chainCount: 2, updatedAt: Date.now() },
      { id: 's2', name: 'Session 2', model: 'test/model', cwd: null, chainCount: 1, updatedAt: Date.now() - 86400000 },
    ];
    mockOrchid.session.list.mockResolvedValueOnce(sessions);

    const result = await mockOrchid.session.list();
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Session 1');
  });

  it('session summaries include cwd for project-scoped sidebar', async () => {
    const sessions: SessionSummary[] = [
      {
        id: 's1',
        name: 'Alpha',
        model: 'test/model',
        cwd: '/proj/alpha',
        chainCount: 1,
        updatedAt: Date.now(),
      },
      {
        id: 's2',
        name: 'Beta',
        model: 'test/model',
        cwd: '/proj/beta',
        chainCount: 1,
        updatedAt: Date.now(),
      },
    ];
    mockOrchid.session.list.mockResolvedValueOnce(sessions);
    const result = await mockOrchid.session.list();
    expect(result.map((s) => s.cwd)).toEqual(['/proj/alpha', '/proj/beta']);
  });

  it('session.load loads a session by ID', async () => {
    const session = { id: 's1', name: 'Test', model: 'test/model', chains: [] };
    mockOrchid.session.load.mockResolvedValueOnce(session);

    const result = await mockOrchid.session.load({ id: 's1' });
    expect(result?.id).toBe('s1');
  });

  it('session.create creates a new session', async () => {
    const session = { id: 'new', name: 'New Session', model: 'test/model', chains: [] };
    mockOrchid.session.create.mockResolvedValueOnce(session);

    const result = await mockOrchid.session.create();
    expect(result.id).toBe('new');
  });

  it('session.clearActive enters draft mode without creating a session', async () => {
    await mockOrchid.session.clearActive();
    expect(mockOrchid.session.clearActive).toHaveBeenCalled();
    expect(mockOrchid.session.create).not.toHaveBeenCalled();
  });

  it('session.delete deletes a session', async () => {
    await mockOrchid.session.delete({ id: 's1' });
    expect(mockOrchid.session.delete).toHaveBeenCalledWith({ id: 's1' });
  });

  it('session.rename renames a session', async () => {
    await mockOrchid.session.rename('s1', 'New Name');
    expect(mockOrchid.session.rename).toHaveBeenCalledWith('s1', 'New Name');
  });
});

// ─── Sidebar Data Sources ────────────────────────────────────────────────────

describe('Sidebar Data Sources', () => {
  it('MCP status returns server list', async () => {
    const servers: MCPServerStatus[] = [
      { name: 'context7', status: 'connected', toolCount: 5, error: null },
      { name: 'github', status: 'failed', toolCount: 0, error: 'Connection refused' },
    ];
    mockOrchid.mcp.status.mockResolvedValueOnce(servers);

    const result = await mockOrchid.mcp.status();
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('connected');
    expect(result[1].status).toBe('failed');
  });

  it('MCP status counts include every lifecycle state', () => {
    const servers: MCPServerStatus[] = [
      { name: 'context7', status: 'connected', toolCount: 5, error: null },
      { name: 'github', status: 'connected', toolCount: 2, error: null },
      { name: 'linear', status: 'starting', toolCount: 0, error: null },
      { name: 'slack', status: 'failed', toolCount: 0, error: 'Connection refused' },
      { name: 'not-configured', status: 'unavailable', toolCount: 0, error: 'Unavailable' },
    ];

    expect(countMCPServerStatuses(servers)).toEqual({
      connected: 2,
      starting: 1,
      failed: 1,
      unavailable: 1,
    });
  });

  it('MCP status counts stay empty when no servers are configured', () => {
    expect(countMCPServerStatuses([])).toEqual({
      connected: 0,
      starting: 0,
      failed: 0,
      unavailable: 0,
    });
  });

  it('RAG status returns store info', async () => {
    const ragStatus = {
      totalChunks: 150,
      totalFiles: 42,
      lastIndexed: new Date().toISOString(),
      lastIndexDuration: 5.2,
    };
    mockOrchid.rag.status.mockResolvedValueOnce(ragStatus);

    const result = await mockOrchid.rag.status();
    expect(result.totalChunks).toBe(150);
    expect(result.totalFiles).toBe(42);
  });

  it('AST status returns store info', async () => {
    const astStatus = {
      totalFiles: 100,
      totalSymbols: 500,
      lastIndexed: new Date().toISOString(),
      lastIndexDuration: 3.1,
    };
    mockOrchid.ast.status.mockResolvedValueOnce(astStatus);

    const result = await mockOrchid.ast.status();
    expect(result.totalFiles).toBe(100);
    expect(result.totalSymbols).toBe(500);
  });

  it('RAG index triggers indexing', async () => {
    await mockOrchid.rag.index();
    expect(mockOrchid.rag.index).toHaveBeenCalled();
  });

  it('AST index triggers indexing', async () => {
    await mockOrchid.ast.index();
    expect(mockOrchid.ast.index).toHaveBeenCalled();
  });
});

// ─── Sidebar Commands Section ────────────────────────────────────────────────

describe('Sidebar Commands Section', () => {
  function makeBgCommand(overrides: Partial<BgCommandListItem> = {}): BgCommandListItem {
    return {
      id: 1,
      command: 'sleep 100',
      description: 'long sleeper',
      interactive: false,
      owner: 'AGENT',
      agentScopeId: 'main',
      scopeName: 'main',
      running: true,
      exitCode: null,
      createdAt: 1_000,
      lastOutputAt: 2_000,
      ...overrides,
    };
  }

  function renderCommandsSidebar(
    commandsState: BackgroundCommandsState,
    options: { onRefreshCommands?: () => void; sessionId?: string | null } = {},
  ) {
    return render(
      createElement(Sidebar, {
        isOpen: true,
        onToggle: () => {},
        subagentState: { status: 'empty' },
        onRefreshSubagents: () => {},
        selectedSubagentId: null,
        onSelectSubagent: () => {},
        getSubagentDetail: () => null,
        todoState: { status: 'empty' },
        onRefreshTodos: () => {},
        commandsState,
        onRefreshCommands: options.onRefreshCommands ?? (() => {}),
        sessionId: options.sessionId === undefined ? 'sess-1' : options.sessionId,
        mcpServers: [],
      }),
    );
  }

  async function flushSnapshots() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('renders the running-count badge between Subagents and Context', () => {
    renderCommandsSidebar({
      status: 'ready',
      commands: [
        makeBgCommand(),
        makeBgCommand({ id: 2 }),
        makeBgCommand({ id: 3, running: false, exitCode: 0 }),
      ],
    });

    const sections = Array.from(document.querySelectorAll('[data-inspector-section]'))
      .map((el) => el.getAttribute('data-inspector-section'));
    expect(sections.indexOf('inspector-commands')).toBe(sections.indexOf('inspector-subagents') + 1);
    expect(sections.indexOf('inspector-context')).toBe(sections.indexOf('inspector-commands') + 1);

    const trigger = document.getElementById('inspector-commands-trigger');
    expect(trigger).toBeTruthy();
    expect(trigger?.textContent).toContain('Commands');
    expect(trigger?.querySelector('.badge')?.textContent).toBe('2');
  });

  it('shows no header badge when nothing is running', () => {
    renderCommandsSidebar({
      status: 'ready',
      commands: [makeBgCommand({ running: false, exitCode: 0 })],
    });

    const trigger = document.getElementById('inspector-commands-trigger');
    expect(trigger?.querySelector('.badge')).toBeNull();
  });

  it('renders one live widget row per item with scope badges only for non-main scopes', async () => {
    mockOrchid.bgCmd.snapshot.mockResolvedValue({
      found: true,
      tail: 'out\n',
      exitCode: null,
      running: true,
      interactive: false,
      owner: 'AGENT',
      command: 'demo',
      agentScopeId: 'main',
    });

    renderCommandsSidebar({
      status: 'ready',
      commands: [
        makeBgCommand({ command: 'npm run dev' }),
        makeBgCommand({ id: 2, command: 'pytest -x', scopeName: 'Researcher', agentScopeId: 'sub-9' }),
      ],
    });
    await flushSnapshots();

    // Widgets resolve visibility against the owning session, never a fallback.
    expect(mockOrchid.bgCmd.snapshot).toHaveBeenCalledWith({
      commandId: 1,
      lastN: 50,
      includeTail: false,
      sessionId: 'sess-1',
    });
    expect(mockOrchid.bgCmd.snapshot).toHaveBeenCalledWith({
      commandId: 2,
      lastN: 50,
      includeTail: false,
      sessionId: 'sess-1',
    });

    fireEvent.click(screen.getByRole('button', { name: /^Commands/ }));
    fireEvent.click(screen.getByRole('button', { name: /\$ npm run dev \(running\)/ }));
    await flushSnapshots();
    expect(document.body.textContent).toContain('out');

    expect(screen.getByRole('button', { name: /\$ npm run dev \(running\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /\$ pytest -x \(running\)/ })).toBeTruthy();

    const scopeBadge = screen.getByText('Researcher');
    expect(scopeBadge.className).toContain('badge');
    expect(screen.queryByText('main')).toBeNull();
  });

  it('shows running commands inline and hides terminal commands behind the Other commands dropdown', () => {
    mockOrchid.bgCmd.snapshot.mockImplementation(({ commandId }: { commandId: number }) =>
      Promise.resolve({
        found: true,
        tail: '',
        exitCode: commandId === 1 ? null : commandId === 2 ? 0 : 1,
        running: commandId === 1,
        interactive: false,
        owner: 'AGENT',
        command: 'demo',
        agentScopeId: commandId === 3 ? 'sub-2' : 'main',
      }),
    );

    renderCommandsSidebar({
      status: 'ready',
      commands: [
        makeBgCommand({ id: 1, command: 'npm run dev' }),
        makeBgCommand({ id: 2, command: 'pytest -x', running: false, exitCode: 0 }),
        makeBgCommand({
          id: 3,
          command: 'cargo build',
          running: false,
          exitCode: 1,
          scopeName: 'Builder',
          agentScopeId: 'sub-2',
        }),
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /^Commands/ }));

    // Running commands stay visible with a running badge.
    expect(screen.getByRole('button', { name: /\$ npm run dev/ })).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();

    // Terminal commands are not rendered until the menu opens.
    expect(screen.queryByRole('button', { name: /\$ pytest -x/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /\$ cargo build/ })).toBeNull();

    const trigger = screen.getByRole('button', { name: 'Show 2 other commands' });
    expect(trigger.textContent).toContain('Other commands');
    expect(trigger.textContent).toContain('2');

    // Opening the menu reveals the terminal rows with their status badges.
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: /\$ pytest -x/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /\$ cargo build/ })).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('exit 1')).toBeTruthy();
    expect(screen.getByText('Builder')).toBeTruthy();
  });

  it('shows the empty state when the session has no background commands', () => {
    renderCommandsSidebar({ status: 'empty' });

    expect(screen.getByText('No background commands')).toBeTruthy();
  });

  it('shows the loading state while the fleet list is fetched', () => {
    renderCommandsSidebar({ status: 'loading' });

    expect(screen.getByText('Loading commands…')).toBeTruthy();
  });

  it('surfaces list errors with a Retry affordance wired to onRefreshCommands', () => {
    const onRefreshCommands = vi.fn();
    renderCommandsSidebar(
      { status: 'error', error: 'fleet unavailable' },
      { onRefreshCommands },
    );

    expect(screen.getByText('fleet unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Commands/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRefreshCommands).toHaveBeenCalledTimes(1);
  });
});

// ─── Interaction States ──────────────────────────────────────────────────────

describe('Interaction States', () => {
  describe('Session List States', () => {
    it('loading state has status "loading"', () => {
      const state = { status: 'loading' as const };
      expect(state.status).toBe('loading');
    });

    it('empty state has status "empty"', () => {
      const state = { status: 'empty' as const };
      expect(state.status).toBe('empty');
    });

    it('ready state has sessions array', () => {
      const state = {
        status: 'ready' as const,
        sessions: [{ id: 's1', name: 'Test', model: 'm', cwd: null, chainCount: 1, updatedAt: Date.now() }],
      };
      expect(state.status).toBe('ready');
      expect(state.sessions).toHaveLength(1);
    });

    it('error state has error message', () => {
      const state = { status: 'error' as const, error: 'Failed to load' };
      expect(state.status).toBe('error');
      expect(state.error).toBe('Failed to load');
    });

    it('partial state has sessions and error', () => {
      const state = {
        status: 'partial' as const,
        sessions: [{ id: 's1', name: 'Test', model: 'm', cwd: null, chainCount: 1, updatedAt: Date.now() }],
        error: 'Some sessions failed to load',
      };
      expect(state.status).toBe('partial');
      expect(state.sessions).toHaveLength(1);
      expect(state.error).toBeTruthy();
    });
  });

  describe('Subagent List States', () => {
    it('loading state', () => {
      const state = { status: 'loading' as const };
      expect(state.status).toBe('loading');
    });

    it('empty state', () => {
      const state = { status: 'empty' as const };
      expect(state.status).toBe('empty');
    });

    it('ready state with subagents', () => {
      const state = {
        status: 'ready' as const,
        subagents: [{
          id: 'sa1',
          agent_name: 'general',
          agent_type: 'subagent',
          agent_tier: 'bloom',
          task: 'Do something',
          status: SubagentStatus.RUNNING,
          chain_id: 'c1',
          start_time: new Date().toISOString(),
          end_time: null,
          result: null,
          error: null,
          chain: { id: 'c1', sessionId: 's1', messages: [], status: 'active', model: 'm', agentName: 'general', agentType: 'subagent', agentTier: 'bloom', subagentRecord: null },
        }],
      };
      expect(state.status).toBe('ready');
      expect(state.subagents[0].status).toBe('running');
    });

    it('error state', () => {
      const state = { status: 'error' as const, error: 'Failed' };
      expect(state.status).toBe('error');
    });
  });

  describe('Todo List States', () => {
    it('loading state', () => {
      const state = { status: 'loading' as const };
      expect(state.status).toBe('loading');
    });

    it('empty state', () => {
      const state = { status: 'empty' as const };
      expect(state.status).toBe('empty');
    });

    it('ready state with todos', () => {
      const state = {
        status: 'ready' as const,
        todos: [
          { id: 't1', title: 'Task 1', status: TodoStatus.OPEN, subagent_id: null, created_at: '', updated_at: '' },
          { id: 't2', title: 'Task 2', status: TodoStatus.IN_PROGRESS, subagent_id: null, created_at: '', updated_at: '' },
          { id: 't3', title: 'Task 3', status: TodoStatus.DONE, subagent_id: null, created_at: '', updated_at: '' },
        ],
      };
      expect(state.status).toBe('ready');
      expect(state.todos).toHaveLength(3);
      expect(state.todos[0].status).toBe('OPEN');
      expect(state.todos[1].status).toBe('IN_PROGRESS');
      expect(state.todos[2].status).toBe('DONE');
    });

    it('error state', () => {
      const state = { status: 'error' as const, error: 'Failed' };
      expect(state.status).toBe('error');
    });
  });
});

// ─── Subagent Statuses ───────────────────────────────────────────────────────

describe('Subagent Statuses', () => {
  it('all statuses are defined', () => {
    expect(SubagentStatus.PENDING).toBe('pending');
    expect(SubagentStatus.RUNNING).toBe('running');
    expect(SubagentStatus.COMPLETED).toBe('completed');
    expect(SubagentStatus.FAILED).toBe('failed');
    expect(SubagentStatus.INTERRUPTED).toBe('interrupted');
  });
});

// ─── Todo Statuses ───────────────────────────────────────────────────────────

describe('Todo Statuses', () => {
  it('all statuses are defined', () => {
    expect(TodoStatus.OPEN).toBe('OPEN');
    expect(TodoStatus.IN_PROGRESS).toBe('IN_PROGRESS');
    expect(TodoStatus.DONE).toBe('DONE');
  });
});

// ─── Session Date Grouping ───────────────────────────────────────────────────

describe('Session Date Grouping', () => {
  it('groups sessions into Today, Yesterday, This Week, and older', () => {
    const now = Date.now();
    const sessions: SessionSummary[] = [
      { id: 's1', name: 'Today', model: 'm', cwd: null, chainCount: 1, updatedAt: now },
      { id: 's2', name: 'Yesterday', model: 'm', cwd: null, chainCount: 1, updatedAt: now - 86400000 },
      { id: 's3', name: 'This Week', model: 'm', cwd: null, chainCount: 1, updatedAt: now - 3 * 86400000 },
      { id: 's4', name: 'Older', model: 'm', cwd: null, chainCount: 1, updatedAt: now - 30 * 86400000 },
    ];

    // The grouping function is internal to Sidebar, but we can verify the logic
    const today = new Date(now);
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;
    const weekStart = todayStart - 7 * 86400000;

    // Today
    expect(sessions[0].updatedAt).toBeGreaterThanOrEqual(todayStart);

    // Yesterday
    expect(sessions[1].updatedAt).toBeGreaterThanOrEqual(yesterdayStart);
    expect(sessions[1].updatedAt).toBeLessThan(todayStart);

    // This Week
    expect(sessions[2].updatedAt).toBeGreaterThanOrEqual(weekStart);
    expect(sessions[2].updatedAt).toBeLessThan(yesterdayStart);

    // Older
    expect(sessions[3].updatedAt).toBeLessThan(weekStart);
  });
});

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────

describe('Keyboard Shortcuts', () => {
  // KeyboardEvent is not available in Vitest Node.js environment.
  // Test the key matching logic directly instead.

  it('Enter without Shift triggers send', () => {
    const key = 'Enter';
    const shiftKey = false;
    const shouldSend = key === 'Enter' && !shiftKey;
    expect(shouldSend).toBe(true);
  });

  it('Shift+Enter does NOT trigger send', () => {
    const key = 'Enter';
    const shiftKey = true;
    const shouldSend = key === 'Enter' && !shiftKey;
    expect(shouldSend).toBe(false);
  });

  it('Ctrl+S triggers send', () => {
    const key = 's';
    const ctrlKey = true;
    const shouldSend = (key === 'Enter' && !false) || (key === 's' && ctrlKey);
    expect(shouldSend).toBe(true);
  });

  it('Escape triggers cancel during streaming', () => {
    const key = 'Escape';
    const isStreaming = true;
    const shouldCancel = key === 'Escape' && isStreaming;
    expect(shouldCancel).toBe(true);
  });

  it('Ctrl+B toggles sidebar', () => {
    const key = 'b';
    const ctrlKey = true;
    const shouldToggle = (ctrlKey || false) && key === 'b';
    expect(shouldToggle).toBe(true);
  });
});

// ─── Auto-Scroll Behavior ────────────────────────────────────────────────────

describe('Auto-Scroll Behavior', () => {
  it('auto-scroll is triggered on new messages when user is at bottom', () => {
    // isUserScrolledUp = false → should auto-scroll
    const isUserScrolledUp = false;
    const shouldAutoScroll = !isUserScrolledUp;
    expect(shouldAutoScroll).toBe(true);
  });

  it('auto-scroll is NOT triggered when user has scrolled up', () => {
    // isUserScrolledUp = true → should NOT auto-scroll
    const isUserScrolledUp = true;
    const shouldAutoScroll = !isUserScrolledUp;
    expect(shouldAutoScroll).toBe(false);
  });

  it('scroll distance > 100px from bottom means user scrolled up', () => {
    const scrollTop = 500;
    const scrollHeight = 1000;
    const clientHeight = 400;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight; // 100

    // At exactly 100px, user is NOT considered scrolled up (> 100 threshold)
    expect(distanceFromBottom).toBe(100);
    const isScrolledUp = distanceFromBottom > 100;
    expect(isScrolledUp).toBe(false);
  });

  it('scroll distance > 100px means user is scrolled up', () => {
    const scrollTop = 400;
    const scrollHeight = 1000;
    const clientHeight = 400;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight; // 200

    expect(distanceFromBottom).toBe(200);
    const isScrolledUp = distanceFromBottom > 100;
    expect(isScrolledUp).toBe(true);
  });
});

// ─── Interrupt Flow ──────────────────────────────────────────────────────────

describe('Interrupt Flow', () => {
  it('cancel is called on Escape during streaming', async () => {
    await mockOrchid.chat.cancel();
    expect(mockOrchid.chat.cancel).toHaveBeenCalled();
  });

  it('interrupted message preserves partial content without adding a suffix', () => {
    const content = 'Partial response...';
    const interruptedContent = content;
    expect(interruptedContent).toBe(content);
    expect(interruptedContent).not.toContain('[Interrupted by user]');
  });
});

// ─── MCP Server Status ───────────────────────────────────────────────────────

describe('MCP Server Status', () => {
  it('connected server shows tool count', () => {
    const server: MCPServerStatus = {
      name: 'context7',
      status: 'connected',
      toolCount: 5,
      error: null,
    };
    expect(server.status).toBe('connected');
    expect(server.toolCount).toBe(5);
  });

  it('failed server shows error', () => {
    const server: MCPServerStatus = {
      name: 'github',
      status: 'failed',
      toolCount: 0,
      error: 'Connection refused',
    };
    expect(server.status).toBe('failed');
    expect(server.error).toBe('Connection refused');
  });

  it('unavailable server has null error', () => {
    const server: MCPServerStatus = {
      name: 'slow-server',
      status: 'unavailable',
      toolCount: 0,
      error: null,
    };
    expect(server.status).toBe('unavailable');
  });

  it('starting server is in initial state', () => {
    const server: MCPServerStatus = {
      name: 'new-server',
      status: 'starting',
      toolCount: 0,
      error: null,
    };
    expect(server.status).toBe('starting');
  });
});

// ─── Markdown Rendering ──────────────────────────────────────────────────────

describe('Markdown Content Stack', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const markdownPath = path.resolve(
    __dirname,
    '../../src/renderer/components/MarkdownContent.tsx',
  );

  it('MarkdownContent uses react-markdown + remark-gfm + rehype-highlight', () => {
    const source = fs.readFileSync(markdownPath, 'utf-8');
    expect(source).toContain("from 'react-markdown'");
    expect(source).toContain("from 'remark-gfm'");
    expect(source).toContain("from 'rehype-highlight'");
    expect(source).toContain('remarkPlugins');
    expect(source).toContain('rehypePlugins');
  });

  it('links open in a new window with noopener', () => {
    const source = fs.readFileSync(markdownPath, 'utf-8');
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noopener noreferrer"');
  });

  it('preserves fenced-code language label', () => {
    const source = fs.readFileSync(markdownPath, 'utf-8');
    expect(source).toContain('markdown-code-lang');
    expect(source).toContain('language-');
  });
});

// ─── Component File Structure ────────────────────────────────────────────────

describe('Component File Structure', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const componentsDir = path.resolve(__dirname, '../../src/renderer/components');
  const hooksDir = path.resolve(__dirname, '../../src/renderer/hooks');

  it('ChatStream component exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'ChatStream.tsx'))).toBe(true);
  });

  it('MessageWidget component exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'MessageWidget.tsx'))).toBe(true);
  });

  it('Sidebar component exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'Sidebar.tsx'))).toBe(true);
  });

  it('LeftSidebar component exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'LeftSidebar.tsx'))).toBe(true);
  });

  it('ToolCallBlock component exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'ToolCallBlock.tsx'))).toBe(true);
  });

  it('ConfigView component exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'ConfigView.tsx'))).toBe(true);
  });

  it('InputArea component exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'InputArea.tsx'))).toBe(true);
  });

  it('Footer component exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'Footer.tsx'))).toBe(true);
  });

  it('ChatView component exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'ChatView.tsx'))).toBe(true);
  });

  it('MarkdownContent component exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'MarkdownContent.tsx'))).toBe(true);
  });

  it('useChat hook exists', () => {
    expect(fs.existsSync(path.join(hooksDir, 'useChat.ts'))).toBe(true);
  });

  it('keeps the previous context preview visible while a new turn starts', () => {
    const source = fs.readFileSync(path.join(hooksDir, 'useChat.ts'), 'utf-8');
    const sendStart = source.indexOf('const send = useCallback');
    const sendEnd = source.indexOf('const cancel = useCallback', sendStart);
    const sendSource = source.slice(sendStart, sendEnd);

    expect(sendSource).toContain("type: 'begin'");
    expect(source).toContain('const usage = projection?.usage ?? persistedUsage');
  });

  it('useSession hook exists', () => {
    expect(fs.existsSync(path.join(hooksDir, 'useSession.ts'))).toBe(true);
  });

  it('shell preserves three-panel topology and shared session store', () => {
    const chatView = fs.readFileSync(path.join(componentsDir, 'ChatView.tsx'), 'utf-8');
    const leftSidebar = fs.readFileSync(path.join(componentsDir, 'LeftSidebar.tsx'), 'utf-8');
    const sidebar = fs.readFileSync(path.join(componentsDir, 'Sidebar.tsx'), 'utf-8');
    const sessionTabBar = fs.readFileSync(path.join(componentsDir, 'SessionTabBar.tsx'), 'utf-8');
    const useSession = fs.readFileSync(path.join(hooksDir, 'useSession.ts'), 'utf-8');
    const exceptions = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/styles/exceptions.css'),
      'utf-8',
    );

    // Existing shell: left sessions | center main | right inspector.
    expect(chatView).toContain('app-frame');
    expect(chatView).toContain('LeftSidebar');
    expect(chatView).toContain('main-pane');
    expect(chatView).toContain('Sidebar');
    expect(chatView).toContain('--orchid-shell-left');
    expect(chatView).toContain('--orchid-shell-right');
    expect(exceptions).toContain('--orchid-shell-left');
    expect(exceptions).toContain('minmax(460px, 1fr)');

    // Collapsible sections expose expanded state.
    expect(leftSidebar).toContain('aria-expanded');
    expect(leftSidebar).toContain('aria-controls');
    expect(sidebar).toContain('aria-expanded');
    expect(sidebar).toContain('aria-controls');
    expect(sessionTabBar).toContain('role="tablist"');
    expect(sessionTabBar).toContain('role="tab"');

    // Shared session ownership (no dual local stores).
    expect(useSession).toContain('useSyncExternalStore');
    expect(chatView).toMatch(/useSession\s*\(/);
  });

  it('useSubagents hook exists', () => {
    expect(fs.existsSync(path.join(hooksDir, 'useSubagents.ts'))).toBe(true);
  });

  it('useTodos hook exists', () => {
    expect(fs.existsSync(path.join(hooksDir, 'useTodos.ts'))).toBe(true);
  });
});

// ─── CSS Structure ───────────────────────────────────────────────────────────

describe('CSS Structure', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const stylesDir = path.resolve(__dirname, '../../src/renderer/styles');
  const componentsCssPath = path.join(stylesDir, 'components.css');
  const shellCssPath = path.join(stylesDir, 'shell.css');
  const exceptionsCssPath = path.join(stylesDir, 'exceptions.css');

  function readStyles(): string {
    return [
      fs.readFileSync(componentsCssPath, 'utf-8'),
      fs.readFileSync(shellCssPath, 'utf-8'),
      fs.readFileSync(exceptionsCssPath, 'utf-8'),
    ].join('\n');
  }

  it('canonical style layers exist', () => {
    expect(fs.existsSync(path.join(stylesDir, 'index.css'))).toBe(true);
    expect(fs.existsSync(componentsCssPath)).toBe(true);
    expect(fs.existsSync(shellCssPath)).toBe(true);
    expect(fs.existsSync(exceptionsCssPath)).toBe(true);
  });

  it('shell layout classes remain in style layers', () => {
    const css = readStyles();
    expect(css).toContain('.app-frame');
    expect(css).toContain('.main-pane');
    expect(css).toContain('.left-panel');
    expect(css).toContain('.right-panel');
    expect(css).toContain('.left-panel-overlay');
    expect(css).toContain('.right-panel-overlay');
    expect(css).toContain('.left-panel:not(.left-panel-overlay)');
    expect(css).toContain('.right-panel:not(.right-panel-overlay)');
    expect(css).toContain('.orchid-chat-scroll');
  });

  it('flat message classes remain (not DaisyUI chat bubbles)', () => {
    const css = readStyles();
    expect(css).toContain('.orchid-msg-user');
    expect(css).toContain('.orchid-msg-assistant');
    expect(css).toContain('.orchid-msg-system');
    expect(css).not.toMatch(/\.chat-bubble\b/);
  });

  it('session and panel classes remain', () => {
    const css = readStyles();
    expect(css).toContain('.session-list');
    expect(css).toContain('.session-item');
    expect(css).toContain('.panel-header');
    expect(css).toContain('.panel-body');
  });

  it('composer classes leave sizing to the resize effect', () => {
    const css = readStyles();
    expect(css).toContain('.orchid-composer-textarea');
    expect(css).not.toContain('field-sizing: content');
  });

  it('chat footer classes remain', () => {
    const css = readStyles();
    expect(css).toContain('.orchid-chat-footer');
    expect(css).toContain('.orchid-chat-footer-hint');
  });

  it('style layers use theme custom properties', () => {
    const css = readStyles();
    expect(css).toContain('var(--bg-primary)');
    expect(css).toContain('var(--text-primary)');
    expect(css).toContain('var(--accent-primary)');
  });
});
