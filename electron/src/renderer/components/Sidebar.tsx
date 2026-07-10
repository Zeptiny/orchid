/**
 * Sidebar — right inspector panel (Todos, Subagents, Context, Usage, Index, MCP).
 * Iteration 012 mock-aligned collapse blocks.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type {
  MCPServerStatus,
  MCPServerStatusValue,
  RAGStoreStatus,
  ASTStoreStatus,
  RAGIndexProgress,
  ASTIndexProgress,
} from '../../shared/types/ipc-boundary';
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
  ragStatus?: RAGStoreStatus | null;
  astStatus?: ASTStoreStatus | null;
  onIndexRAG?: () => void | Promise<void>;
  onIndexAST?: () => void | Promise<void>;
  /** Refresh RAG/AST store status (after a run completes, including late-join). */
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
        <CollapseBlock title="Todos">
          <TodosSection state={todoState} onRefresh={onRefreshTodos} />
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
          title="Workspace Index"
          badge={<IndexBadge ragStatus={ragStatus} astStatus={astStatus} />}
        >
          <IndexSection
            ragStatus={ragStatus}
            astStatus={astStatus}
            onIndexRAG={onIndexRAG}
            onIndexAST={onIndexAST}
            onRefreshIndex={onRefreshIndex}
          />
        </CollapseBlock>

        <CollapseBlock title="MCP Servers" defaultOpen badge={<MCPStatusBadges servers={mcpServers} />}>
          <MCPSection servers={mcpServers} />
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
  onRefreshIndex?: () => void | Promise<void>;
}

function IndexSection({
  ragStatus,
  astStatus,
  onIndexRAG,
  onIndexAST,
  onRefreshIndex,
}: IndexSectionProps) {
  // Track each indexer independently so RAG and AST can run in parallel.
  // Busy state can also be restored from main-process indexState (tab remount).
  const [indexingRag, setIndexingRag] = useState(false);
  const [indexingAst, setIndexingAst] = useState(false);
  const [ragError, setRagError] = useState<string | null>(null);
  const [astError, setAstError] = useState<string | null>(null);
  const [ragProgress, setRagProgress] = useState<RAGIndexProgress | null>(null);
  const [astProgress, setAstProgress] = useState<ASTIndexProgress | null>(null);
  // Restore in-flight state when remounting (e.g. user switched tabs).
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      try {
        const [rag, ast] = await Promise.all([
          window.orchid?.rag?.indexState?.(),
          window.orchid?.ast?.indexState?.(),
        ]);
        if (cancelled) return;
        if (rag?.indexing) {
          setIndexingRag(true);
          setRagProgress(rag.progress);
        }
        if (ast?.indexing) {
          setIndexingAst(true);
          setAstProgress(ast.progress);
        }
      } catch {
        // Non-fatal
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live progress — also flips busy UI for late subscribers (not only the starter).
  useEffect(() => {
    const unsubRag = window.orchid?.rag?.onProgress?.((p) => {
      setRagProgress(p);
      if (p.phase === 'done') {
        setIndexingRag(false);
        setRagProgress(null);
        // If we didn't start this run, still refresh store counts.
        void onRefreshIndex?.();
      } else {
        setIndexingRag(true);
      }
    });
    const unsubAst = window.orchid?.ast?.onProgress?.((p) => {
      setAstProgress(p);
      if (p.phase === 'done') {
        setIndexingAst(false);
        setAstProgress(null);
        void onRefreshIndex?.();
      } else {
        setIndexingAst(true);
      }
    });
    return () => {
      unsubRag?.();
      unsubAst?.();
    };
  }, [onRefreshIndex]);

  const runIndex = async (kind: 'rag' | 'ast') => {
    const action = kind === 'rag' ? onIndexRAG : onIndexAST;
    const busy = kind === 'rag' ? indexingRag : indexingAst;
    if (!action || busy) return;

    if (kind === 'rag') {
      setIndexingRag(true);
      setRagError(null);
      setRagProgress({
        phase: 'discovering',
        done: 0,
        total: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        chunksCreated: 0,
        filesDeleted: 0,
        elapsedSeconds: 0,
      });
    } else {
      setIndexingAst(true);
      setAstError(null);
      setAstProgress({
        phase: 'discovering',
        done: 0,
        total: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        symbolsExtracted: 0,
        filesDeleted: 0,
        elapsedSeconds: 0,
      });
    }

    try {
      // Handlers refresh status on success; progress events also refresh late-joiners.
      await action();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const line = `${kind.toUpperCase()} index failed: ${msg}`;
      if (kind === 'rag') setRagError(line);
      else setAstError(line);
      console.error(`${kind} index failed:`, err);
    } finally {
      if (kind === 'rag') {
        // Progress 'done' may have already cleared; keep teardown idempotent.
        setIndexingRag(false);
        setRagProgress(null);
      } else {
        setIndexingAst(false);
        setAstProgress(null);
      }
    }
  };

  return (
    <div className="inspector-stack">
      <div className="inspector-row">
        <strong>RAG</strong>
        <span className="subtle text-right">
          {indexingRag ? formatIndexProgressLabel(ragProgress) : formatRagStatus(ragStatus)}
        </span>
      </div>
      {indexingRag && (
        <IndexProgressPanel
          progress={ragProgress}
          detail={
            ragProgress
              ? `${ragProgress.filesIndexed} indexed · ${ragProgress.filesSkipped} skipped · ${ragProgress.chunksCreated} chunks`
              : undefined
          }
        />
      )}
      {ragStatus?.lastIndexed && !indexingRag && (
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
        <span className="subtle text-right">
          {indexingAst ? formatIndexProgressLabel(astProgress) : formatAstStatus(astStatus)}
        </span>
      </div>
      {indexingAst && (
        <IndexProgressPanel
          progress={astProgress}
          detail={
            astProgress
              ? `${astProgress.filesIndexed} indexed · ${astProgress.filesSkipped} skipped · ${astProgress.symbolsExtracted} symbols`
              : undefined
          }
        />
      )}
      {astStatus?.lastIndexed && !indexingAst && (
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
            disabled={!onIndexRAG || indexingRag}
            onClick={() => void runIndex('rag')}
            title="Index project for RAG semantic search"
          >
            {indexingRag ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              'RAG'
            )}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={!onIndexAST || indexingAst}
            onClick={() => void runIndex('ast')}
            title="Re-scan project for AST symbols"
          >
            {indexingAst ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              'AST'
            )}
          </button>
        </span>
      </div>
      {ragError && <p className="inspector-empty text-error text-left">{ragError}</p>}
      {astError && <p className="inspector-empty text-error text-left">{astError}</p>}
    </div>
  );
}

type IndexProgressLike = {
  phase: 'discovering' | 'indexing' | 'finalizing' | 'done';
  done: number;
  total: number;
  currentFile?: string;
  elapsedSeconds: number;
} | null;

function formatIndexProgressLabel(p: IndexProgressLike): string {
  if (!p) return 'indexing…';
  if (p.phase === 'discovering') return 'scanning…';
  if (p.phase === 'finalizing') return 'finalizing…';
  if (p.phase === 'done') return 'done';
  if (p.total <= 0) return 'indexing…';
  const pct = Math.min(100, Math.round((p.done / p.total) * 100));
  return `${p.done}/${p.total} · ${pct}%`;
}

function IndexProgressPanel({
  progress,
  detail,
}: {
  progress: IndexProgressLike;
  detail?: string;
}) {
  if (!progress) {
    return <div className="subtle">Indexing…</div>;
  }
  if (progress.total === 0) {
    return (
      <div className="subtle">
        {progress.phase === 'discovering' ? 'Scanning project…' : 'Indexing…'}
      </div>
    );
  }
  return (
    <div className="inspector-stack gap-0">
      <progress
        className="progress progress-primary h-1 w-full"
        value={progress.done}
        max={Math.max(1, progress.total)}
      />
      <div className="inspector-row">
        <span className="subtle truncate" title={progress.currentFile}>
          {progress.phase === 'discovering'
            ? 'Scanning files…'
            : progress.phase === 'finalizing'
              ? 'Writing index…'
              : progress.currentFile
                ? progress.currentFile
                : 'Indexing…'}
        </span>
        <span className="subtle shrink-0 mono">
          {progress.done}/{progress.total}
        </span>
      </div>
      {detail && (
        <div className="subtle">
          {detail}
          {progress.elapsedSeconds > 0 ? ` · ${progress.elapsedSeconds.toFixed(1)}s` : ''}
        </div>
      )}
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
}

export type MCPStatusCounts = Record<MCPServerStatusValue, number>;

export function countMCPServerStatuses(servers: readonly MCPServerStatus[]): MCPStatusCounts {
  const counts: MCPStatusCounts = {
    connected: 0,
    starting: 0,
    failed: 0,
    unavailable: 0,
  };

  for (const server of servers) {
    counts[server.status] += 1;
  }

  return counts;
}

const MCP_STATUS_BADGES: readonly {
  status: MCPServerStatusValue;
  className: string;
  label: string;
}[] = [
  { status: 'connected', className: 'badge-success', label: 'connected' },
  { status: 'starting', className: 'badge-warning', label: 'starting' },
  { status: 'failed', className: 'badge-error', label: 'failed' },
  { status: 'unavailable', className: 'badge-ghost', label: 'unavailable' },
];

function MCPStatusBadges({ servers }: MCPSectionProps) {
  const counts = countMCPServerStatuses(servers);

  return (
    <span className="inline-flex shrink-0 items-center gap-1" aria-label="MCP server status counts">
      {MCP_STATUS_BADGES.filter(({ status }) => counts[status] > 0).map(({ status, className, label }) => (
        <span
          key={status}
          className={`badge badge-xs ${className}`}
          title={`${counts[status]} ${label} MCP ${counts[status] === 1 ? 'server' : 'servers'}`}
          aria-label={`${counts[status]} ${label} MCP ${counts[status] === 1 ? 'server' : 'servers'}`}
        >
          {counts[status]}
        </span>
      ))}
    </span>
  );
}

function MCPSection({ servers }: MCPSectionProps) {
  if (servers.length === 0) {
    return <p className="inspector-empty">No MCP servers configured</p>;
  }

  return (
    <div className="inspector-stack">
      {servers.map((server) => (
        <div key={server.name} className="inspector-stack gap-0">
          <div className="inspector-row">
            <span className="inspector-row-label truncate">{server.name}</span>
            {server.status === 'connected' ? (
              <span className="badge badge-xs badge-success shrink-0">
                {server.toolCount > 0 ? `${server.toolCount} tools` : 'connected'}
              </span>
            ) : server.status === 'starting' ? (
              <span className="badge badge-xs badge-warning shrink-0">starting</span>
            ) : server.status === 'failed' ? (
              <span className="badge badge-xs badge-error shrink-0">failed</span>
            ) : (
              <span className="badge badge-xs badge-ghost shrink-0">{server.status}</span>
            )}
          </div>
          {server.error && (
            <div className="subtle text-error truncate" title={server.error}>
              {server.error}
            </div>
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
