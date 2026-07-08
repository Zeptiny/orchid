/**
 * Sidebar — collapsible right sidebar with independently collapsible sections.
 *
 * Sections:
 * - Sessions: Date-grouped list, click to switch, active session highlighted
 * - Subagents: Status indicators (pending/running/completed/failed)
 * - Todos: Status badges (OPEN/IN_PROGRESS/DONE)
 * - MCP Status: Connected/failed/unavailable per server
 * - Index Status: RAG/AST index status with "Index now" button
 *
 * Toggle: Ctrl+B or click toggle button.
 *
 * Interaction states on each section:
 * - Loading: spinner
 * - Empty: placeholder message
 * - Error: error message + retry
 * - Partial: truncated content + "show more"
 */
import { useState, useCallback, useEffect } from 'react';
import type { SessionSummary, MCPServerStatus, RAGStoreStatus, ASTStoreStatus } from '../../shared/types/ipc-boundary';
import { TodoStatus } from '../../shared/types/todo';
import type { SessionListState } from '../hooks/useSession';
import type { SubagentListState } from '../hooks/useSubagents';
import type { TodoListState } from '../hooks/useTodos';

// ── Props ────────────────────────────────────────────────────────────────────

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;

  // Sessions
  sessionListState: SessionListState;
  activeSessionId: string | null;
  onSessionSelect: (id: string) => void;
  onSessionCreate: () => void;
  onSessionDelete: (id: string) => void;
  onRefreshSessions: () => void;

  // Subagents
  subagentState: SubagentListState;
  onRefreshSubagents: () => void;

  // Todos
  todoState: TodoListState;
  onRefreshTodos: () => void;

  // MCP
  mcpServers: MCPServerStatus[];
  onRefreshMCP: () => void;

  // Index
  ragStatus: RAGStoreStatus | null;
  astStatus: ASTStoreStatus | null;
  onIndexRAG: () => void;
  onIndexAST: () => void;
  onRefreshIndex: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

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
  // Keyboard shortcut: Ctrl+B to toggle
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

  return (
    <div className={`sidebar ${isOpen ? '' : 'collapsed'}`}>
      <div className="sidebar-header">
        <span className="sidebar-title">Sidebar</span>
        <button className="btn btn-ghost btn-sm" onClick={onToggle} title="Toggle sidebar (Ctrl+B)">
          &#10005;
        </button>
      </div>

      <div className="sidebar-content">
        <SidebarSection title="Sessions" defaultExpanded>
          <SessionsSection
            state={sessionListState}
            activeSessionId={activeSessionId}
            onSelect={onSessionSelect}
            onCreate={onSessionCreate}
            onDelete={onSessionDelete}
            onRefresh={onRefreshSessions}
          />
        </SidebarSection>

        <SidebarSection title="Subagents" defaultExpanded>
          <SubagentsSection state={subagentState} onRefresh={onRefreshSubagents} />
        </SidebarSection>

        <SidebarSection title="Todos" defaultExpanded>
          <TodosSection state={todoState} onRefresh={onRefreshTodos} />
        </SidebarSection>

        <SidebarSection title="MCP Servers">
          <MCPSection servers={mcpServers} onRefresh={onRefreshMCP} />
        </SidebarSection>

        <SidebarSection title="Index Status">
          <IndexSection
            ragStatus={ragStatus}
            astStatus={astStatus}
            onIndexRAG={onIndexRAG}
            onIndexAST={onIndexAST}
            onRefresh={onRefreshIndex}
          />
        </SidebarSection>
      </div>
    </div>
  );
}

// ── Collapsible Section ──────────────────────────────────────────────────────

interface SidebarSectionProps {
  title: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

function SidebarSection({ title, defaultExpanded = false, children }: SidebarSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  return (
    <div className="sidebar-section">
      <div
        className="sidebar-section-header"
        onClick={toggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(); }}
      >
        <span className="sidebar-section-title">{title}</span>
        <span className={`sidebar-section-toggle ${expanded ? 'expanded' : ''}`}>&#9654;</span>
      </div>
      {expanded && <div className="sidebar-section-content">{children}</div>}
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
  return (
    <div>
      {/* Interaction states */}
      {state.status === 'loading' && (
        <div className="state-loading">
          <div className="spinner" />
          <span>Loading sessions...</span>
        </div>
      )}

      {state.status === 'error' && (
        <div className="state-error">
          <span className="state-error-message">{state.error}</span>
          <button className="btn btn-ghost btn-sm" onClick={onRefresh}>Retry</button>
        </div>
      )}

      {state.status === 'empty' && (
        <div className="state-empty">
          <div className="state-empty-icon">&#128196;</div>
          <div className="state-empty-text">No sessions yet</div>
          <button className="btn btn-primary btn-sm" onClick={onCreate}>New Session</button>
        </div>
      )}

      {(state.status === 'ready' || state.status === 'partial') && (
        <>
          {state.status === 'partial' && (
            <div className="state-error" style={{ padding: 'var(--space-2)' }}>
              <span className="state-error-message" style={{ fontSize: '10px' }}>
                {state.error}
              </span>
            </div>
          )}
          <SessionList
            sessions={state.sessions}
            activeSessionId={activeSessionId}
            onSelect={onSelect}
            onDelete={onDelete}
          />
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 'var(--space-2)', width: '100%' }}
            onClick={onCreate}>
            + New Session
          </button>
        </>
      )}
    </div>
  );
}

// ── Session List (date-grouped) ──────────────────────────────────────────────

interface SessionListProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

function SessionList({ sessions, activeSessionId, onSelect, onDelete }: SessionListProps) {
  // Group sessions by date
  const groups = groupSessionsByDate(sessions);

  return (
    <div className="session-list">
      {groups.map((group) => (
        <div key={group.label} className="session-date-group">
          <div className="session-date-label">{group.label}</div>
          {group.sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${session.id === activeSessionId ? 'active' : ''}`}
              onClick={() => onSelect(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect(session.id); }}
            >
              <span className="session-item-name">{session.name}</span>
              {session.model && (
                <span className="session-item-model">{session.model.split('/').pop()}</span>
              )}
              <button
                className="btn btn-ghost btn-sm"
                onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
                title="Delete session"
                style={{ padding: '2px 4px', fontSize: '10px' }}
              >
                &#10005;
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Date Grouping Helper ─────────────────────────────────────────────────────

interface SessionGroup {
  label: string;
  sessions: SessionSummary[];
}

function groupSessionsByDate(sessions: SessionSummary[]): SessionGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  const groups: Map<string, SessionSummary[]> = new Map();

  for (const session of sessions) {
    const date = new Date(session.updatedAt);
    const sessionDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    let label: string;
    if (sessionDate.getTime() === today.getTime()) {
      label = 'Today';
    } else if (sessionDate.getTime() === yesterday.getTime()) {
      label = 'Yesterday';
    } else if (sessionDate > weekAgo) {
      label = 'This Week';
    } else {
      label = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    }

    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label)!.push(session);
  }

  return Array.from(groups.entries()).map(([label, sessions]) => ({
    label,
    sessions,
  }));
}

// ── Subagents Section ────────────────────────────────────────────────────────

interface SubagentsSectionProps {
  state: SubagentListState;
  onRefresh: () => void;
}

function SubagentsSection({ state, onRefresh }: SubagentsSectionProps) {
  return (
    <div>
      {state.status === 'loading' && (
        <div className="state-loading">
          <div className="spinner" />
          <span>Loading subagents...</span>
        </div>
      )}

      {state.status === 'error' && (
        <div className="state-error">
          <span className="state-error-message">{state.error}</span>
          <button className="btn btn-ghost btn-sm" onClick={onRefresh}>Retry</button>
        </div>
      )}

      {state.status === 'empty' && (
        <div className="state-empty">
          <div className="state-empty-text">No subagents</div>
        </div>
      )}

      {state.status === 'ready' && (
        <div className="subagent-list">
          {state.subagents.map((sa) => (
            <div key={sa.id} className="subagent-item">
              <span className={`subagent-status-dot ${sa.status}`} />
              <span className="subagent-item-name">{sa.agent_name}</span>
              <span className="subagent-item-task">{sa.task.slice(0, 40)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Todos Section ────────────────────────────────────────────────────────────

interface TodosSectionProps {
  state: TodoListState;
  onRefresh: () => void;
}

function TodosSection({ state, onRefresh }: TodosSectionProps) {
  return (
    <div>
      {state.status === 'loading' && (
        <div className="state-loading">
          <div className="spinner" />
          <span>Loading todos...</span>
        </div>
      )}

      {state.status === 'error' && (
        <div className="state-error">
          <span className="state-error-message">{state.error}</span>
          <button className="btn btn-ghost btn-sm" onClick={onRefresh}>Retry</button>
        </div>
      )}

      {state.status === 'empty' && (
        <div className="state-empty">
          <div className="state-empty-text">No todos</div>
        </div>
      )}

      {state.status === 'ready' && (
        <div className="todo-list">
          {state.todos.map((todo) => (
            <div key={todo.id} className="todo-item">
              <span className={`todo-status-badge ${todo.status.toLowerCase()}`}>
                {todo.status}
              </span>
              <span className={`todo-item-title ${todo.status === TodoStatus.DONE ? 'done' : ''}`}>
                {todo.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── MCP Section ──────────────────────────────────────────────────────────────

interface MCPSectionProps {
  servers: MCPServerStatus[];
  onRefresh: () => void;
}

function MCPSection({ servers, onRefresh }: MCPSectionProps) {
  if (servers.length === 0) {
    return (
      <div className="state-empty">
        <div className="state-empty-text">No MCP servers configured</div>
      </div>
    );
  }

  return (
    <div className="mcp-list">
      {servers.map((server) => (
        <div key={server.name} className="mcp-item">
          <span className={`mcp-status-dot ${server.status}`} />
          <span className="mcp-item-name">{server.name}</span>
          <span className="mcp-item-tools">
            {server.status === 'connected' ? `${server.toolCount} tools` : server.status}
          </span>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" style={{ marginTop: 'var(--space-2)', width: '100%' }}
        onClick={onRefresh}>
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

function IndexSection({ ragStatus, astStatus, onIndexRAG, onIndexAST, onRefresh }: IndexSectionProps) {
  return (
    <div className="index-status">
      {/* RAG */}
      <div>
        <div className="index-row">
          <span className="index-label">RAG</span>
          <span className="index-value">
            {ragStatus
              ? `${ragStatus.totalChunks} chunks, ${ragStatus.totalFiles} files`
              : 'Not indexed'}
          </span>
        </div>
        {ragStatus?.lastIndexed && (
          <div className="index-row">
            <span className="index-value" style={{ fontSize: '10px' }}>
              Last: {new Date(ragStatus.lastIndexed).toLocaleString()}
            </span>
          </div>
        )}
        <button className="btn btn-secondary btn-sm index-button" onClick={onIndexRAG}>
          Index RAG Now
        </button>
      </div>

      {/* AST */}
      <div style={{ marginTop: 'var(--space-3)' }}>
        <div className="index-row">
          <span className="index-label">AST</span>
          <span className="index-value">
            {astStatus
              ? `${astStatus.totalSymbols} symbols, ${astStatus.totalFiles} files`
              : 'Not indexed'}
          </span>
        </div>
        {astStatus?.lastIndexed && (
          <div className="index-row">
            <span className="index-value" style={{ fontSize: '10px' }}>
              Last: {new Date(astStatus.lastIndexed).toLocaleString()}
            </span>
          </div>
        )}
        <button className="btn btn-secondary btn-sm index-button" onClick={onIndexAST}>
          Index AST Now
        </button>
      </div>

      <button className="btn btn-ghost btn-sm" style={{ marginTop: 'var(--space-2)', width: '100%' }}
        onClick={onRefresh}>
        Refresh Status
      </button>
    </div>
  );
}
