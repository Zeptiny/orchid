/**
 * ChatStream — scrollable message stream with smart auto-scroll.
 *
 * Display order is chronological (call/send order), not a fixed
 * tools-then-assistant layout. A single turn may interleave freely:
 *   user → tool → message → tool → tool → message → …
 *
 * Chain footers still appear once per completed user turn.
 * Live stream segments (while streaming) continue that same order.
 */
import { useRef, useEffect, useCallback, useState, useMemo, type ReactNode } from 'react';
import type { Chain } from '../../shared/types/chain';
import type { Message, Usage } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';
import type { SubagentRecord } from '../../shared/types/subagent';
import { sumSubagentsUsage, subUsageByParentChain } from '../../shared/usage';
import type { ChatStatus, StreamSegment, ToolBlock } from '../hooks/useChat';
import {
  foldActivityRuns,
  isGroupableTool,
} from '../utils/tool-grouping';
import { MessageWidget } from './MessageWidget';
import { ChainFooter } from './ChainFooter';
import { ErrorBanner } from './ErrorBanner';
import { ToolCallBlock } from './ToolCallBlock';
import {
  ToolActivityGroup,
  type ActivityChild,
} from './ToolActivityGroup';
import { Icon } from './Icon';
import orchidIcon from '../assets/orchid-icon.svg';

interface ChatStreamProps {
  messages: Message[];
  streamingContent: string;
  toolBlocks: ToolBlock[];
  /** Chronological live segments for the in-flight turn (tool/text/thinking). */
  streamSegments?: readonly StreamSegment[];
  status: ChatStatus;
  error: string | null;
  usage: Usage | null;
  /**
   * Subagents for the active session — their chain message usage feeds the
   * footer `sub:` line (attributed via parentChainIndex when possible).
   */
  subagents?: readonly SubagentRecord[];
  /** Session chains (same order as storage) for parent_chain_index attribution. */
  sessionChains?: readonly Chain[];
  onClearError: () => void;
  onOpenSettings?: () => void;
  /** When true, empty state prompts for a project folder (R3). */
  workspaceUnbound?: boolean;
  onPickProjectDir?: () => void;
  onRetry?: () => void;
  elapsedSeconds?: number;
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
      elapsedSeconds?: number;
      interrupted?: boolean;
    };

export const AUTO_SCROLL_THRESHOLD_PX = 100;

/**
 * Pure helper: whether the scroll container is far enough from the bottom
 * that auto-scroll should stay off. Used by ChatStream and architecture tests.
 */
export function isUserScrolledAwayFromBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  thresholdPx: number = AUTO_SCROLL_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight > thresholdPx;
}

/** Pure helper: auto-scroll only when the user has not scrolled away. */
export function shouldAutoScroll(isUserScrolledUp: boolean): boolean {
  return !isUserScrolledUp;
}


export function ChatStream({
  messages,
  streamingContent,
  toolBlocks,
  streamSegments = [],
  status,
  error,
  onClearError,
  onOpenSettings,
  workspaceUnbound = false,
  onPickProjectDir,
  onRetry,
  usage,
  subagents = [],
  sessionChains = [],
  elapsedSeconds,
  interrupted,
  alwaysExpandToolGroups = false,
}: ChatStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);

  const scrollToBottom = useCallback(() => {
    if (shouldAutoScroll(isUserScrolledUp)) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isUserScrolledUp]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      setIsUserScrolledUp(
        isUserScrolledAwayFromBottom(scrollTop, scrollHeight, clientHeight),
      );
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, streamingContent, toolBlocks, streamSegments, scrollToBottom]);

  useEffect(() => {
    if (status === 'streaming') {
      setIsUserScrolledUp(false);
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [status]);

  // Committed history is independent of per-token stream text. Keep it stable
  // so long sessions do not rebuild O(n) lists on every chunk.
  const history = useMemo(
    () =>
      buildHistoryStreamItems({
        messages,
        toolBlocks,
        status,
        liveUsage: usage,
        subagents,
        sessionChains,
        elapsedSeconds,
        interrupted: Boolean(interrupted),
      }),
    [
      messages,
      toolBlocks,
      status,
      usage,
      subagents,
      sessionChains,
      elapsedSeconds,
      interrupted,
    ],
  );

  // Live tail only — recomputed per token / segment / tool status change.
  const liveItems = useMemo(
    () =>
      buildLiveTailItems({
        toolBlocks,
        streamSegments,
        streamingContent: status === 'streaming' ? streamingContent : '',
        status,
        emittedToolIds: history.emittedToolIds,
      }),
    [toolBlocks, streamSegments, streamingContent, status, history.emittedToolIds],
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

  if (
    messages.length === 0 &&
    !streamingContent &&
    toolBlocks.length === 0 &&
    streamSegments.length === 0 &&
    status === 'idle' &&
    !error
  ) {
    return (
      <div className="chat-scroll flex min-h-0 flex-1 items-center justify-center">
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden>
            <img src={orchidIcon} alt="" width={96} height={96} />
          </div>
          {workspaceUnbound ? (
            <>
              <div className="empty-state-title">Choose a project folder</div>
              <div className="empty-state-desc">
                Orchid needs a working directory before the agent can run tools
                or create sessions.
              </div>
              {onPickProjectDir && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm mt-3"
                  onClick={onPickProjectDir}
                >
                  <Icon name="folder" size={14} />
                  Open folder
                </button>
              )}
            </>
          ) : (
            <>
              <div className="empty-state-title">Welcome to Orchid</div>
              <div className="empty-state-desc">
                Start a conversation by typing a message below.
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-scroll" ref={containerRef}>
      {error && (
        <div className="error-banner-slot">
          <ErrorBanner
            message={error}
            onDismiss={onClearError}
            onOpenSettings={onOpenSettings}
            onRetry={onRetry}
          />
        </div>
      )}

      {historyItems.map((item) =>
        renderStreamItem(item, alwaysExpandToolGroups),
      )}
      {liveGroupedItems.map((item) =>
        renderStreamItem(item, alwaysExpandToolGroups),
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}

function renderStreamItem(
  item: StreamItem,
  alwaysExpandToolGroups: boolean,
): ReactNode {
  if (item.kind === 'tool') {
    return <ToolCallBlock key={item.key} block={item.block} />;
  }
  if (item.kind === 'tool-group') {
    return (
      <ToolActivityGroup
        key={item.key}
        items={item.children}
        alwaysExpand={alwaysExpandToolGroups}
      />
    );
  }
  if (item.kind === 'footer') {
    return (
      <ChainFooter
        key={item.key}
        usage={item.usage}
        subUsage={item.subUsage}
        elapsedSeconds={item.elapsedSeconds}
        interrupted={item.interrupted}
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
        if (
          item.block.status === 'generating' ||
          item.block.status === 'running' ||
          item.block.status === 'pending'
        ) {
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
  subagents: readonly SubagentRecord[];
  sessionChains: readonly Chain[];
  elapsedSeconds?: number;
  interrupted: boolean;
}): HistoryBuildResult {
  const {
    messages,
    toolBlocks,
    status,
    liveUsage,
    subagents,
    sessionChains,
    elapsedSeconds,
    interrupted,
  } = opts;

  // Precompute subagent usage attribution (parent_chain_index → Usage).
  const subByParent = subUsageByParentChain(subagents);
  const subTotal = sumSubagentsUsage(subagents);
  // Ordered user-turn fingerprints → session chain index (ids often missing on restore).
  const userTurnChainQueue = buildUserTurnChainQueue(sessionChains);
  let userTurnMatchCursor = 0;

  const visible = messages.filter((m) => !m.hidden);
  const liveById = new Map(toolBlocks.map((b) => [b.id, b]));
  const resultByCallId = new Map<string, Message>();
  for (const m of visible) {
    if (m.type === MessageType.TOOL_RESULT && m.tool_call_id) {
      resultByCallId.set(m.tool_call_id, m);
    }
  }

  const items: StreamItem[] = [];
  const consumedResults = new Set<string>();
  const emittedToolIds = new Set<string>();
  const liveStreaming = status === 'streaming';

  // Track per-turn metadata for footers (still one footer per user turn).
  let turnIndex = -1;
  let turnUserId: string | null = null;
  let turnChainIndex: number | null = null;
  let turnHasBody = false;
  let turnLastAssistantUsage: Usage | null = null;
  let turnItemCountAtStart = 0;
  /** Chain indexes that already showed their subagent usage on a footer. */
  const subUsageShownForChain = new Set<number>();

  const keyFor = (msg: Message, kind: string, idx: number) =>
    msg.id && msg.id.length > 0 ? msg.id : `t${turnIndex}-${kind}-${idx}`;

  const resolveSubUsage = (
    isLastTurn: boolean,
    isLastTurnOfParentChain: boolean,
  ): Usage | null => {
    // Show sub usage once on the last footer of the parent chain that spawned them.
    if (
      isLastTurnOfParentChain &&
      turnChainIndex != null &&
      subByParent.has(turnChainIndex) &&
      !subUsageShownForChain.has(turnChainIndex)
    ) {
      return subByParent.get(turnChainIndex) ?? null;
    }
    if (isLastTurn) {
      // Unattributed subagents, or totals not yet shown.
      const unattributed = subByParent.get(-1) ?? null;
      if (unattributed) return unattributed;
      if (subByParent.size === 0) return subTotal;
      let leftover: Usage | null = null;
      for (const [idx, u] of subByParent) {
        if (idx === -1) continue;
        if (subUsageShownForChain.has(idx)) continue;
        // Don't double-count the current chain if we're attaching it now
        if (idx === turnChainIndex && isLastTurnOfParentChain) continue;
        leftover = leftover
          ? {
              prompt_tokens: leftover.prompt_tokens + u.prompt_tokens,
              completion_tokens: leftover.completion_tokens + u.completion_tokens,
              total_tokens: leftover.total_tokens + u.total_tokens,
              cached_tokens: leftover.cached_tokens + u.cached_tokens,
            }
          : u;
      }
      // Current chain's usage on last turn overall
      if (
        turnChainIndex != null &&
        subByParent.has(turnChainIndex) &&
        !subUsageShownForChain.has(turnChainIndex)
      ) {
        const cur = subByParent.get(turnChainIndex)!;
        leftover = leftover
          ? {
              prompt_tokens: leftover.prompt_tokens + cur.prompt_tokens,
              completion_tokens: leftover.completion_tokens + cur.completion_tokens,
              total_tokens: leftover.total_tokens + cur.total_tokens,
              cached_tokens: leftover.cached_tokens + cur.cached_tokens,
            }
          : cur;
      }
      return leftover;
    }
    return null;
  };

  const flushFooter = (isLastTurn: boolean, isLastTurnOfParentChain: boolean) => {
    if (!turnHasBody) return;
    // While the active turn is still streaming, omit its footer.
    if (isLastTurn && liveStreaming) return;

    const turnUsage =
      isLastTurn && (status === 'idle' || status === 'error' || interrupted)
        ? liveUsage ?? turnLastAssistantUsage
        : turnLastAssistantUsage;

    const subUsage = resolveSubUsage(isLastTurn, isLastTurnOfParentChain);
    if (subUsage && turnChainIndex != null) {
      subUsageShownForChain.add(turnChainIndex);
    }

    items.push({
      kind: 'footer',
      key: `footer-${turnUserId || turnIndex}`,
      usage: turnUsage,
      subUsage,
      elapsedSeconds: isLastTurn ? elapsedSeconds : undefined,
      interrupted: isLastTurn ? interrupted : false,
    });
  };

  const startTurn = (user: Message | null) => {
    const nextChainIndex = user
      ? matchUserTurnChain(user, userTurnChainQueue, userTurnMatchCursor)
      : null;

    // Close previous turn footer if any content was emitted.
    if (turnIndex >= 0) {
      // Attach sub usage when leaving a parent chain (or when no next turn).
      const isLastOfChain =
        nextChainIndex == null || nextChainIndex !== turnChainIndex;
      flushFooter(false, isLastOfChain);
    }
    turnIndex += 1;
    turnUserId = user?.id ?? null;
    turnChainIndex = nextChainIndex;
    if (turnChainIndex != null) {
      // Advance cursor past this match so multi-turn chains stay ordered.
      while (
        userTurnMatchCursor < userTurnChainQueue.length &&
        userTurnChainQueue[userTurnMatchCursor].chainIndex !== turnChainIndex
      ) {
        userTurnMatchCursor += 1;
      }
      if (
        userTurnMatchCursor < userTurnChainQueue.length &&
        userTurnChainQueue[userTurnMatchCursor].chainIndex === turnChainIndex
      ) {
        userTurnMatchCursor += 1;
      }
    }
    turnHasBody = false;
    turnLastAssistantUsage = null;
    turnItemCountAtStart = items.length;

    if (user) {
      items.push({
        kind: 'message',
        key: keyFor(user, 'user', 0),
        message: user,
      });
    }
  };

  // Ensure we have a turn context even when history starts with non-user msgs.
  const ensureTurn = () => {
    if (turnIndex < 0) startTurn(null);
  };

  const pushTool = (block: ToolBlock, keyPrefix = 'tool') => {
    if (emittedToolIds.has(block.id)) return;
    emittedToolIds.add(block.id);
    ensureTurn();
    turnHasBody = true;
    items.push({
      kind: 'tool',
      key: block.id || `${keyPrefix}-${turnIndex}-${emittedToolIds.size}`,
      block,
    });
  };

  const pushMessage = (msg: Message, kind: string, idx: number) => {
    ensureTurn();
    turnHasBody = true;
    if (msg.role === MessageRole.ASSISTANT && msg.type === MessageType.TEXT && msg.usage) {
      turnLastAssistantUsage = msg.usage;
    }
    items.push({
      kind: 'message',
      key: keyFor(msg, kind, idx),
      message: msg,
    });
  };

  // ── Walk committed history in call/send order ────────────────────────────
  let msgIdx = 0;
  for (const m of visible) {
    if (m.role === MessageRole.USER && m.type === MessageType.TEXT) {
      startTurn(m);
      msgIdx += 1;
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
      // Prefer live block when present (richer generating/running status)
      // without changing chronological position.
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

  // Idle but leftover live blocks not yet in history — append in order.
  // While streaming, these belong in the live tail (buildLiveTailItems).
  if (!liveStreaming && toolBlocks.length > 0) {
    for (const block of toolBlocks) {
      if (!emittedToolIds.has(block.id)) {
        pushTool(block, 'live');
      }
    }
  }

  // Footer for the final turn (if complete / not streaming).
  if (turnIndex >= 0) {
    // turnHasBody may be true only for user; require assistant/tools for footer
    const bodyBeyondUser = items.length > turnItemCountAtStart + (turnUserId ? 1 : 0);
    if (bodyBeyondUser || turnHasBody) {
      // Recompute: footer if we had tools or assistant content
      const hasRenderableBody = items
        .slice(turnItemCountAtStart)
        .some(
          (it) =>
            it.kind === 'tool' ||
            it.kind === 'tool-group' ||
            (it.kind === 'message' && it.message.role !== MessageRole.USER),
        );
      if (hasRenderableBody) {
        turnHasBody = true;
        flushFooter(true, true);
      }
    }
  }

  return { items, emittedToolIds };
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
    is_error: false,
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
    is_error: false,
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
    is_error: false,
  },
      true,
    );
  }
  return items;
}

interface UserTurnFingerprint {
  content: string;
  timestamp: string;
  chainIndex: number;
}

/** Ordered user turns across session chains for parent_chain_index attribution. */
function buildUserTurnChainQueue(chains: readonly Chain[]): UserTurnFingerprint[] {
  const out: UserTurnFingerprint[] = [];
  chains.forEach((chain, chainIndex) => {
    for (const m of chain.messages) {
      if (m.role === MessageRole.USER && m.type === MessageType.TEXT) {
        out.push({
          content: m.content ?? '',
          timestamp: m.timestamp ?? '',
          chainIndex,
        });
      }
    }
  });
  return out;
}

/**
 * Match a rendered user message to a session chain index.
 * Prefers content+timestamp; falls back to content-only; then sequential order.
 */
function matchUserTurnChain(
  user: Message,
  queue: UserTurnFingerprint[],
  from: number,
): number | null {
  if (queue.length === 0) return null;
  const content = user.content ?? '';
  const timestamp = user.timestamp ?? '';

  for (let i = from; i < queue.length; i++) {
    if (queue[i].content === content && queue[i].timestamp === timestamp) {
      return queue[i].chainIndex;
    }
  }
  for (let i = from; i < queue.length; i++) {
    if (queue[i].content === content) {
      return queue[i].chainIndex;
    }
  }
  // Sequential fallback — user turns appear in chain order after flatten.
  if (from < queue.length) return queue[from].chainIndex;
  return null;
}

function messagePairToToolBlock(call: Message, result: Message | null): ToolBlock {
  const toolName =
    call.tool_calls?.[0]?.function?.name ?? call.name ?? result?.name ?? 'unknown';
  const args = call.tool_calls?.[0]?.function?.arguments ?? call.content ?? '';
  const callId = call.tool_call_id ?? call.tool_calls?.[0]?.id ?? call.id;
  // Backend owns failure; never infer from content text.
  const isError = Boolean(result?.is_error);

  return {
    id: callId,
    toolName,
    status: result ? (isError ? 'failed' : 'completed') : 'completed',
    partialArgs: '',
    args,
    result: result && !isError ? result.content : null,
    error: result && isError ? result.content : null,
    startedAt: call.timestamp,
    finishedAt: result?.timestamp ?? call.timestamp,
  };
}

function resultOnlyToToolBlock(result: Message): ToolBlock {
  const isError = Boolean(result.is_error);

  return {
    id: result.tool_call_id ?? result.id,
    toolName: result.name ?? 'tool',
    status: isError ? 'failed' : 'completed',
    partialArgs: '',
    args: '',
    result: isError ? null : result.content,
    error: isError ? result.content : null,
    startedAt: result.timestamp,
    finishedAt: result.timestamp,
  };
}
