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
import {
  ChainStatus,
  chainElapsedSeconds,
  isTerminalChainStatus,
  sumChainUsage,
} from '../../shared/types/chain';
import type { Message, Usage } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';
import { EMPTY_SUBAGENT_USAGE_SUMMARY, type SubagentUsageSummary } from '../../shared/usage';
import {
  useElapsedSeconds,
  type ChatStatus,
  type StreamSegment,
  type ToolBlock,
} from '../hooks/useChat';
import {
  foldActivityRuns,
  isActiveToolStatus,
  isGroupableTool,
} from '../utils/tool-grouping';
import type { SubagentTitleRecord } from '../utils/tool-title';
import { MessageWidget } from './MessageWidget';
import { ChainFooter } from './ChainFooter';
import { CollapsedChainStub } from './CollapsedChainStub';
import { ErrorBanner } from './ErrorBanner';
import { ToolCallBlock } from './ToolCallBlock';
import {
  ToolActivityGroup,
  type ActivityChild,
} from './ToolActivityGroup';
import { Icon } from './Icon';
import { Button } from './ui/Button';
import orchidIcon from '../assets/orchid-icon.svg';
import { useSmartAutoScroll } from '../hooks/useSmartAutoScroll';
import { shouldAutoScroll } from '../hooks/useSmartAutoScroll';

export { AUTO_SCROLL_THRESHOLD_PX, isUserScrolledAwayFromBottom, shouldAutoScroll } from '../hooks/useSmartAutoScroll';

/** Maximum fully-mounted chains; older ones collapse to stubs. */
export const CHAIN_COLLAPSE_THRESHOLD = 20;

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
}

type StreamItem =
  | { kind: 'message'; key: string; message: Message; isStreaming?: boolean }
  | { kind: 'tool'; key: string; block: ToolBlock }
  /** Explore activity: tools ± thoughts, title is tool-only summary. */
  | { kind: 'tool-group'; key: string; children: ActivityChild[] }
  | {
      kind: 'footer';
      key: string;
      usage: Usage | null;
      subUsage: Usage | null;
      model?: string | null;
      elapsedSeconds?: number;
      interrupted?: boolean;
      failed?: boolean;
    }
  | {
      kind: 'collapsed-stub';
      key: string;
      chain: Chain;
      chainIndex: number;
    };

type FooterStreamItem = Extract<StreamItem, { kind: 'footer' }>;

export function shouldRenderChainFooter(input: {
  isActive: boolean;
  isTerminal: boolean;
  hasBody: boolean;
  hasUser: boolean;
}): boolean {
  return input.isActive || input.isTerminal || input.hasBody || input.hasUser;
}

/**
 * Drop live assistant text/thinking that is already in committed history.
 *
 * On turn complete main emits SESSION_UPDATED (chain.messages gains the
 * assistant bubble) before CHAT_DONE (clears streamSegments). Multi-chain
 * history is driven by session chains, so both layers briefly hold the same
 * content. Tools are already deduped via emittedToolIds; this covers text.
 *
 * Uses a multiset so two identical bubbles in history only suppress two live
 * matches — a third live copy (rare) would still render.
 */
export function suppressLiveMessagesAlreadyInHistory(
  liveItems: readonly StreamItem[],
  historyItems: readonly StreamItem[],
): StreamItem[] {
  const remaining = new Map<string, number>();
  for (const item of historyItems) {
    if (item.kind !== 'message') continue;
    const key = assistantMessageDedupeKey(item.message);
    if (!key) continue;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  if (remaining.size === 0) return liveItems as StreamItem[];

  return liveItems.filter((item) => {
    if (item.kind !== 'message') return true;
    const key = assistantMessageDedupeKey(item.message);
    if (!key) return true;
    const count = remaining.get(key) ?? 0;
    if (count <= 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

/** Stable key for assistant text/thinking content used in live/history dedupe. */
function assistantMessageDedupeKey(message: Message): string | null {
  if (message.role !== MessageRole.ASSISTANT) return null;
  if (message.type !== MessageType.TEXT && message.type !== MessageType.THINKING) {
    return null;
  }
  const content = message.content ?? '';
  if (!content) return null;
  return `${message.type}\0${content}`;
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
      renderStreamItem(item, alwaysExpandToolGroups, expandChain, subagents),
    ),
    [historyItems, alwaysExpandToolGroups, expandChain, subagents],
  );
  const liveTailNodes = useMemo(
    () => liveGroupedItems.map((item) =>
      renderStreamItem(item, alwaysExpandToolGroups, expandChain, subagents),
    ),
    [liveGroupedItems, alwaysExpandToolGroups, expandChain, subagents],
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
      subagents,
    );
  }, [
    history.activeFooter,
    status,
    currentTurnUsage,
    streamStartTime,
    liveElapsedSeconds,
    alwaysExpandToolGroups,
    expandChain,
    subagents,
  ]);
  const streamNodes = useMemo(
    () => activeFooterNode
      ? [...historyNodes, ...liveTailNodes, activeFooterNode]
      : [...historyNodes, ...liveTailNodes],
    [historyNodes, liveTailNodes, activeFooterNode],
  );

  if (
    messages.length === 0 &&
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

        {/* History + live tail + active footer render as ONE keyed sequence.
            History nodes remain referentially stable across live-only frames,
            while the small tail/footer path updates independently. Keeping the
            final nodes flat lets React retain shared segment/footer keys across
            the live→committed swap instead of replaying entrance animation. */}
        {streamNodes}
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
  subagents: readonly SubagentTitleRecord[],
): ReactNode {
  if (item.kind === 'tool') {
    return <ToolCallBlock key={item.key} block={item.block} subagents={subagents} />;
  }
  if (item.kind === 'tool-group') {
    return (
      <ToolActivityGroup
        key={item.key}
        items={item.children}
        subagents={subagents}
        alwaysExpand={alwaysExpandToolGroups}
      />
    );
  }
  if (item.kind === 'collapsed-stub') {
    return (
      <CollapsedChainStub
        key={item.key}
        chain={item.chain}
        chainIndex={item.chainIndex}
        onExpand={onExpandChain}
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

/**
 * Collapse consecutive **settled** thoughts + groupable tools into one group.
 * Streaming thoughts and generating/running tools stay solo so live work is visible.
 * Title is tool-only; expanded body keeps chronological thought/tool order.
 */
function foldStreamActivityGroups(items: readonly StreamItem[]): StreamItem[] {
  return foldActivityRuns(items, {
    classify: (item) => {
      if (item.kind === 'tool' && isGroupableTool(item.block.toolName)) {
        // generating / running / pending → always visible as own row
        if (isActiveToolStatus(item.block.status)) {
          return 'active';
        }
        // completed | failed
        return 'settled-tool';
      }
      if (
        item.kind === 'message' &&
        item.message.type === MessageType.THINKING
      ) {
        // Live reasoning stays solo; finished thoughts may fold with tools
        return item.isStreaming ? 'active' : 'settled-thought';
      }
      return 'break';
    },
    makeGroup: (sources) => {
      const children: ActivityChild[] = [];
      for (const s of sources) {
        if (s.kind === 'tool') {
          children.push({ kind: 'tool', block: s.block });
        } else if (s.kind === 'message') {
          children.push({
            kind: 'thought',
            message: s.message,
            isStreaming: s.isStreaming,
          });
        }
      }
      const firstTool = children.find((c) => c.kind === 'tool');
      const firstId =
        firstTool && firstTool.kind === 'tool'
          ? firstTool.block.id
          : sources[0]?.key ?? 'empty';
      return {
        kind: 'tool-group',
        key: `tool-group-${firstId}`,
        children,
      };
    },
  });
}

// ── Chronological stream builders ────────────────────────────────────────────
//
// History and live tail are memoized separately in ChatStream so per-token
// stream updates only rebuild the small in-flight tail, not the full session.

interface HistoryBuildResult {
  items: StreamItem[];
  /** Tool ids already rendered in committed history (live tail skips these). */
  emittedToolIds: ReadonlySet<string>;
  /** Active-chain footer is rendered after the live tail. */
  activeFooter: FooterStreamItem | null;
}

/**
 * Build stream items for committed messages (+ idle leftover tools + footers).
 * Independent of streamingContent / streamSegments so it stays stable per token.
 */
function buildHistoryStreamItems(opts: {
  messages: Message[];
  toolBlocks: ToolBlock[];
  status: ChatStatus;
  liveUsage: Usage | null;
  subagentUsage: SubagentUsageSummary;
  sessionChains: readonly Chain[];
  interrupted: boolean;
  expandedChainIndexes: ReadonlySet<number>;
}): HistoryBuildResult {
  return buildMultiChainHistoryStreamItems(opts);
}

/**
 * Multi-chain layout: walk each session chain, collapse old ones, and render
 * one footer per chain with model + cumulative usage + sub attribution.
 */
function buildMultiChainHistoryStreamItems(opts: {
  toolBlocks: ToolBlock[];
  status: ChatStatus;
  liveUsage: Usage | null;
  subagentUsage: SubagentUsageSummary;
  sessionChains: readonly Chain[];
  interrupted: boolean;
  expandedChainIndexes: ReadonlySet<number>;
}): HistoryBuildResult {
  const {
    toolBlocks,
    status,
    liveUsage,
    subagentUsage,
    sessionChains,
    interrupted,
    expandedChainIndexes,
  } = opts;

  const subByParent = subagentUsage.byParentChain;
  const subTotal = subagentUsage.total;
  const liveStreaming = status === 'streaming';
  const collapseCount = Math.max(
    0,
    sessionChains.length - CHAIN_COLLAPSE_THRESHOLD,
  );

  const items: StreamItem[] = [];
  const emittedToolIds = new Set<string>();
  const liveById = new Map(toolBlocks.map((b) => [b.id, b]));
  let activeFooter: FooterStreamItem | null = null;

  // Each chain body comes from chain.messages (authoritative storage). Live
  // tools/text for the active turn still render via buildLiveTailItems.
  for (let chainIndex = 0; chainIndex < sessionChains.length; chainIndex++) {
    const chain = sessionChains[chainIndex];
    const isLastChain = chainIndex === sessionChains.length - 1;
    const isActive =
      chain.status === ChainStatus.ACTIVE ||
      (isLastChain && liveStreaming);
    const terminal =
      isTerminalChainStatus(chain.status) ||
      (isLastChain && (interrupted || status === 'error'));

    if (
      chainIndex < collapseCount &&
      !expandedChainIndexes.has(chainIndex) &&
      !isActive
    ) {
      items.push({
        kind: 'collapsed-stub',
        key: `stub-${chain.id || chainIndex}`,
        chain,
        chainIndex,
      });
      continue;
    }

    // Authoritative storage for each chain body — avoids flat-messages length
    // desync after FAILED/INTERRUPTED when the renderer lags or only partially commits.
    // Live tools/text for the active turn still render via buildLiveTailItems.
    const chainItems = walkMessagesToItems(chain.messages, {
      toolBlocks,
      liveById,
      emittedToolIds,
      keyPrefix: `c${chainIndex}`,
    });
    items.push(...chainItems.items);

    const chainUsage = sumChainUsage(chain);
    // Prefer live usage for the active/last chain so CHAT_USAGE events update
    // the agent: line mid-turn (context radial already uses the same stream).
    const turnUsage = isLastChain ? liveUsage ?? chainUsage : chainUsage;

    let subUsage: Usage | null = subByParent.get(chainIndex) ?? null;
    if (isLastChain && !subUsage) {
      subUsage = subByParent.get(-1) ?? (subByParent.size === 0 ? subTotal : null);
    }

    // Live elapsed is injected at render for the active footer so the 1s
    // ticker cannot invalidate this history memo. Completed chains use storage.
    const elapsed =
      isLastChain && liveStreaming
        ? undefined
        : chain.startTime
          ? chainElapsedSeconds(chain)
          : undefined;

    const hasBody = chainItems.items.some(
      (it) =>
        it.kind === 'tool' ||
        it.kind === 'tool-group' ||
        (it.kind === 'message' && it.message.role !== MessageRole.USER),
    );
    const hasUser = chain.messages.some(
      (m) => m.role === MessageRole.USER && m.type === MessageType.TEXT,
    );
    // Every visible chain gets a footer, including the running/active chain.
    if (shouldRenderChainFooter({ isActive, isTerminal: terminal, hasBody, hasUser })) {
      const footer: FooterStreamItem = {
        kind: 'footer',
        key: `footer-chain-${chain.id || chainIndex}`,
        usage: turnUsage,
        subUsage,
        model: chain.modelLabel,
        elapsedSeconds: elapsed,
        interrupted:
          chain.status === ChainStatus.INTERRUPTED ||
          (isLastChain && interrupted),
        failed: chain.status === ChainStatus.FAILED,
      };
      if (isActive) {
        activeFooter = footer;
      } else {
        items.push(footer);
      }
    }
  }

  // Idle leftover live tool blocks not already emitted.
  if (!liveStreaming && toolBlocks.length > 0) {
    for (const block of toolBlocks) {
      if (!emittedToolIds.has(block.id)) {
        emittedToolIds.add(block.id);
        items.push({
          kind: 'tool',
          key: block.id || `live-${emittedToolIds.size}`,
          block,
        });
      }
    }
  }

  return { items, emittedToolIds, activeFooter };
}

/** Walk a message slice into stream items (multi-chain + shared helpers). */
function walkMessagesToItems(
  visibleSource: readonly Message[],
  opts: {
    toolBlocks: ToolBlock[];
    liveById: Map<string, ToolBlock>;
    emittedToolIds: Set<string>;
    keyPrefix: string;
  },
): { items: StreamItem[]; lastAssistantUsage: Usage | null } {
  const { liveById, emittedToolIds, keyPrefix } = opts;
  const visible = visibleSource.filter((m) => !m.hidden);
  const resultByCallId = new Map<string, Message>();
  for (const m of visible) {
    if (m.type === MessageType.TOOL_RESULT && m.tool_call_id) {
      resultByCallId.set(m.tool_call_id, m);
    }
  }

  const items: StreamItem[] = [];
  const consumedResults = new Set<string>();
  let lastAssistantUsage: Usage | null = null;
  let msgIdx = 0;

  const keyFor = (msg: Message, kind: string, idx: number) =>
    msg.id && msg.id.length > 0 ? msg.id : `${keyPrefix}-${kind}-${idx}`;

  const pushTool = (block: ToolBlock) => {
    if (emittedToolIds.has(block.id)) return;
    emittedToolIds.add(block.id);
    items.push({
      kind: 'tool',
      key: block.id || `${keyPrefix}-tool-${emittedToolIds.size}`,
      block,
    });
  };

  const pushMessage = (msg: Message, kind: string, idx: number) => {
    if (msg.role === MessageRole.ASSISTANT && msg.type === MessageType.TEXT && msg.usage) {
      lastAssistantUsage = msg.usage;
    }
    items.push({
      kind: 'message',
      key: keyFor(msg, kind, idx),
      message: msg,
    });
  };

  for (const m of visible) {
    if (m.role === MessageRole.USER && m.type === MessageType.TEXT) {
      items.push({
        kind: 'message',
        key: keyFor(m, 'user', msgIdx++),
        message: m,
      });
      continue;
    }

    if (m.type === MessageType.THINKING) {
      pushMessage(m, 'thought', msgIdx++);
      continue;
    }

    if (m.type === MessageType.TOOL_CALL) {
      const callId = m.tool_call_id ?? m.tool_calls?.[0]?.id ?? m.id;
      const result = resultByCallId.get(callId);
      if (result) consumedResults.add(callId);
      const live = liveById.get(callId);
      pushTool(live ?? messagePairToToolBlock(m, result ?? null));
      msgIdx += 1;
      continue;
    }

    if (m.type === MessageType.TOOL_RESULT) {
      const callId = m.tool_call_id ?? m.id;
      if (consumedResults.has(callId)) {
        msgIdx += 1;
        continue;
      }
      const live = liveById.get(callId);
      pushTool(live ?? resultOnlyToToolBlock(m));
      msgIdx += 1;
      continue;
    }

    if (m.role === MessageRole.ASSISTANT && m.type === MessageType.TEXT) {
      if (!m.content?.trim()) {
        msgIdx += 1;
        continue;
      }
      pushMessage(m, 'asst', msgIdx++);
      continue;
    }

    if (m.type === MessageType.ERROR || m.role === MessageRole.SYSTEM) {
      pushMessage(m, 'other', msgIdx++);
      continue;
    }

    if (m.content?.trim()) {
      pushMessage(m, 'other', msgIdx++);
    } else {
      msgIdx += 1;
    }
  }

  return { items, lastAssistantUsage };
}

/**
 * Build only the in-flight live tail (stream segments / fallback stream text).
 * Intentionally small so it can recompute cheaply on every token.
 */
function buildLiveTailItems(opts: {
  toolBlocks: ToolBlock[];
  streamSegments: readonly StreamSegment[];
  streamingContent: string;
  status: ChatStatus;
  emittedToolIds: ReadonlySet<string>;
}): StreamItem[] {
  const { toolBlocks, streamSegments, streamingContent, status, emittedToolIds } = opts;
  const liveStreaming = status === 'streaming';
  if (!liveStreaming && streamSegments.length === 0) {
    return [];
  }

  const items: StreamItem[] = [];
  const liveById = new Map(toolBlocks.map((b) => [b.id, b]));
  const seenTools = new Set<string>(emittedToolIds);

  const pushTool = (block: ToolBlock) => {
    if (seenTools.has(block.id)) return;
    seenTools.add(block.id);
    items.push({
      kind: 'tool',
      key: block.id || `live-${seenTools.size}`,
      block,
    });
  };

  const pushMessage = (msg: Message, isStreaming: boolean) => {
    items.push({
      kind: 'message',
      key: isStreaming ? (msg.id || 'streaming') : msg.id,
      message: msg,
      isStreaming,
    });
  };

  if (streamSegments.length > 0) {
    // Only the trailing segment can still be "live". Once a tool (or later
    // text/thinking) is appended after a thought, that thought is settled —
    // even while the overall turn is still streaming.
    const lastSegIndex = streamSegments.length - 1;

    // Stable timestamp for the live rebuild so message objects differ only by content.
    const ts = new Date().toISOString();

    streamSegments.forEach((seg, segIndex) => {
      if (seg.kind === 'tool') {
        const block = liveById.get(seg.toolCallId);
        if (block) pushTool(block);
        return;
      }
      if (seg.kind === 'text' && seg.content) {
        const stillStreaming =
          liveStreaming && segIndex === lastSegIndex;
        pushMessage(
          {
            id: seg.id,
            role: MessageRole.ASSISTANT,
            content: seg.content,
            type: MessageType.TEXT,
            tool_calls: null,
            tool_call_id: null,
            name: null,
            thinking: null,
            timestamp: ts,
            usage: null,
            hidden: false,
            tool_result: null,
  },
          stillStreaming,
        );
        return;
      }
      if (seg.kind === 'thinking' && seg.content) {
        // Finished as soon as anything follows this segment (tool/text/new thought).
        const stillStreamingThink =
          liveStreaming && segIndex === lastSegIndex;
        pushMessage(
          {
            id: seg.id,
            role: MessageRole.ASSISTANT,
            content: seg.content,
            type: MessageType.THINKING,
            tool_calls: null,
            tool_call_id: null,
            name: null,
            thinking: seg.content,
            timestamp: ts,
            usage: null,
            hidden: false,
            tool_result: null,
  },
          stillStreamingThink,
        );
      }
    });
    return items;
  }

  // Fallback when segments are empty but we still have live tools/text
  // (e.g. mid-wire of older event paths).
  for (const block of toolBlocks) {
    pushTool(block);
  }
  if (streamingContent) {
    pushMessage(
      {
        id: 'streaming',
        role: MessageRole.ASSISTANT,
        content: streamingContent,
        type: MessageType.TEXT,
        tool_calls: null,
        tool_call_id: null,
        name: null,
        thinking: null,
        timestamp: new Date().toISOString(),
        usage: null,
        hidden: false,
        tool_result: null,
  },
      true,
    );
  }
  return items;
}

function messagePairToToolBlock(call: Message, result: Message | null): ToolBlock {
  const toolName =
    call.tool_calls?.[0]?.function?.name ?? call.name ?? result?.name ?? 'unknown';
  const args = call.tool_calls?.[0]?.function?.arguments ?? call.content ?? '';
  const callId = call.tool_call_id ?? call.tool_calls?.[0]?.id ?? call.id;
  const canonical = result?.tool_result ?? null;

  return {
    id: callId,
    toolName,
    status: canonical?.status === 'error' ? 'failed' : canonical?.status ?? 'completed',
    partialArgs: '',
    args,
    agentProjection: result?.content ?? null,
    toolResult: canonical,
    startedAt: call.timestamp,
    finishedAt: result?.timestamp ?? call.timestamp,
  };
}

function resultOnlyToToolBlock(result: Message): ToolBlock {
  const canonical = result.tool_result;

  return {
    id: result.tool_call_id ?? result.id,
    toolName: result.name ?? 'tool',
    status: canonical?.status === 'error' ? 'failed' : canonical?.status ?? 'completed',
    partialArgs: '',
    args: '',
    agentProjection: result.content,
    toolResult: canonical,
    startedAt: result.timestamp,
    finishedAt: result.timestamp,
  };
}
