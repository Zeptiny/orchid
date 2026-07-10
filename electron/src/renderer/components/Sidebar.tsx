/**
 * Sidebar — right inspector panel (Context, Usage, Subagents, Todos, Index, MCP).
 * Iteration 012 mock-aligned collapse blocks.
 */
import { useState, type ReactNode } from 'react';
import type { MCPServerStatus, RAGStoreStatus, ASTStoreStatus } from '../../shared/types/ipc-boundary';
import { ContextGrid } from './ContextGrid';
import type { Message, Usage } from '../../shared/types/message';
import { TodoStatus } from '../../shared/types/todo';
import type { SubagentListState, SubagentDetail } from '../hooks/useSubagents';
import type { TodoListState } from '../hooks/useTodos';
import { formatShortcut } from '../keyboard';
import { Icon } from './Icon';

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  /** Title shown in the panel header (session name when available). */
  title?: string;
  subagentState: SubagentListState;
  onRefreshSubagents: () => void;
  selectedSubagentId: string | null;
  onSelectSubagent: (id: string | null) => void;
  getSubagentDetail: (id: string) => SubagentDetail | null;
  todoState: TodoListState;
  onRefreshTodos: () => void;
  mcpServers: MCPServerStatus[];
  onRefreshMCP: () => void;
  ragStatus?: RAGStoreStatus | null;
  astStatus?: ASTStoreStatus | null;
  onIndexRAG?: () => void | Promise<void>;
  onIndexAST?: () => void | Promise<void>;
  onRefreshIndex?: () => void | Promise<void>;
  usage?: Usage | null;
  cumulativeUsage?: Usage | null;
  maxContext?: number | null;
  messages?: readonly Message[];
  /** Working directory shown in the bottom status strip. */
  cwd?: string;
}

export function Sidebar({
  isOpen,
  onToggle,
  title = 'Orchid',
  subagentState,
  onRefreshSubagents,
  selectedSubagentId,
  onSelectSubagent,
  getSubagentDetail,
  todoState,
  onRefreshTodos,
  mcpServers,
  onRefreshMCP,
  ragStatus = null,
  astStatus = null,
  onIndexRAG,
  onIndexAST,
  onRefreshIndex,
  usage,
  cumulativeUsage,
  maxContext,
  messages,
  cwd,
}: SidebarProps) {
  // Inspector toggle (Mod+B) is owned by ChatView via the central shortcut registry.

  if (!isOpen) {
    return (
      <aside className="right-panel right-panel-collapsed">
        <button
          className="btn btn-ghost btn-sm btn-circle"
          onClick={onToggle}
          title={`Expand inspector (${formatShortcut('inspector.toggle')})`}
          type="button"
        >
          <Icon name="chevronLeft" size={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="right-panel">
      <div className="panel-header">
        <h1 className="title truncate">{title}</h1>
        <button
          className="btn btn-ghost btn-sm btn-circle"
          onClick={onToggle}
          title={`Collapse inspector (${formatShortcut('inspector.toggle')})`}
          type="button"
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </div>

      <div className="panel-body">
        <CollapseBlock
          title="Context"
          defaultOpen
          badge={<ContextBadge usage={usage} maxContext={maxContext} />}
        >
          <ContextGrid messages={messages} usage={usage} maxContext={maxContext} />
        </CollapseBlock>

        <CollapseBlock title="Usage">
          <TokenUsageSection cumulativeUsage={cumulativeUsage} maxContext={maxContext} />
        </CollapseBlock>

        <CollapseBlock
          title="Subagents"
          badge={
            subagentState.status === 'ready' && subagentState.subagents.length > 0 ? (
              <span className="badge badge-xs badge-success">{subagentState.subagents.length}</span>
            ) : null
          }
        >
          <SubagentsSection
            state={subagentState}
            onRefresh={onRefreshSubagents}
            selectedId={selectedSubagentId}
            onSelect={onSelectSubagent}
            getDetail={getSubagentDetail}
          />
        </CollapseBlock>

        <CollapseBlock title="Todos">
          <TodosSection state={todoState} onRefresh={onRefreshTodos} />
        </CollapseBlock>

        <CollapseBlock
          title="Workspace Index"
          badge={<IndexBadge ragStatus={ragStatus} astStatus={astStatus} />}
        >
          <IndexSection
            ragStatus={ragStatus}
            astStatus={astStatus}
            onIndexRAG={onIndexRAG}
            onIndexAST={onIndexAST}
            onRefresh={onRefreshIndex}
          />
        </CollapseBlock>

        <CollapseBlock title="MCP Servers" defaultOpen>
          <MCPSection servers={mcpServers} onRefresh={onRefreshMCP} />
        </CollapseBlock>
      </div>

      <div className="panel-status-footer" title={cwd || undefined}>
        {cwd ? (
          <>
            <Icon name="folder" size={11} className="shrink-0 opacity-60" />
            <span className="panel-status-cwd mono truncate">{cwd}</span>
          </>
        ) : (
          <>
            <span>orchid</span>
            <span>-</span>
            <span>general</span>
          </>
        )}
      </div>
    </aside>
  );
}

// ── Mock-style Collapse Block ───────────────────────────────────────────────

interface CollapseBlockProps {
  title: string;
  defaultOpen?: boolean;
  badge?: ReactNode;
  children: ReactNode;
}

function CollapseBlock({ title, defaultOpen = false, badge, children }: CollapseBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mock-collapse">
      <button
        className="mock-collapse-title flex w-full items-center justify-between gap-1.5"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="truncate">{title}</span>
          {badge}
        </span>
        <Icon
          name={open ? 'chevronDown' : 'chevronRight'}
          size={12}
          className="shrink-0 text-base-content/40"
        />
      </button>
      {open && <div className="mock-collapse-content">{children}</div>}
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
      <div className="inspector-empty">
        <p className="text-error text-xs">{state.error}</p>
        <button className="btn btn-ghost btn-xs" onClick={onRefresh} type="button">
          Retry
        </button>
      </div>
    );
  }

  if (state.status === 'empty') {
    return <p className="inspector-empty">No active subagents</p>;
  }

  const agents = state.status === 'ready' ? state.subagents : [];

  return (
    <div className="inspector-stack">
      {agents.map((agent) => {
        const detail = getDetail(agent.id);
        // Mock-style compact row: mono name + status badge
        const name = detail?.name || agent.agent_name || 'Subagent';
        const agentState = detail?.state || agent.status;
        const isSelected = selectedId === agent.id;
        const usage = detail?.usage;
        return (
          <div key={agent.id} className="inspector-stack gap-0">
            <button
              type="button"
              className={`inspector-row ${isSelected ? 'inspector-row-active' : ''}`}
              onClick={() => onSelect(isSelected ? null : agent.id)}
            >
              <span className="inspector-row-label mono truncate">{name}</span>
              <SubagentStateBadge state={agentState} />
            </button>
            {isSelected && (
              <div className="inspector-subagent-detail">
                {detail?.elapsed && (
                  <div className="subtle">elapsed {detail.elapsed}</div>
                )}
                {usage && (
                  <div className="subtle mono">
                    in {fmtTokens(usage.prompt_tokens)} · out {fmtTokens(usage.completion_tokens)}
                    {usage.cached_tokens > 0
                      ? ` · cached ${fmtTokens(usage.cached_tokens)}`
                      : ''}
                  </div>
                )}
                {detail?.task && (
                  <div className="inspector-subagent-task">{detail.task}</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function SubagentStateBadge({ state }: { state: string }) {
  const config: Record<string, { cls: string; label: string }> = {
    pending: { cls: 'badge-ghost', label: 'pending' },
    running: { cls: 'badge-warning', label: 'running' },
    completed: { cls: 'badge-success', label: 'done' },
    failed: { cls: 'badge-error', label: 'failed' },
    interrupted: { cls: 'badge-info', label: 'interrupted' },
  };

  const { cls, label } = config[state] ?? { cls: 'badge-ghost', label: state };

  return <span className={`badge badge-xs ${cls}`}>{label}</span>;
}

// ── Todos Section ────────────────────────────────────────────────────────────

interface TodosSectionProps {
  state: TodoListState;
  onRefresh: () => void;
}

function TodosSection({ state }: TodosSectionProps) {
  if (state.status === 'loading') {
    return <span className="loading loading-spinner loading-sm" />;
  }

  if (state.status === 'error') {
    return <p className="inspector-empty text-error">{state.error}</p>;
  }

  if (state.status === 'empty') {
    return <p className="inspector-empty">No todos</p>;
  }

  const todos = state.status === 'ready' ? state.todos : [];

  return (
    <div className="inspector-stack">
      {todos.map((todo) => (
        <div key={todo.id} className="inspector-row">
          <span
            className={`badge badge-xs ${
              todo.status === TodoStatus.DONE
                ? 'badge-success'
                : todo.status === TodoStatus.IN_PROGRESS
                  ? 'badge-warning'
                  : 'badge-ghost'
            }`}
          />
          <span
            className={`inspector-row-label truncate ${
              todo.status === TodoStatus.DONE ? 'line-through opacity-50' : ''
            }`}
          >
            {todo.title}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Workspace Index (RAG / AST) ──────────────────────────────────────────────

interface IndexSectionProps {
  ragStatus: RAGStoreStatus | null;
  astStatus: ASTStoreStatus | null;
  onIndexRAG?: () => void | Promise<void>;
  onIndexAST?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
}

function IndexSection({
  ragStatus,
  astStatus,
  onIndexRAG,
  onIndexAST,
  onRefresh,
}: IndexSectionProps) {
  const [indexing, setIndexing] = useState<'rag' | 'ast' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runIndex = async (kind: 'rag' | 'ast') => {
    const action = kind === 'rag' ? onIndexRAG : onIndexAST;
    if (!action || indexing) return;
    setIndexing(kind);
    setError(null);
    try {
      await action();
      await onRefresh?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`${kind.toUpperCase()} index failed: ${msg}`);
      console.error(`${kind} index failed:`, err);
    } finally {
      setIndexing(null);
    }
  };

  return (
    <div className="inspector-stack">
      <div className="inspector-row">
        <strong>RAG</strong>
        <span className="subtle text-right">{formatRagStatus(ragStatus)}</span>
      </div>
      {ragStatus?.lastIndexed && (
        <div className="inspector-row">
          <span className="subtle">Last indexed</span>
          <span className="subtle text-right">
            {formatRelativeTime(ragStatus.lastIndexed)}
            {ragStatus.lastIndexDuration != null
              ? ` · ${ragStatus.lastIndexDuration.toFixed(1)}s`
              : ''}
          </span>
        </div>
      )}

      <div className="inspector-row">
        <strong>AST</strong>
        <span className="subtle text-right">{formatAstStatus(astStatus)}</span>
      </div>
      {astStatus?.lastIndexed && (
        <div className="inspector-row">
          <span className="subtle">Last indexed</span>
          <span className="subtle text-right">
            {formatRelativeTime(astStatus.lastIndexed)}
            {astStatus.lastIndexDuration != null
              ? ` · ${astStatus.lastIndexDuration.toFixed(1)}s`
              : ''}
          </span>
        </div>
      )}

      <div className="inspector-row inspector-row-actions">
        <strong>Actions</strong>
        <span className="inline-flex gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={!onIndexRAG || indexing !== null}
            onClick={() => void runIndex('rag')}
            title="Index project for RAG semantic search"
          >
            {indexing === 'rag' ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              'RAG'
            )}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={!onIndexAST || indexing !== null}
            onClick={() => void runIndex('ast')}
            title="Re-scan project for AST symbols"
          >
            {indexing === 'ast' ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              'AST'
            )}
          </button>
          {onRefresh && (
            <button
              type="button"
              className="btn btn-ghost btn-xs btn-square"
              disabled={indexing !== null}
              onClick={() => void onRefresh()}
              title="Refresh index status"
            >
              <Icon name="refresh" size={12} />
            </button>
          )}
        </span>
      </div>
      {error && <p className="inspector-empty text-error text-left">{error}</p>}
    </div>
  );
}

function IndexBadge({
  ragStatus,
  astStatus,
}: {
  ragStatus: RAGStoreStatus | null;
  astStatus: ASTStoreStatus | null;
}) {
  const hasRag = Boolean(ragStatus && ragStatus.totalChunks > 0);
  const hasAst = Boolean(astStatus && astStatus.totalSymbols > 0);
  if (!hasRag && !hasAst) {
    return <span className="badge badge-xs badge-ghost">empty</span>;
  }
  if (hasRag && hasAst) {
    return <span className="badge badge-xs badge-success">ready</span>;
  }
  return <span className="badge badge-xs badge-warning">partial</span>;
}

function formatRagStatus(status: RAGStoreStatus | null): string {
  if (!status) return 'Not loaded';
  if (status.totalFiles === 0 && status.totalChunks === 0) return 'No index';
  return `${formatCompactCount(status.totalFiles)} files · ${formatCompactCount(status.totalChunks)} chunks`;
}

function formatAstStatus(status: ASTStoreStatus | null): string {
  if (!status) return 'Not loaded';
  if (status.totalFiles === 0 && status.totalSymbols === 0) return 'No index';
  return `${formatCompactCount(status.totalSymbols)} symbols · ${formatCompactCount(status.totalFiles)} files`;
}

function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ── MCP Section ──────────────────────────────────────────────────────────────

interface MCPSectionProps {
  servers: MCPServerStatus[];
  onRefresh: () => void;
}

function MCPSection({ servers }: MCPSectionProps) {
  if (servers.length === 0) {
    return <p className="inspector-empty">No MCP servers configured</p>;
  }

  return (
    <div className="inspector-stack">
      {servers.map((server) => (
        <div key={server.name} className="inspector-row">
          <span className="inspector-row-label truncate">{server.name}</span>
          {server.status === 'connected' ? (
            <span className="badge badge-xs badge-success shrink-0">
              {server.toolCount > 0 ? `${server.toolCount} tools` : 'connected'}
            </span>
          ) : server.status === 'starting' ? (
            <span className="badge badge-xs badge-warning shrink-0">starting</span>
          ) : (
            <span className="badge badge-xs badge-ghost shrink-0">{server.status}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Context Badge ────────────────────────────────────────────────────────────

interface ContextBadgeProps {
  usage?: Usage | null;
  maxContext?: number | null;
}

function ContextBadge({ usage, maxContext }: ContextBadgeProps) {
  if (usage && maxContext && maxContext > 0) {
    const pct = Math.min(100, Math.round((usage.prompt_tokens / maxContext) * 100));
    return (
      <span
        className={`badge badge-xs ${
          pct >= 85 ? 'badge-error' : pct >= 60 ? 'badge-warning' : pct > 0 ? 'badge-info' : 'badge-ghost'
        }`}
      >
        {pct}%
      </span>
    );
  }
  // Avoid showing a misleading 0% when we have tokens but no window metadata
  if (usage && usage.prompt_tokens > 0) {
    return <span className="badge badge-xs badge-ghost">n/a</span>;
  }
  return <span className="badge badge-xs badge-ghost">0%</span>;
}

// ── Token Usage Section ─────────────────────────────────────────────────────

interface TokenUsageSectionProps {
  cumulativeUsage?: Usage | null;
  maxContext?: number | null;
}

function TokenUsageSection({ cumulativeUsage }: TokenUsageSectionProps) {
  const prompt = cumulativeUsage?.prompt_tokens ?? 0;
  const completion = cumulativeUsage?.completion_tokens ?? 0;
  const total = cumulativeUsage?.total_tokens ?? 0;
  const cached = cumulativeUsage?.cached_tokens ?? 0;

  return (
    <div className="inspector-stack">
      <div className="inspector-row">
        <strong>Prompt</strong>
        <span className="subtle">{formatTokenCount(prompt)}</span>
      </div>
      <div className="inspector-row">
        <strong>Completion</strong>
        <span className="subtle">{formatTokenCount(completion)}</span>
      </div>
      <div className="inspector-row">
        <strong>Total</strong>
        <span className="subtle">{formatTokenCount(total)}</span>
      </div>
      <div className="inspector-row">
        <strong>Cached</strong>
        <span className="subtle">{formatTokenCount(cached)}</span>
      </div>
    </div>
  );
}

/** Same compact formatting as ContextGrid (e.g. 1.2k, 1.5M). */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
