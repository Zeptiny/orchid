/**
 * Sidebar — right inspector panel (Todos, Subagents, Commands, Context, Usage, Index, MCP).
 * Iteration 012 mock-aligned collapse blocks.
 */
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  MCPServerStatus,
  MCPServerStatusValue,
  RAGStoreStatus,
  ASTStoreStatus,
  RAGIndexProgress,
  ASTIndexProgress,
} from '../../shared/types/ipc-boundary';
import type { DebugRequestSummary } from '../../shared/types/debug';
import { ContextGrid, contextPercent as getContextPercent } from './ContextGrid';
import { contextUsedTokens } from '../../shared/usage';
import type { Message, Usage } from '../../shared/types/message';
import { TodoStatus } from '../../shared/types/todo';
import type { SubagentSummary } from '../../shared/types/subagent';
import type { SubagentListState, SubagentDetail } from '../hooks/useSubagents';
import type { TodoListState } from '../hooks/useTodos';
import type { BackgroundCommandsState } from '../hooks/useBackgroundCommands';
import type {
  DebugRequestCaptureState,
  DebugRequestsListState,
} from '../hooks/useDebugRequests';
import { countRequestAgentOrigins } from '../hooks/useDebugRequests';
import { formatShortcut } from '../keyboard';
import {
  nextForceOpenEpoch,
  resolveInspectorSectionId,
  shouldOpenCollapseFromToken,
} from '../utils/navigate-shell';
import { formatUsageSummary } from '../utils/format-usage';
import { groupSubagents } from '../utils/subagent-stream';
import { Icon } from './Icon';
import { Button } from './ui/Button';
import { CollapsibleRegion } from './ui/CollapsibleRegion';
import { DropdownMenu } from './ui/DropdownMenu';
import { IconButton } from './ui/IconButton';
import { Spinner } from './ui/Spinner';
import { StateMessage } from './ui/StateMessage';
import { StatusBadge } from './ui/StatusBadge';
import { Tabs, type TabItem } from './ui/Tabs';
import { CommandsSection, countRunningCommands } from './Sidebar/CommandsSection';

/** Stable prop defaults so the memoized Sidebar never churns on re-renders. */
const EMPTY_REQUESTS_LIST: DebugRequestsListState = { status: 'empty' };
const EMPTY_REQUEST_CAPTURE: DebugRequestCaptureState = { status: 'idle' };

interface SidebarProps {
  isOpen: boolean;
  isOverlay?: boolean;
  onToggle: () => void;
  subagentState: SubagentListState;
  onRefreshSubagents: () => void;
  selectedSubagentId: string | null;
  onSelectSubagent: (id: string | null) => void;
  onOpenSubagentView?: (id?: string) => void;
  getSubagentDetail: (id: string) => SubagentDetail | null;
  todoState: TodoListState;
  onRefreshTodos: () => void;
  /** Session-wide background command fleet (main + subagent scopes). */
  commandsState: BackgroundCommandsState;
  onRefreshCommands: () => void;
  /** Per-session captured provider requests (debug inspector section). */
  requestsState?: DebugRequestsListState;
  onRefreshRequests?: () => void;
  selectedRequestId?: string | null;
  onSelectRequest?: (attemptId: string | null) => void;
  requestCapture?: DebugRequestCaptureState;
  onRetryRequestCapture?: () => void;
  /** Active session the command widgets resolve visibility and controls against. */
  sessionId: string | null;
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
  streamingThinkingChars?: number;
  /**
   * Command-palette navigation target (section slug). When set, opens the
   * matching collapse and scrolls it into view, then parent should clear.
   */
  focusSection?: string | null;
  onFocusSectionConsumed?: () => void;
}

export const Sidebar = memo(function Sidebar({
  isOpen,
  isOverlay = false,
  onToggle,
  subagentState,
  onRefreshSubagents,
  selectedSubagentId,
  onSelectSubagent,
  onOpenSubagentView = () => {},
  getSubagentDetail,
  todoState,
  onRefreshTodos,
  commandsState,
  onRefreshCommands,
  requestsState = EMPTY_REQUESTS_LIST,
  onRefreshRequests = () => {},
  selectedRequestId = null,
  onSelectRequest = () => {},
  requestCapture = EMPTY_REQUEST_CAPTURE,
  onRetryRequestCapture = () => {},
  sessionId = null,
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
  streamingThinkingChars,
  focusSection = null,
  onFocusSectionConsumed,
}: SidebarProps) {
  // Inspector toggle (Mod+B) is owned by ChatView via the central shortcut registry.
  const [forcedSection, setForcedSection] = useState<string | null>(null);
  /** Bumps on every palette navigate so same-section re-nav re-opens after collapse. */
  const [forceOpenEpoch, setForceOpenEpoch] = useState(0);
  const runningSubagentCount = subagentState.status === 'ready'
    ? countRunningSubagents(subagentState.subagents)
    : 0;
  const runningCommandCount = commandsState.status === 'ready'
    ? countRunningCommands(commandsState.commands)
    : 0;
  const debugRequests = requestsState.status === 'ready' ? requestsState.requests : [];
  const debugRequestOrigins = useMemo(
    () => countRequestAgentOrigins(debugRequests),
    [debugRequests],
  );

  useEffect(() => {
    if (!focusSection) return;
    const sectionId = resolveInspectorSectionId(focusSection);
    setForcedSection(sectionId);
    setForceOpenEpoch((epoch) => nextForceOpenEpoch(epoch));
    onFocusSectionConsumed?.();
    requestAnimationFrame(() => {
      document
        .getElementById(`${sectionId}-trigger`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [focusSection, onFocusSectionConsumed]);

  if (!isOpen) {
    return (
      <aside
        className="right-panel right-panel-collapsed bg-base-200"
        aria-label="Inspector"
      >
        <IconButton
          label={`Expand inspector (${formatShortcut('inspector.toggle')})`}
          icon="chevronLeft"
          size="sm"
          onClick={onToggle}
          aria-expanded={false}
          aria-controls="right-sidebar-body"
        />
      </aside>
    );
  }

  return (
    <aside
      className={isOverlay ? 'right-panel right-panel-overlay orchid-view-enter bg-base-200' : 'right-panel bg-base-200'}
      aria-label="Inspector"
    >
      <div id="right-sidebar-body" className="panel-body">
        <div className="right-panel-toolbar">
          <IconButton
            label={`Collapse inspector (${formatShortcut('inspector.toggle')})`}
            icon="chevronRight"
            size="sm"
            onClick={onToggle}
            aria-expanded
            aria-controls="right-sidebar-body"
          />
        </div>
        <CollapseBlock
          title="Todos"
          sectionId="inspector-todos"
          forceOpenToken={forcedSection === 'inspector-todos' ? forceOpenEpoch : 0}
        >
          <TodosSection state={todoState} onRefresh={onRefreshTodos} />
        </CollapseBlock>

        <CollapseBlock
          title="Subagents"
          sectionId="inspector-subagents"
          forceOpenToken={forcedSection === 'inspector-subagents' ? forceOpenEpoch : 0}
          leadingAction={
            <IconButton
              label="Open Subagent View"
              tooltip="Open Subagent View"
              icon="maximize"
              size="xs"
              variant="ghost"
              className="shrink-0"
              onClick={() => onOpenSubagentView()}
            />
          }
          badge={
            runningSubagentCount > 0 ? (
              <StatusBadge tone="success" size="xs">{runningSubagentCount}</StatusBadge>
            ) : null
          }
        >
          <SubagentsSection
            state={subagentState}
            onRefresh={onRefreshSubagents}
            selectedId={selectedSubagentId}
            onSelect={onSelectSubagent}
            getDetail={getSubagentDetail}
            onOpenView={onOpenSubagentView}
          />
        </CollapseBlock>

        <CollapseBlock
          title="Commands"
          sectionId="inspector-commands"
          forceOpenToken={forcedSection === 'inspector-commands' ? forceOpenEpoch : 0}
          badge={
            runningCommandCount > 0 ? (
              <StatusBadge tone="success" size="xs">{runningCommandCount}</StatusBadge>
            ) : null
          }
        >
          <CommandsSection
            state={commandsState}
            onRefresh={onRefreshCommands}
            sessionId={sessionId}
          />
        </CollapseBlock>

        <CollapseBlock
          title="Context"
          sectionId="inspector-context"
          defaultOpen
          forceOpenToken={forcedSection === 'inspector-context' ? forceOpenEpoch : 0}
          badge={<ContextBadge usage={usage} maxContext={maxContext} />}
        >
          <ContextGrid messages={messages} usage={usage} maxContext={maxContext} streamingThinkingChars={streamingThinkingChars} />
        </CollapseBlock>

        <CollapseBlock
          title="Usage"
          sectionId="inspector-usage"
          forceOpenToken={forcedSection === 'inspector-usage' ? forceOpenEpoch : 0}
        >
          <TokenUsageSection cumulativeUsage={cumulativeUsage} maxContext={maxContext} />
        </CollapseBlock>

        <CollapseBlock
          title="Workspace Index"
          sectionId="inspector-index"
          forceOpenToken={forcedSection === 'inspector-index' ? forceOpenEpoch : 0}
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

        <CollapseBlock
          title="MCP Servers"
          sectionId="inspector-mcp"
          defaultOpen
          forceOpenToken={forcedSection === 'inspector-mcp' ? forceOpenEpoch : 0}
          badge={<MCPStatusBadges servers={mcpServers} />}
        >
          <MCPSection servers={mcpServers} />
        </CollapseBlock>

        <CollapseBlock
          title="Requests"
          sectionId="inspector-requests"
          forceOpenToken={forcedSection === 'inspector-requests' ? forceOpenEpoch : 0}
          badge={
            debugRequests.length > 0
              ? <RequestsBadge count={debugRequests.length} origins={debugRequestOrigins} />
              : null
          }
        >
          <RequestsSection
            state={requestsState}
            onRefresh={onRefreshRequests}
            selectedId={selectedRequestId}
            onSelect={onSelectRequest}
            capture={requestCapture}
            onRetryCapture={onRetryRequestCapture}
          />
        </CollapseBlock>
      </div>
    </aside>
  );
});

// ── Mock-style Collapse Block ───────────────────────────────────────────────

interface CollapseBlockProps {
  title: string;
  sectionId: string;
  defaultOpen?: boolean;
  leadingAction?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  /**
   * Non-zero token from palette navigation; each new token re-opens even when
   * the same section is targeted again after the user collapsed it.
   */
  forceOpenToken?: number;
  onOpenChange?: (open: boolean) => void;
}

function CollapseBlock({
  title,
  sectionId,
  defaultOpen = false,
  leadingAction,
  badge,
  children,
  forceOpenToken = 0,
  onOpenChange,
}: CollapseBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = `${sectionId}-content`;

  // One-shot open from palette navigation; user can still collapse afterward.
  useEffect(() => {
    if (shouldOpenCollapseFromToken(forceOpenToken)) setOpen(true);
  }, [forceOpenToken]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div className="mock-collapse" data-inspector-section={sectionId}>
      <div className="flex min-w-0 items-center">
        {leadingAction ? <div className="shrink-0 pl-1">{leadingAction}</div> : null}
        <button
          className="mock-collapse-title flex min-w-0 flex-1 items-center justify-between gap-1.5"
          onClick={toggle}
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          id={`${sectionId}-trigger`}
        >
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="truncate">{title}</span>
            {badge}
          </span>
          <Icon
            name="chevronDown"
            size={12}
            className={`orchid-disclosure-chevron shrink-0 text-base-content/40 ${open ? 'is-open' : ''}`}
          />
        </button>
      </div>
      <CollapsibleRegion open={open} id={contentId}>
        <div
          className="mock-collapse-content"
          role="region"
          aria-labelledby={`${sectionId}-trigger`}
        >
          {children}
        </div>
      </CollapsibleRegion>
    </div>
  );
}

// ── Subagents Section ────────────────────────────────────────────────────────

export interface SubagentStatusGroups {
  running: readonly SubagentSummary[];
  queued: readonly SubagentSummary[];
  other: readonly SubagentSummary[];
}

/** Keep active work visible while putting terminal subagents behind a menu. */
export function partitionSubagentsByStatus(
  agents: readonly SubagentSummary[],
): SubagentStatusGroups {
  const { running, queued, ended } = groupSubagents(agents);
  return { running, queued, other: ended };
}

export function countRunningSubagents(agents: readonly SubagentSummary[]): number {
  return partitionSubagentsByStatus(agents).running.length;
}

interface SubagentsSectionProps {
  state: SubagentListState;
  onRefresh: () => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  getDetail: (id: string) => SubagentDetail | null;
  onOpenView?: (id?: string) => void;
}

export function SubagentsSection({
  state,
  onRefresh,
  selectedId,
  onSelect,
  getDetail,
  onOpenView = () => {},
}: SubagentsSectionProps) {
  if (state.status === 'loading') {
    return <StateMessage kind="loading" className="inspector-empty py-4" title="Loading subagents…" />;
  }

  if (state.status === 'error') {
    return (
      <StateMessage
        kind="error"
        className="inspector-empty py-4"
        title={state.error}
        action={
          <Button variant="ghost" size="xs" onClick={onRefresh}>
            Retry
          </Button>
        }
      />
    );
  }

  if (state.status === 'empty') {
    return (
      <StateMessage
        kind="empty"
        className="inspector-empty py-4"
        title="No active subagents"
      />
    );
  }

  const agents = state.status === 'ready' ? state.subagents : [];
  const { running, queued, other } = partitionSubagentsByStatus(agents);

  return (
    <div className="inspector-stack">
      {[...running, ...queued].map((agent) => (
        <SubagentRow
          key={agent.id}
          agent={agent}
          selectedId={selectedId}
          onSelect={onSelect}
          getDetail={getDetail}
          onOpenView={onOpenView}
        />
      ))}
      {other.length > 0 && (
        <DropdownMenu
          label={`Show ${other.length} other ${other.length === 1 ? 'agent' : 'agents'}`}
          placement="bottom-start"
          className="w-full orchid-subagent-dropdown-flow"
          triggerClassName="btn btn-ghost btn-xs h-7 min-h-7 w-full justify-between px-1.5 font-normal text-left"
          menuClassName="w-full max-h-64 overflow-y-auto rounded-box border border-base-300 bg-base-200 p-1 shadow-lg"
          trigger={
            <span className="inline-flex w-full items-center justify-between gap-2">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Icon name="chevronDown" size={12} className="shrink-0 opacity-60" />
                <span className="truncate">Other agents</span>
              </span>
              <StatusBadge tone="neutral" size="xs" outline>
                {other.length}
              </StatusBadge>
            </span>
          }
        >
          <div className="inspector-stack gap-0" role="presentation">
            {other.map((agent) => (
              <SubagentRow
                key={agent.id}
                agent={agent}
                selectedId={selectedId}
                onSelect={onSelect}
                getDetail={getDetail}
                onOpenView={onOpenView}
                inMenu
              />
            ))}
          </div>
        </DropdownMenu>
      )}
    </div>
  );
}

interface SubagentRowProps {
  agent: SubagentSummary;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  getDetail: (id: string) => SubagentDetail | null;
  onOpenView: (id?: string) => void;
  inMenu?: boolean;
}

function SubagentRow({
  agent,
  selectedId,
  onSelect,
  getDetail,
  onOpenView,
  inMenu = false,
}: SubagentRowProps) {
  const detail = getDetail(agent.id);
  // Mock-style compact row: mono name + status badge
  const name = detail?.name || agent.agent_name || 'Subagent';
  const agentState = detail?.state || agent.status;
  const isSelected = selectedId === agent.id;
  const usage = detail?.usage;

  return (
    <div className="inspector-stack gap-0">
      <div className={`inspector-row inspector-subagent-row rounded py-1 pr-0.5 ${isSelected ? 'inspector-row-active' : ''}`}>
        <IconButton
          label={`Open ${name} in Subagent View`}
          tooltip="Open in Subagent View"
          icon="maximize"
          size="xs"
          variant="ghost"
          className="shrink-0"
          role={inMenu ? 'menuitem' : undefined}
          onClick={() => onOpenView(agent.id)}
        />
        <button
          type="button"
          role={inMenu ? 'menuitem' : undefined}
          className="flex min-w-0 flex-1 items-center justify-between gap-1 bg-transparent text-left"
          onClick={() => onSelect(isSelected ? null : agent.id)}
        >
          <span className="inspector-row-label mono truncate">{name}</span>
          <SubagentStateBadge state={agentState} />
        </button>
      </div>
      {isSelected && (
        <div className="inspector-subagent-detail">
          {detail?.elapsed && (
            <div className="subtle">
              elapsed {detail.elapsed}{detail.type ? ` · ${detail.type}` : ''} · {detail.tier}
            </div>
          )}
          {usage && (
            <div className="subtle mono">
              {formatUsageSummary(usage)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SubagentStateBadge({ state }: { state: string }) {
  const config: Record<string, { tone: 'neutral' | 'warning' | 'success' | 'error' | 'info'; label: string }> = {
    queued: { tone: 'neutral', label: 'queued' },
    pending: { tone: 'neutral', label: 'pending' },
    running: { tone: 'warning', label: 'running' },
    completed: { tone: 'success', label: 'done' },
    failed: { tone: 'error', label: 'failed' },
    interrupted: { tone: 'info', label: 'interrupted' },
  };

  const { tone, label } = config[state] ?? { tone: 'neutral' as const, label: state };

  return <StatusBadge tone={tone} size="xs">{label}</StatusBadge>;
}

// ── Todos Section ────────────────────────────────────────────────────────────

interface TodosSectionProps {
  state: TodoListState;
  onRefresh: () => void;
}

function TodosSection({ state }: TodosSectionProps) {
  if (state.status === 'loading') {
    return <StateMessage kind="loading" className="inspector-empty py-4" title="Loading todos…" />;
  }

  if (state.status === 'error') {
    return <StateMessage kind="error" className="inspector-empty py-4" title={state.error} />;
  }

  if (state.status === 'empty') {
    return <StateMessage kind="empty" className="inspector-empty py-4" title="No todos" />;
  }

  const todos = state.status === 'ready' ? state.todos : [];

  return (
    <div className="inspector-stack">
      {todos.map((todo) => (
        <div key={todo.id} className="inspector-row">
          <StatusBadge
            tone={
              todo.status === TodoStatus.DONE
                ? 'success'
                : todo.status === TodoStatus.IN_PROGRESS
                  ? 'warning'
                  : 'neutral'
            }
            size="xs"
            withDot
          >
            {todo.status === TodoStatus.DONE
              ? 'done'
              : todo.status === TodoStatus.IN_PROGRESS
                ? 'active'
                : 'todo'}
          </StatusBadge>
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
          <Button
            variant="ghost"
            size="xs"
            disabled={!onIndexRAG || indexingRag}
            onClick={() => void runIndex('rag')}
            title="Index project for RAG semantic search"
          >
            {indexingRag ? (
              <Spinner size="xs" />
            ) : (
              'RAG'
            )}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!onIndexAST || indexingAst}
            onClick={() => void runIndex('ast')}
            title="Re-scan project for AST symbols"
          >
            {indexingAst ? (
              <Spinner size="xs" />
            ) : (
              'AST'
            )}
          </Button>
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
    return <div className="subtle orchid-state-enter">Indexing…</div>;
  }
  if (progress.total === 0) {
    return (
      <div className="subtle orchid-state-enter">
        {progress.phase === 'discovering' ? 'Scanning project…' : 'Indexing…'}
      </div>
    );
  }
  return (
    <div className="inspector-stack orchid-state-enter gap-0">
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
    return <StatusBadge tone="neutral" size="xs" outline>empty</StatusBadge>;
  }
  if (hasRag && hasAst) {
    return <StatusBadge tone="success" size="xs">ready</StatusBadge>;
  }
  return <StatusBadge tone="warning" size="xs">partial</StatusBadge>;
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
  tone: 'success' | 'warning' | 'error' | 'neutral';
  label: string;
}[] = [
  { status: 'connected', tone: 'success', label: 'connected' },
  { status: 'starting', tone: 'warning', label: 'starting' },
  { status: 'failed', tone: 'error', label: 'failed' },
  { status: 'unavailable', tone: 'neutral', label: 'unavailable' },
];

function MCPStatusBadges({ servers }: MCPSectionProps) {
  const counts = countMCPServerStatuses(servers);

  return (
    <span className="inline-flex shrink-0 items-center gap-1" aria-label="MCP server status counts">
      {MCP_STATUS_BADGES.filter(({ status }) => counts[status] > 0).map(({ status, tone, label }) => (
        <StatusBadge
          key={status}
          tone={tone}
          size="xs"
          outline={tone === 'neutral'}
          title={`${counts[status]} ${label} MCP ${counts[status] === 1 ? 'server' : 'servers'}`}
          aria-label={`${counts[status]} ${label} MCP ${counts[status] === 1 ? 'server' : 'servers'}`}
        >
          {counts[status]}
        </StatusBadge>
      ))}
    </span>
  );
}

function MCPSection({ servers }: MCPSectionProps) {
  if (servers.length === 0) {
    return (
      <StateMessage kind="empty" className="inspector-empty py-4" title="No MCP servers configured" />
    );
  }

  return (
    <div className="inspector-stack">
      {servers.map((server) => (
        <div key={server.name} className="inspector-stack gap-0">
          <div className="inspector-row">
            <span className="inspector-row-label truncate">{server.name}</span>
            {server.status === 'connected' ? (
              <StatusBadge tone="success" size="xs" className="shrink-0">
                {server.toolCount > 0 ? `${server.toolCount} tools` : 'connected'}
              </StatusBadge>
            ) : server.status === 'starting' ? (
              <StatusBadge tone="warning" size="xs" className="shrink-0">starting</StatusBadge>
            ) : server.status === 'failed' ? (
              <StatusBadge tone="error" size="xs" className="shrink-0">failed</StatusBadge>
            ) : (
              <StatusBadge tone="neutral" size="xs" outline className="shrink-0">
                {server.status}
              </StatusBadge>
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
  const pct = getContextPercent(usage, maxContext);
  if (pct != null) {
    const tone = pct >= 85 ? 'error' : pct >= 60 ? 'warning' : pct > 0 ? 'info' : 'neutral';
    return (
      <StatusBadge tone={tone} size="xs" outline={tone === 'neutral'}>
        {pct}%
      </StatusBadge>
    );
  }
  const used = contextUsedTokens(usage);
  if (used > 0) {
    return (
      <StatusBadge
        tone="neutral"
        size="xs"
        outline
        title="Context window is still loading"
      >
        {formatCompactCount(used)}
      </StatusBadge>
    );
  }
  return <StatusBadge tone="neutral" size="xs" outline>0%</StatusBadge>;
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
  const reasoning = cumulativeUsage?.reasoning_tokens ?? 0;

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
      {reasoning > 0 && (
        <div className="inspector-row">
          <strong>Reasoning</strong>
          <span className="subtle">{formatTokenCount(reasoning)}</span>
        </div>
      )}
    </div>
  );
}

/** Same compact formatting as ContextGrid (e.g. 1.2k, 1.5M). */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ── Requests Section (debug captures) ────────────────────────────────────────

const REQUEST_OUTCOME_CONFIG: Readonly<
  Record<DebugRequestSummary['outcome'], { tone: 'neutral' | 'success' | 'warning' | 'error'; label: string }>
> = {
  pending: { tone: 'neutral', label: 'pending' },
  succeeded: { tone: 'success', label: 'ok' },
  failed: { tone: 'error', label: 'failed' },
  interrupted: { tone: 'warning', label: 'interrupted' },
};

/** Header count; flags multi-origin sessions (main + subagents/internals). */
function RequestsBadge({ count, origins }: { count: number; origins: number }) {
  return (
    <StatusBadge tone="neutral" size="xs" outline>
      {origins > 1 ? `${count} · ${origins} agents` : count}
    </StatusBadge>
  );
}

interface RequestsSectionProps {
  state: DebugRequestsListState;
  onRefresh: () => void;
  selectedId: string | null;
  onSelect: (attemptId: string | null) => void;
  capture: DebugRequestCaptureState;
  onRetryCapture: () => void;
}

function RequestsSection({
  state,
  onRefresh,
  selectedId,
  onSelect,
  capture,
  onRetryCapture,
}: RequestsSectionProps) {
  if (state.status === 'loading') {
    return <StateMessage kind="loading" className="inspector-empty py-4" title="Loading requests…" />;
  }

  if (state.status === 'error') {
    return (
      <StateMessage
        kind="error"
        className="inspector-empty py-4"
        title={state.error}
        action={
          <Button variant="ghost" size="xs" onClick={onRefresh}>
            Retry
          </Button>
        }
      />
    );
  }

  if (state.status === 'empty') {
    return (
      <StateMessage className="inspector-empty py-4" kind="empty" title="No captured requests">
        enable debug_capture_requests in settings.
      </StateMessage>
    );
  }

  // Newest attempt first; unparseable timestamps keep their arrival order.
  const requests = [...state.requests].sort((a, b) => {
    const left = Date.parse(a.startedAt);
    const right = Date.parse(b.startedAt);
    if (Number.isNaN(left) || Number.isNaN(right)) return 0;
    return right - left;
  });

  return (
    <div className="inspector-stack">
      {requests.map((request) => (
        <RequestRow
          key={request.attemptId}
          request={request}
          selectedId={selectedId}
          onSelect={onSelect}
          capture={capture}
          onRetryCapture={onRetryCapture}
        />
      ))}
    </div>
  );
}

interface RequestRowProps {
  request: DebugRequestSummary;
  selectedId: string | null;
  onSelect: (attemptId: string | null) => void;
  capture: DebugRequestCaptureState;
  onRetryCapture: () => void;
}

function RequestRow({ request, selectedId, onSelect, capture, onRetryCapture }: RequestRowProps) {
  // Mock-style compact row: mono agent + outcome badge, model + time + tokens.
  const isSelected = selectedId === request.attemptId;
  const scope = request.agentScope || 'main';
  const tokens = formatRequestTokens(request);

  return (
    <div className="inspector-stack gap-0">
      <button
        type="button"
        className={`inspector-row inspector-subagent-row rounded py-1 pr-0.5 ${isSelected ? 'inspector-row-active' : ''}`}
        onClick={() => onSelect(isSelected ? null : request.attemptId)}
      >
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="inspector-row-label mono truncate" title={request.agentName || scope}>
              {request.agentName || scope}
            </span>
            {scope !== 'main' && (
              <StatusBadge tone="info" size="xs" className="max-w-24 shrink-0 truncate" title={scope}>
                {scope}
              </StatusBadge>
            )}
            {request.truncated && (
              <span className="subtle shrink-0 text-xs" title="A capture field exceeded the byte cap">
                trunc
              </span>
            )}
          </span>
          <span className="inspector-row-label subtle truncate" title={request.modelId}>
            {request.modelId}
          </span>
        </span>
        <span className="inline-flex shrink-0 flex-col items-end gap-0.5">
          <RequestOutcomeBadge outcome={request.outcome} />
          <span className="subtle mono whitespace-nowrap" title={request.startedAt}>
            {formatRelativeTime(request.startedAt)}
            {tokens ? ` · ${tokens}` : ''}
          </span>
        </span>
      </button>
      {isSelected && (
        <RequestDetail summary={request} capture={capture} onRetry={onRetryCapture} />
      )}
    </div>
  );
}

function RequestOutcomeBadge({ outcome }: { outcome: DebugRequestSummary['outcome'] }) {
  const { tone, label } = REQUEST_OUTCOME_CONFIG[outcome];
  return (
    <StatusBadge tone={tone} size="xs" withDot outline={tone === 'neutral'}>
      {label}
    </StatusBadge>
  );
}

/** Compact in/out pair (e.g. `1.2k→300`); empty while the attempt is pending. */
function formatRequestTokens(request: DebugRequestSummary): string {
  if (request.inputTokens == null && request.outputTokens == null) return '';
  const input = request.inputTokens != null ? formatTokenCount(request.inputTokens) : '–';
  const output = request.outputTokens != null ? formatTokenCount(request.outputTokens) : '–';
  return `${input}→${output}`;
}

function formatRequestClockTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

function formatRequestDuration(request: DebugRequestSummary): string | null {
  const start = new Date(request.startedAt).getTime();
  const end = request.completedAt ? new Date(request.completedAt).getTime() : Number.NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const seconds = Math.max(0, (end - start) / 1000);
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

interface RequestDetailProps {
  summary: DebugRequestSummary;
  capture: DebugRequestCaptureState;
  onRetry: () => void;
}

function RequestDetail({ summary, capture, onRetry }: RequestDetailProps) {
  const duration = formatRequestDuration(summary);

  return (
    <div className="inspector-subagent-detail">
      <div className="inspector-row">
        <span className="subtle">outcome</span>
        <RequestOutcomeBadge outcome={summary.outcome} />
      </div>
      <div className="inspector-row">
        <span className="subtle">model</span>
        <span
          className="inspector-row-label mono truncate text-right"
          title={`${summary.connectionName} · ${summary.providerId} · ${summary.protocol}`}
        >
          {summary.modelId}
        </span>
      </div>
      {summary.agentTier && (
        <div className="inspector-row">
          <span className="subtle">tier</span>
          <span className="subtle">{summary.agentTier}</span>
        </div>
      )}
      <div className="inspector-row">
        <span className="subtle">started</span>
        <span className="subtle mono">{formatRequestClockTime(summary.startedAt)}</span>
      </div>
      {duration && (
        <div className="inspector-row">
          <span className="subtle">duration</span>
          <span className="subtle mono">{duration}</span>
        </div>
      )}
      {(summary.inputTokens != null || summary.outputTokens != null) && (
        <div className="inspector-row">
          <span className="subtle">tokens</span>
          <span className="subtle mono">{formatRequestTokens(summary) || '–'}</span>
        </div>
      )}
      {(summary.requestBytes != null || summary.responseBytes != null) && (
        <div className="inspector-row">
          <span className="subtle">bytes</span>
          <span className="subtle mono">
            {summary.requestBytes != null ? formatCompactCount(summary.requestBytes) : '–'}
            {' / '}
            {summary.responseBytes != null ? formatCompactCount(summary.responseBytes) : '–'}
          </span>
        </div>
      )}
      {summary.error && (
        <div className="subtle text-error break-words" title={summary.error}>
          {summary.error}
        </div>
      )}
      <RequestCapturePane summary={summary} capture={capture} onRetry={onRetry} />
    </div>
  );
}

// ── Requests capture panes ───────────────────────────────────────────────────

/** Cap the rendered string; multi-MB payloads must not hit the DOM in full. */
const MAX_RENDER_CHARS = 500_000;

function prettyPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface RequestCapturePaneProps {
  summary: DebugRequestSummary;
  capture: DebugRequestCaptureState;
  onRetry: () => void;
}

function RequestCapturePane({ summary, capture, onRetry }: RequestCapturePaneProps) {
  const [tab, setTab] = useState('request');

  if (capture.status === 'idle') return null;

  if (capture.status === 'loading') {
    return <div className="subtle">Loading capture…</div>;
  }

  if (capture.status === 'error') {
    return (
      <div className="inspector-stack gap-1">
        <div className="subtle text-error break-words">{capture.error}</div>
        <div>
          <Button variant="ghost" size="xs" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (capture.status === 'unavailable') {
    return (
      <div className="subtle">
        {summary.outcome === 'pending'
          ? 'Capture pending — loads when the attempt settles.'
          : 'Capture unavailable for this attempt.'}
      </div>
    );
  }

  const hasRaw = capture.capture.rawChunks.length > 0;
  const activeTab = tab === 'raw' && !hasRaw ? 'request' : tab;
  const items: TabItem[] = [
    { id: 'request', label: 'Request' },
    { id: 'response', label: 'Response' },
    ...(hasRaw ? [{ id: 'raw' as const, label: 'Raw chunks' }] : []),
  ];
  const value = activeTab === 'request'
    ? capture.capture.request
    : activeTab === 'response'
      ? capture.capture.response
      : capture.capture.rawChunks;

  return (
    <CaptureTabs
      items={items}
      activeTab={activeTab}
      onSelectTab={setTab}
      value={value}
    />
  );
}

interface CaptureTabsProps {
  items: readonly TabItem[];
  activeTab: string;
  onSelectTab: (id: string) => void;
  value: unknown;
}

function CaptureTabs({ items, activeTab, onSelectTab, value }: CaptureTabsProps) {
  // Pretty-print once per payload; the full string backs the copy action.
  const text = useMemo(() => prettyPayload(value), [value]);

  return (
    <div className="inspector-stack">
      <div className="flex items-center justify-between gap-1 pt-0.5">
        <Tabs
          items={items}
          value={activeTab}
          onValueChange={onSelectTab}
          className="min-w-0 flex-1"
          itemClassName="flex-1 text-xs"
        />
        <CopyPayloadButton text={text} />
      </div>
      <PayloadPane text={text} />
    </div>
  );
}

function CopyPayloadButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the selection path still works.
    }
  };

  return (
    <IconButton
      label={copied ? 'Copied' : 'Copy payload'}
      tooltip={copied ? 'Copied' : 'Copy payload'}
      icon="copy"
      size="xs"
      variant="ghost"
      className="shrink-0"
      onClick={() => void copy()}
    />
  );
}

function PayloadPane({ text }: { text: string }) {
  const truncatedForDisplay = text.length > MAX_RENDER_CHARS;
  const shown = truncatedForDisplay ? text.slice(0, MAX_RENDER_CHARS) : text;

  return (
    <div className="inspector-stack gap-0">
      <pre className="orchid-tool-result-selectable m-0 max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-base-300 bg-base-100 p-2 font-mono text-xs leading-relaxed text-base-content/80">
        {shown.length > 0 ? shown : '(empty payload)'}
      </pre>
      {truncatedForDisplay && (
        <div className="subtle text-xs">(truncated for display — use copy for full payload)</div>
      )}
    </div>
  );
}
