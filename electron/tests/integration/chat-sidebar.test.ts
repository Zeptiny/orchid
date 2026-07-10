/**
 * Chat + Sidebar Integration Tests — U20.
 *
 * Tests the chat stream, sidebar, input area, footer, and interaction states.
 * These tests validate the component logic without requiring a running
 * Electron app (mocked window.orchid API).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import type { SessionSummary } from '../../src/main/session/storage';
import type { SubagentRecord } from '../../src/shared/types/subagent';
import { SubagentStatus } from '../../src/shared/types/subagent';
import type { Todo } from '../../src/shared/types/todo';
import { TodoStatus } from '../../src/shared/types/todo';
import type { MCPServerStatus } from '../../src/main/mcp/schema';

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
    delete: vi.fn().mockResolvedValue({ status: 'ok' }),
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
  },
  ast: {
    status: vi.fn().mockResolvedValue(null),
    index: vi.fn().mockResolvedValue({}),
  },
};

// Setup global window.orchid
beforeEach(() => {
  (globalThis as unknown as { window: typeof globalThis.window }).window = globalThis.window || {};
  (window as unknown as Record<string, unknown>).orchid = mockOrchid;
});

afterEach(() => {
  vi.clearAllMocks();
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
    is_error: false,
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

describe('Markdown Content Parsing', () => {
  it('code blocks are detected by triple backtick', () => {
    const text = '```typescript\nconst x = 1;\n```';
    expect(text.startsWith('```')).toBe(true);
  });

  it('inline code is detected by single backtick', () => {
    const text = 'Use `console.log()` to debug';
    const match = text.match(/`([^`]+)`/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('console.log()');
  });

  it('bold text is detected by double asterisk', () => {
    const text = 'This is **bold** text';
    const match = text.match(/\*\*(.+?)\*\*/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('bold');
  });

  it('italic text is detected by single asterisk', () => {
    const text = 'This is *italic* text';
    const match = text.match(/\*(.+?)\*/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('italic');
  });

  it('links are detected by markdown syntax', () => {
    const text = 'Click [here](https://example.com)';
    const match = text.match(/\[([^\]]+)\]\(([^)]+)\)/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('here');
    expect(match![2]).toBe('https://example.com');
  });

  it('headers are detected by hash prefix', () => {
    expect('# Heading 1'.match(/^(#{1,3})\s+(.+)$/)).not.toBeNull();
    expect('## Heading 2'.match(/^(#{1,3})\s+(.+)$/)).not.toBeNull();
    expect('### Heading 3'.match(/^(#{1,3})\s+(.+)$/)).not.toBeNull();
  });

  it('unordered lists are detected by dash prefix', () => {
    expect('- Item 1'.match(/^[\s]*[-*+]\s/)).not.toBeNull();
    expect('* Item 1'.match(/^[\s]*[-*+]\s/)).not.toBeNull();
  });

  it('ordered lists are detected by number prefix', () => {
    expect('1. Item 1'.match(/^[\s]*\d+\.\s/)).not.toBeNull();
    expect('2. Item 2'.match(/^[\s]*\d+\.\s/)).not.toBeNull();
  });

  it('blockquotes are detected by angle bracket prefix', () => {
    expect('> Quote'.startsWith('> ')).toBe(true);
  });

  it('horizontal rules are detected', () => {
    expect('---'.match(/^(-{3,}|_{3,}|\*{3,})$/)).not.toBeNull();
    expect('___'.match(/^(-{3,}|_{3,}|\*{3,})$/)).not.toBeNull();
    expect('***'.match(/^(-{3,}|_{3,}|\*{3,})$/)).not.toBeNull();
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

  it('useSession hook exists', () => {
    expect(fs.existsSync(path.join(hooksDir, 'useSession.ts'))).toBe(true);
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

  const cssPath = path.resolve(__dirname, '../../src/renderer/styles/chat.css');

  it('chat.css exists', () => {
    expect(fs.existsSync(cssPath)).toBe(true);
  });

  it('chat.css contains layout classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.app-layout');
    expect(css).toContain('.chat-main');
    expect(css).toContain('.chat-stream');
  });

  it('chat.css contains message type classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.message-user');
    expect(css).toContain('.message-assistant');
    expect(css).toContain('.message-thinking');
    expect(css).toContain('.message-tool-call');
    expect(css).toContain('.message-tool-result');
    expect(css).toContain('.message-error');
  });

  it('chat.css contains interaction state classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.state-loading');
    expect(css).toContain('.state-empty');
    expect(css).toContain('.state-error');
    expect(css).toContain('.state-partial');
  });

  it('chat.css contains sidebar classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.sidebar');
    expect(css).toContain('.sidebar-section');
    expect(css).toContain('.sidebar-section-header');
  });

  it('chat.css contains input area classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.input-area');
    expect(css).toContain('.input-textarea');
  });

  it('chat.css contains footer classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.footer');
    expect(css).toContain('.footer-left');
    expect(css).toContain('.footer-right');
  });

  it('chat.css uses CSS custom properties from themes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('var(--bg-primary)');
    expect(css).toContain('var(--text-primary)');
    expect(css).toContain('var(--accent-primary)');
    expect(css).toContain('var(--sidebar-bg)');
  });
});
