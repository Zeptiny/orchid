/**
 * Sidebar — collapsible right sidebar with DaisyUI components.
 */
import { useState, useCallback, useEffect } from 'react';
import type { SessionSummary, MCPServerStatus, RAGStoreStatus, ASTStoreStatus } from '../../shared/types/ipc-boundary';
import { TodoStatus } from '../../shared/types/todo';
import type { SessionListState } from '../hooks/useSession';
import type { SubagentListState } from '../hooks/useSubagents';
import type { TodoListState } from '../hooks/useTodos';

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  sessionListState: SessionListState;
  activeSessionId: string | null;
  onSessionSelect: (id: string) => void;
  onSessionCreate: () => void;
  onSessionDelete: (id: string) => void;
  onRefreshSessions: () => void;
  subagentState: SubagentListState;
  onRefreshSubagents: () => void;
  todoState: TodoListState;
  onRefreshTodos: () => void;
  mcpServers: MCPServerStatus[];
  onRefreshMCP: () => void;
  ragStatus: RAGStoreStatus | null;
  astStatus: ASTStoreStatus | null;
  onIndexRAG: () => void;
  onIndexAST: () => void;
  onRefreshIndex: () => void;
}

export function Sidebar({
  isOpen,
  onToggle,
  sessionListState,
  activeSessionId,
  onSessionSelect,
  onSessionCreate,
  onSessionDelete,
  onRefreshSessions,
  subagentState,
  onRefreshSubagents,
  todoState,
  onRefreshTodos,
  mcpServers,
  onRefreshMCP,
  ragStatus,
  astStatus,
  onIndexRAG,
  onIndexAST,
  onRefreshIndex,
}: SidebarProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        onToggle();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onToggle]);

  if (!isOpen) return null;

  return (
    <div className="w-80 bg-base-200 border-l border-base-300 flex flex-col h-full">
      <div className="p-4 border-b border-base-300 flex items-center justify-between">
        <h2 className="text-lg font-bold">Sidebar</h2>
        <button className="btn btn-ghost btn-sm btn-circle" onClick={onToggle}>
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {/* Sessions */}
        <div className="collapse collapse-arrow bg-base-100">
          <input type="checkbox" defaultChecked />
          <div className="collapse-title text-sm font-medium">Sessions</div>
          <div className="collapse-content">
            <SessionsSection
              state={sessionListState}
              activeSessionId={activeSessionId}
              onSelect={onSessionSelect}
              onCreate={onSessionCreate}
              onDelete={onSessionDelete}
              onRefresh={onRefreshSessions}
            />
          </div>
        </div>

        {/* Subagents */}
        <div className="collapse collapse-arrow bg-base-100">
          <input type="checkbox" defaultChecked />
          <div className="collapse-title text-sm font-medium">Subagents</div>
          <div className="collapse-content">
            <SubagentsSection state={subagentState} onRefresh={onRefreshSubagents} />
          </div>
        </div>

        {/* Todos */}
        <div className="collapse collapse-arrow bg-base-100">
          <input type="checkbox" defaultChecked />
          <div className="collapse-title text-sm font-medium">Todos</div>
          <div className="collapse-content">
            <TodosSection state={todoState} onRefresh={onRefreshTodos} />
          </div>
        </div>

        {/* MCP Servers */}
        <div className="collapse collapse-arrow bg-base-100">
          <input type="checkbox" />
          <div className="collapse-title text-sm font-medium">MCP Servers</div>
          <div className="collapse-content">
            <MCPSection servers={mcpServers} onRefresh={onRefreshMCP} />
          </div>
        </div>

        {/* Index Status */}
        <div className="collapse collapse-arrow bg-base-100">
          <input type="checkbox" />
          <div className="collapse-title text-sm font-medium">Index Status</div>
          <div className="collapse-content">
            <IndexSection
              ragStatus={ragStatus}
              astStatus={astStatus}
              onIndexRAG={onIndexRAG}
              onIndexAST={onIndexAST}
              onRefresh={onRefreshIndex}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sessions Section ─────────────────────────────────────────────────────────

interface SessionsSectionProps {
  state: SessionListState;
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}

function SessionsSection({
  state,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  onRefresh,
}: SessionsSectionProps) {
  if (state.status === 'loading') {
    return <span className="loading loading-spinner loading-sm" />;
  }

  if (state.status === 'error') {
    return (
      <div className="text-center">
        <p className="text-error text-xs">{state.error}</p>
        <button className="btn btn-ghost btn-xs mt-2" onClick={onRefresh}>Retry</button>
      </div>
    );
  }

  if (state.status === 'empty') {
    return (
      <div className="text-center">
        <p className="text-base-content/50 text-xs mb-2">No sessions yet</p>
        <button className="btn btn-primary btn-xs" onClick={onCreate}>New Session</button>
      </div>
    );
  }

  const sessions = state.status === 'ready' || state.status === 'partial' ? state.sessions : [];

  return (
    <div className="space-y-2">
      <ul className="menu menu-sm">
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              className={`flex items-center justify-between ${session.id === activeSessionId ? 'active' : ''}`}
              onClick={() => onSelect(session.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="truncate text-xs">{session.name}</div>
                {session.model && (
                  <div className="text-[10px] opacity-50 truncate">{session.model.split('/').pop()}</div>
                )}
              </div>
              <button
                className="btn btn-ghost btn-xs btn-circle opacity-50 hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
              >
                ✕
              </button>
            </button>
          </li>
        ))}
      </ul>
      <button className="btn btn-ghost btn-xs w-full" onClick={onCreate}>
        + New Session
      </button>
    </div>
  );
}

// ── Subagents Section ────────────────────────────────────────────────────────

interface SubagentsSectionProps {
  state: SubagentListState;
  onRefresh: () => void;
}

function SubagentsSection({ state, onRefresh }: SubagentsSectionProps) {
  if (state.status === 'loading') {
    return <span className="loading loading-spinner loading-sm" />;
  }

  if (state.status === 'error') {
    return (
      <div className="text-center">
        <p className="text-error text-xs">{state.error}</p>
        <button className="btn btn-ghost btn-xs mt-2" onClick={onRefresh}>Retry</button>
      </div>
    );
  }

  if (state.status === 'empty') {
    return <p className="text-base-content/50 text-xs text-center">No active subagents</p>;
  }

  const agents = state.status === 'ready' ? state.subagents : [];

  return (
    <ul className="menu menu-sm">
      {agents.map((agent) => (
        <li key={agent.id}>
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <div className="truncate text-xs">{agent.agent_name}</div>
              <div className="text-[10px] opacity-50">{agent.status}</div>
            </div>
            <span className={`badge badge-xs ${
              agent.status === 'running' ? 'badge-warning' :
              agent.status === 'completed' ? 'badge-success' :
              agent.status === 'failed' ? 'badge-error' : 'badge-ghost'
            }`} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Todos Section ────────────────────────────────────────────────────────────

interface TodosSectionProps {
  state: TodoListState;
  onRefresh: () => void;
}

function TodosSection({ state, onRefresh }: TodosSectionProps) {
  if (state.status === 'loading') {
    return <span className="loading loading-spinner loading-sm" />;
  }

  if (state.status === 'error') {
    return (
      <div className="text-center">
        <p className="text-error text-xs">{state.error}</p>
        <button className="btn btn-ghost btn-xs mt-2" onClick={onRefresh}>Retry</button>
      </div>
    );
  }

  if (state.status === 'empty') {
    return <p className="text-base-content/50 text-xs text-center">No todos</p>;
  }

  const todos = state.status === 'ready' ? state.todos : [];

  return (
    <ul className="menu menu-sm">
      {todos.map((todo) => (
        <li key={todo.id}>
          <div className="flex items-center gap-2">
            <span className={`badge badge-xs ${
              todo.status === TodoStatus.DONE ? 'badge-success' :
              todo.status === TodoStatus.IN_PROGRESS ? 'badge-warning' : 'badge-ghost'
            }`}>
              {todo.status === TodoStatus.DONE ? '✓' : todo.status === TodoStatus.IN_PROGRESS ? '⟳' : '○'}
            </span>
            <span className={`text-xs ${todo.status === TodoStatus.DONE ? 'line-through opacity-50' : ''}`}>
              {todo.title}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── MCP Section ──────────────────────────────────────────────────────────────

interface MCPSectionProps {
  servers: MCPServerStatus[];
  onRefresh: () => void;
}

function MCPSection({ servers, onRefresh }: MCPSectionProps) {
  if (servers.length === 0) {
    return <p className="text-base-content/50 text-xs text-center">No MCP servers configured</p>;
  }

  return (
    <div className="space-y-2">
      <ul className="menu menu-sm">
        {servers.map((server) => (
          <li key={server.name}>
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="truncate text-xs">{server.name}</div>
                <div className="text-[10px] opacity-50">{server.toolCount} tools</div>
              </div>
              <span className={`badge badge-xs ${
                server.status === 'connected' ? 'badge-success' :
                server.status === 'failed' ? 'badge-error' :
                server.status === 'starting' ? 'badge-warning' : 'badge-ghost'
              }`}>
                {server.status}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <button className="btn btn-ghost btn-xs w-full" onClick={onRefresh}>
        Refresh
      </button>
    </div>
  );
}

// ── Index Section ────────────────────────────────────────────────────────────

interface IndexSectionProps {
  ragStatus: RAGStoreStatus | null;
  astStatus: ASTStoreStatus | null;
  onIndexRAG: () => void;
  onIndexAST: () => void;
  onRefresh: () => void;
}

function IndexSection({
  ragStatus,
  astStatus,
  onIndexRAG,
  onIndexAST,
  onRefresh,
}: IndexSectionProps) {
  return (
    <div className="space-y-3">
      {/* RAG Status */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium">RAG</span>
          <button className="btn btn-ghost btn-xs" onClick={onIndexRAG}>Index</button>
        </div>
        {ragStatus ? (
          <div className="text-[10px] opacity-50">
            {ragStatus.totalFiles} files, {ragStatus.totalChunks} chunks
            {ragStatus.lastIndexed && <span> · Last: {new Date(ragStatus.lastIndexed).toLocaleDateString()}</span>}
          </div>
        ) : (
          <div className="text-[10px] opacity-50">Not indexed</div>
        )}
      </div>

      {/* AST Status */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium">AST</span>
          <button className="btn btn-ghost btn-xs" onClick={onIndexAST}>Index</button>
        </div>
        {astStatus ? (
          <div className="text-[10px] opacity-50">
            {astStatus.totalFiles} files, {astStatus.totalSymbols} symbols
            {astStatus.lastIndexed && <span> · Last: {new Date(astStatus.lastIndexed).toLocaleDateString()}</span>}
          </div>
        ) : (
          <div className="text-[10px] opacity-50">Not indexed</div>
        )}
      </div>

      <button className="btn btn-ghost btn-xs w-full" onClick={onRefresh}>
        Refresh Status
      </button>
    </div>
  );
}
