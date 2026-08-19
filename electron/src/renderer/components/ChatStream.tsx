/**
 * ChatStream — scrollable message stream with smart auto-scroll.
 *
 * Display order is chronological (call/send order), not a fixed
 * tools-then-assistant layout. A single turn may interleave freely:
 *   user → tool → message → tool → tool → message → …
 *
 * Multi-chain: one footer per session chain (model · usage · elapsed).
 * Live stream segments (while streaming) continue after committed history.
 */
import { useRef, useEffect, useCallback, useState, useMemo, type ReactNode } from 'react';
import type { Chain } from '../../shared/types/chain';
import type { Message, Usage } from '../../shared/types/message';
import { EMPTY_SUBAGENT_USAGE_SUMMARY, type SubagentUsageSummary } from '../../shared/usage';
import {
  useElapsedSeconds,
  type ChatStatus,
  type StreamSegment,
  type ToolBlock,
} from '../hooks/useChat';
import type { SubagentTitleRecord } from '../utils/tool-title';
import {
  suppressLiveMessagesAlreadyInHistory,
  foldStreamActivityGroups,
  buildHistoryStreamItems,
  buildLiveTailItems,
  type StreamItem,
} from '../utils/stream-building';
import { MessageWidget } from './MessageWidget';
import { ChainFooter } from './ChainFooter';
import { CollapsedChainStub } from './CollapsedChainStub';
import { ErrorBanner } from './ErrorBanner';
import { ToolCallBlock } from './ToolCallBlock';
import { ToolActivityGroup } from './ToolActivityGroup';
import { Icon } from './Icon';
import { Button } from './ui/Button';
import orchidIcon from '../assets/orchid-icon.svg';
import { useSmartAutoScroll } from '../hooks/useSmartAutoScroll';
import { shouldAutoScroll } from '../hooks/useSmartAutoScroll';
import { CompactionRunningWidget, CompactionWidget, CompactedRangeStub } from './ToolResults/CompactionWidget';

export { AUTO_SCROLL_THRESHOLD_PX, isUserScrolledAwayFromBottom, shouldAutoScroll } from '../hooks/useSmartAutoScroll';
export { CHAIN_COLLAPSE_THRESHOLD, shouldRenderChainFooter, suppressLiveMessagesAlreadyInHistory } from '../utils/stream-building';

/** Live tool arguments belong to the cheap tail, not the committed-history memo. */
const NO_TOOL_BLOCKS: ToolBlock[] = [];
const NO_SUBAGENTS: readonly SubagentTitleRecord[] = [];
const NO_SESSION_CHAINS: readonly Chain[] = [];

interface ChatStreamProps {
  /** Whether the chat surface is currently available for presentation work. */
  isVisible?: boolean;
  messages: Message[];
  streamingContent: string;
  toolBlocks: ToolBlock[];
  /** Chronological live segments for the in-flight turn (tool/text/thinking). */
  streamSegments?: readonly StreamSegment[];
  /** Monotonic live-state revision used for bounded auto-scroll updates. */
  streamRevision: number;
  status: ChatStatus;
  error: string | null;
  usage: Usage | null;
  /**
   * In-flight turn usage (null between turns). Preferred for the active chain
   * footer while streaming so counters update mid-turn without flashing the
   * previous turn's totals.
   */
  currentTurnUsage?: Usage | null;
  /**
   * Low-frequency subagent usage summary — feeds the footer `sub:` line
   * (attributed via parentChainIndex when possible). This is the only
   * subagent-derived input to the history memo; its identity changes only
   * when the underlying usage numbers change.
   */
  subagentUsage?: SubagentUsageSummary;
  /**
   * Active-session subagent title records (id/name/type) for tool titles —
   * wait/interrupt chips resolve subagent names here. Never read by the
   * history build.
   */
  subagents?: readonly SubagentTitleRecord[];
  /** Session chains (same order as storage) for parent_chain_index attribution. */
  sessionChains?: readonly Chain[];
  /** Active session id — used to reset collapse expansion only on session switch. */
  sessionId?: string | null;
  onClearError: () => void;
  onOpenSettings?: () => void;
  /** When true, empty state prompts for a project folder (R3). */
  workspaceUnbound?: boolean;
  onPickProjectDir?: () => void;
  onRetry?: () => void;
  /**
   * Stream start (ms epoch). Active-chain footer ticks elapsed locally at 1s
   * so history memos are not invalidated by a wall-clock ticker.
   */
  streamStartTime?: number | null;
  interrupted?: boolean;
  /**
   * When true, tool-activity groups start expanded (Settings → Always expand
   * tool groups). Default false.
   */
  alwaysExpandToolGroups?: boolean;
  /** Hydrate the next older bounded page for a chain. */
  onLoadHistoryPage?: (chainIndex: number) => Promise<unknown> | void;
}

/**
 * Render the main transcript while deferring scroll listeners, elapsed timers,
 * and follow-latest transitions whenever its surface is hidden.
 */
export function ChatStream({
  isVisible = true,
  messages,
  streamingContent,
  toolBlocks,
  streamSegments = [],
  streamRevision,
  status,
  error,
  onClearError,
  onOpenSettings,
  workspaceUnbound = false,
  onPickProjectDir,
  onRetry,
  usage,
  currentTurnUsage = null,
  subagentUsage = EMPTY_SUBAGENT_USAGE_SUMMARY,
  subagents = NO_SUBAGENTS,
  sessionChains = NO_SESSION_CHAINS,
  sessionId = null,
  streamStartTime = null,
  interrupted,
  alwaysExpandToolGroups = false,
  onLoadHistoryPage,
}: ChatStreamProps) {
  const {
    containerRef,
    isUserScrolledUp,
    followLatest,
    jumpToLatest,
  } = useSmartAutoScroll({
    resetKey: sessionId,
    contentKey: `${messages.length}:${streamRevision}`,
    enabled: isVisible,
  });
  /** Chain indexes the user expanded from a collapsed stub. */
  const [expandedChainIndexes, setExpandedChainIndexes] = useState<Set<number>>(
    () => new Set(),
  );
  /** Compacted-range stubs the user expanded — display-only, independent of persistence flags. */
  const [expandedCompactedKeys, setExpandedCompactedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [loadingHistoryChainIds, setLoadingHistoryChainIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Active footer only — never a history-memo dependency.
  const liveElapsedSeconds = useElapsedSeconds(
    streamStartTime,
    isVisible && status === 'streaming',
  );

  const expandChain = useCallback((chainIndex: number) => {
    setExpandedChainIndexes((prev) => {
      if (prev.has(chainIndex)) return prev;
      const next = new Set(prev);
      next.add(chainIndex);
      return next;
    });
    const chain = sessionChains[chainIndex];
    if (
      chain?.messagesLoaded === false
      && (chain.messageStartIndex ?? 0) > 0
      && onLoadHistoryPage
      && !loadingHistoryChainIds.has(chain.id)
    ) {
      setLoadingHistoryChainIds((prev) => new Set(prev).add(chain.id));
      void Promise.resolve()
        .then(() => onLoadHistoryPage(chainIndex))
        .catch(() => undefined)
        .finally(() => {
          setLoadingHistoryChainIds((prev) => {
            const next = new Set(prev);
            next.delete(chain.id);
            return next;
          });
        });
    }
  }, [sessionChains, onLoadHistoryPage, loadingHistoryChainIds]);

  const expandCompacted = useCallback((key: string) => {
    setExpandedCompactedKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  // When a new stream starts, pin to bottom only if the user was already near
  // the bottom. Do not force-scroll readers who scrolled away mid-history.
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (isVisible && status === 'streaming' && prev !== 'streaming') {
      if (shouldAutoScroll(isUserScrolledUp)) {
        followLatest();
      }
    }
  }, [status, isVisible, isUserScrolledUp, followLatest]);

  // Reset scroll-away + expanded stubs only when the session is replaced.
  useEffect(() => {
    setExpandedChainIndexes(new Set());
    setExpandedCompactedKeys(new Set());
    setLoadingHistoryChainIds(new Set());
  }, [sessionId]);

  // Committed history is independent of per-token stream text, live usage,
  // and wall-clock elapsed ticks. Keep it stable so long sessions do not
  // rebuild O(n) lists. The active footer receives live usage below.
  const historyUsage = status === 'streaming' ? null : usage;
  // Current-turn tool generation is rendered by the live tail. Excluding it
  // here keeps argument-only frame updates from rebuilding committed history.
  const historyToolBlocks = status === 'streaming' ? NO_TOOL_BLOCKS : toolBlocks;
  const history = useMemo(
    () =>
      buildHistoryStreamItems({
        messages,
        toolBlocks: historyToolBlocks,
        status,
        liveUsage: historyUsage,
        subagentUsage,
        sessionChains,
        interrupted: Boolean(interrupted),
        expandedChainIndexes,
        expandedCompactedKeys,
      }),
    [
      messages,
      historyToolBlocks,
      status,
      historyUsage,
      subagentUsage,
      sessionChains,
      interrupted,
      expandedChainIndexes,
      expandedCompactedKeys,
    ],
  );

  // Live tail only — recomputed per token / segment / tool status change.
  // Suppress text/thinking already present in history so SESSION_UPDATED
  // (chain commit) cannot flash a second bubble before CHAT_DONE clears segments.
  const liveItems = useMemo(
    () =>
      suppressLiveMessagesAlreadyInHistory(
        buildLiveTailItems({
          toolBlocks,
          streamSegments,
          streamingContent: status === 'streaming' ? streamingContent : '',
          status,
          emittedToolIds: history.emittedToolIds,
        }),
        history.items,
      ),
    [toolBlocks, streamSegments, streamingContent, status, history.emittedToolIds, history.items],
  );

  // Fold consecutive thoughts + explore tools into tool-only-titled activity groups.
  const historyItems = useMemo(
    () => foldStreamActivityGroups(history.items),
    [history.items],
  );
  const liveGroupedItems = useMemo(
    () => foldStreamActivityGroups(liveItems),
    [liveItems],
  );
  // Keep stable history nodes by identity across live-only frames. They still
  // participate in the same flat keyed sequence as the tail so a segment that
  // commits before CHAT_DONE retains its DOM node at the live→history boundary.
  const historyNodes = useMemo(
    () => historyItems.map((item) =>
      renderStreamItem(
        item,
        alwaysExpandToolGroups,
        expandChain,
        expandCompacted,
        loadingHistoryChainIds,
        subagents,
        sessionId,
      ),
    ),
    [historyItems, alwaysExpandToolGroups, expandChain, expandCompacted, loadingHistoryChainIds, subagents, sessionId],
  );
  const liveTailNodes = useMemo(
    () => liveGroupedItems.map((item) =>
      renderStreamItem(
        item,
        alwaysExpandToolGroups,
        expandChain,
        expandCompacted,
        loadingHistoryChainIds,
        subagents,
        sessionId,
      ),
    ),
    [liveGroupedItems, alwaysExpandToolGroups, expandChain, expandCompacted, loadingHistoryChainIds, subagents, sessionId],
  );
  const activeFooterNode = useMemo(() => {
    if (!history.activeFooter) return null;
    return renderStreamItem(
      {
        ...history.activeFooter,
        usage:
          status === 'streaming'
            ? currentTurnUsage ?? history.activeFooter.usage
            : history.activeFooter.usage,
        elapsedSeconds:
          status === 'streaming' && streamStartTime != null
            ? liveElapsedSeconds
            : undefined,
      },
      alwaysExpandToolGroups,
      expandChain,
      expandCompacted,
      loadingHistoryChainIds,
      subagents,
      sessionId,
    );
  }, [
    history.activeFooter,
    status,
    currentTurnUsage,
    streamStartTime,
    liveElapsedSeconds,
    alwaysExpandToolGroups,
    expandChain,
    expandCompacted,
    loadingHistoryChainIds,
    subagents,
    sessionId,
  ]);
  const streamNodes = useMemo(
    () => activeFooterNode
      ? [...historyNodes, ...liveTailNodes, activeFooterNode]
      : [...historyNodes, ...liveTailNodes],
    [historyNodes, liveTailNodes, activeFooterNode],
  );

  const hasPagedSessionHistory = sessionChains.some(
    (chain) => (chain.messageCount ?? chain.messages.length) > 0,
  );
  if (
    messages.length === 0 &&
    !hasPagedSessionHistory &&
    !streamingContent &&
    toolBlocks.length === 0 &&
    streamSegments.length === 0 &&
    status === 'idle' &&
    !error
  ) {
    return (
      <div className="orchid-chat-scroll flex min-h-0 flex-1 items-center justify-center px-6 py-5">
        <div className="orchid-chat-empty">
          <div className="orchid-chat-empty-icon" aria-hidden>
            <img src={orchidIcon} alt="" width={96} height={96} />
          </div>
          {workspaceUnbound ? (
            <>
              <div className="orchid-chat-empty-title">
                Choose a project folder
              </div>
              <div className="orchid-chat-empty-desc">
                Orchid needs a working directory before the agent can run tools
                or create sessions.
              </div>
              {onPickProjectDir && (
                <Button
                  variant="primary"
                  size="sm"
                  className="mt-3"
                  onClick={onPickProjectDir}
                >
                  <Icon name="folder" size={14} />
                  Open folder
                </Button>
              )}
            </>
          ) : (
            <>
              <div className="orchid-chat-empty-title">Welcome to Orchid</div>
              <div className="orchid-chat-empty-desc">
                Start a conversation by typing a message below.
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="orchid-chat-scroll px-6 py-5" ref={containerRef}>
        {/* History + live tail + active footer render as ONE keyed sequence.
            History nodes remain referentially stable across live-only frames,
            while the small tail/footer path updates independently. Keeping the
            final nodes flat lets React retain shared segment/footer keys across
            the live→committed swap instead of replaying entrance animation. */}
        {streamNodes}
        {error && (
          <div className="orchid-error-slot">
            <ErrorBanner
              message={error}
              onDismiss={onClearError}
              onOpenSettings={onOpenSettings}
              onRetry={onRetry}
            />
          </div>
        )}
      </div>
      {isUserScrolledUp ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="pointer-events-auto absolute bottom-4 right-6 z-10"
          onClick={jumpToLatest}
        >
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}

function renderStreamItem(
  item: StreamItem,
  alwaysExpandToolGroups: boolean,
  onExpandChain: (chainIndex: number) => void,
  onExpandCompacted: (key: string) => void,
  loadingHistoryChainIds: ReadonlySet<string>,
  subagents: readonly SubagentTitleRecord[],
  sessionId: string | null,
): ReactNode {
  if (item.kind === 'tool') {
    if (item.block.toolName === 'compaction' && item.block.status !== 'running' && item.block.status !== 'generating') {
      return null;
    }
    if (item.block.toolName === 'compaction' && (item.block.status === 'running' || item.block.status === 'generating')) {
      let phase: string | undefined;
      let mode: string | undefined;
      try {
        const parsed = JSON.parse(item.block.args || '{}');
        phase = typeof parsed.phase === 'string' ? parsed.phase : undefined;
        mode = typeof parsed.mode === 'string' ? parsed.mode : undefined;
      } catch {}
      return (
        <CompactionRunningWidget
          key={item.key}
          status={item.block.status}
          phase={phase}
          mode={mode}
          streamText={item.block.agentProjection}
          estimatedTokens={item.block.estimatedTokens}
        />
      );
    }
    return <ToolCallBlock key={item.key} block={item.block} subagents={subagents} sessionId={sessionId} />;
  }
  if (item.kind === 'tool-group') {
    return (
      <ToolActivityGroup
        key={item.key}
        items={item.children}
        subagents={subagents}
        alwaysExpand={alwaysExpandToolGroups}
        sessionId={sessionId}
      />
    );
  }
  if (item.kind === 'compaction-summary') {
    return <CompactionWidget key={item.key} message={item.message} />;
  }
  if (item.kind === 'compacted-stub') {
    return <CompactedRangeStub key={item.key} count={item.count} onExpand={() => onExpandCompacted(item.key)} />;
  }
  if (item.kind === 'collapsed-stub' || item.kind === 'history-gap') {
    return (
      <CollapsedChainStub
        key={item.key}
        chain={item.chain}
        chainIndex={item.chainIndex}
        onExpand={onExpandChain}
        mode={item.kind === 'history-gap' ? 'history' : undefined}
        loading={loadingHistoryChainIds.has(item.chain.id)}
      />
    );
  }
  if (item.kind === 'footer') {
    return (
      <ChainFooter
        key={item.key}
        usage={item.usage}
        subUsage={item.subUsage}
        model={item.model}
        elapsedSeconds={item.elapsedSeconds}
        interrupted={item.interrupted}
        failed={item.failed}
        errorDetail={item.errorDetail}
      />
    );
  }
  return (
    <MessageWidget
      key={item.key}
      message={item.message}
      isStreaming={item.isStreaming}
    />
  );
}
