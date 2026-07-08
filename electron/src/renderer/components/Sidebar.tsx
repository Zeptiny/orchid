/**
 * Sidebar — collapsible right sidebar with DaisyUI components.
 */
import { useState, useCallback, useEffect } from 'react';
import type { SessionSummary, MCPServerStatus, RAGStoreStatus, ASTStoreStatus } from '../../shared/types/ipc-boundary';
import { TodoStatus } from '../../shared/types/todo';
import type { SessionListState } from '../hooks/useSession';
import type { SubagentListState, SubagentDetail } from '../hooks/useSubagents';
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
  selectedSubagentId: string | null;
  onSelectSubagent: (id: string | null) => void;
  getSubagentDetail: (id: string) => SubagentDetail | null;
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
  selectedSubagentId,
  onSelectSubagent,
  getSubagentDetail,
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
            <SubagentsSection
              state={subagentState}
              onRefresh={onRefreshSubagents}
              selectedId={selectedSubagentId}
              onSelect={onSelectSubagent}
              getDetail={getSubagentDetail}
            />
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
            <div
              className={`flex items-center justify-between cursor-pointer ${session.id === activeSessionId ? 'active' : ''}`}
              onClick={() => onSelect(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect(session.id); }}
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
            </div>
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
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  getDetail: (id: string) => SubagentDetail | null;
}

function SubagentsSection({ state, onRefresh, selectedId, onSelect, getDetail }: SubagentsSectionProps) {
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
    <div className="space-y-1">
      {agents.map((agent) => {
        const detail = getDetail(agent.id);
        return (
          <SubagentPane
            key={agent.id}
            detail={detail}
            agent={agent}
            isSelected={selectedId === agent.id}
            onSelect={onSelect}
          />
        );
      })}
      <button className="btn btn-ghost btn-xs w-full mt-2" onClick={onRefresh}>
        Refresh
      </button>
    </div>
  );
}

// ── Subagent Pane ────────────────────────────────────────────────────────────

interface SubagentPaneProps {
  detail: SubagentDetail | null;
  agent: { id: string; agent_name: string; status: string };
  isSelected: boolean;
  onSelect: (id: string | null) => void;
}

function SubagentPane({ detail, agent, isSelected, onSelect }: SubagentPaneProps) {
  const name = detail?.name || agent.agent_name || 'Subagent';
  const state = detail?.state || agent.status;
  const isRunning = state === 'running' || state === 'pending';

  return (
    <div
      className={`rounded-lg border transition-colors cursor-pointer ${
        isSelected
          ? 'border-primary bg-primary/5'
          : 'border-base-300 bg-base-100 hover:border-base-content/20'
      }`}
      onClick={() => onSelect(agent.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(agent.id); }}
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* State indicator */}
        {isRunning ? (
          <span className="loading loading-spinner loading-xs text-primary" />
        ) : state === 'completed' ? (
          <span className="text-success text-xs">✓</span>
        ) : state === 'failed' ? (
          <span className="text-error text-xs">✕</span>
        ) : (
          <span className="text-base-content/30 text-xs">○</span>
        )}

        {/* Name and metadata */}
        <div className="flex-1 min-w-0">
          <div className="truncate text-xs font-medium">{name}</div>
          {detail?.task && (
            <div className="text-[10px] opacity-50 truncate">{detail.task}</div>
          )}
        </div>

        {/* Badges */}
        <div className="flex items-center gap-1 shrink-0">
          {detail?.tier && (
            <span className="badge badge-xs badge-outline">{detail.tier}</span>
          )}
          <SubagentStateBadge state={state} />
        </div>
      </div>

      {/* Elapsed time */}
      {detail && (
        <div className="px-3 pb-1.5">
          <span className={`text-[10px] ${isRunning ? 'text-primary font-mono' : 'opacity-50'}`}>
            {isRunning ? '⏱' : '⏱'} {detail.elapsed}
          </span>
        </div>
      )}

      {/* Expanded detail */}
      {isSelected && detail && (
        <div className="px-3 pb-2 border-t border-base-300 mt-1 pt-2 space-y-1.5">
          {/* Type and tier row */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] opacity-50">Type:</span>
            <span className="text-[10px] font-mono">{detail.type}</span>
          </div>

          {/* Task description */}
          {detail.task && (
            <div>
              <span className="text-[10px] opacity-50 block mb-0.5">Task</span>
              <p className="text-[10px] leading-relaxed bg-base-200 rounded p-1.5 break-words">
                {detail.task}
              </p>
            </div>
          )}

          {/* Result */}
          {detail.result && state === 'completed' && (
            <div>
              <span className="text-[10px] opacity-50 block mb-0.5">Result</span>
              <p className="text-[10px] leading-relaxed bg-success/10 text-success-content rounded p-1.5 break-words max-h-32 overflow-y-auto">
                {detail.result}
              </p>
            </div>
          )}

          {/* Error */}
          {detail.error && (state === 'failed' || state === 'interrupted') && (
            <div>
              <span className="text-[10px] opacity-50 block mb-0.5">Error</span>
              <p className="text-[10px] leading-relaxed bg-error/10 text-error-content rounded p-1.5 break-words max-h-32 overflow-y-auto">
                {detail.error}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Subagent State Badge ─────────────────────────────────────────────────────

function SubagentStateBadge({ state }: { state: string }) {
  const config: Record<string, { cls: string; label: string }> = {
    pending: { cls: 'badge-ghost', label: 'pending' },
    running: { cls: 'badge-warning', label: 'running' },
    completed: { cls: 'badge-success', label: 'done' },
    failed: { cls: 'badge-error', label: 'failed' },
    interrupted: { cls: 'badge-info', label: 'interrupted' },
  };

  const { cls, label } = config[state] ?? { cls: 'badge-ghost', label: state };

  return (
    <span className={`badge badge-xs ${cls}`}>
      {label}
    </span>
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
