import type { Chain } from '../../shared/types/chain';
import {
  ChainStatus,
  chainElapsedSeconds,
  isTerminalChainStatus,
  sumChainUsage,
} from '../../shared/types/chain';
import type { CompactionMode, Message, Usage } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';
import type { CompactionProgressPhase } from '../../shared/types/compaction-progress';
import type { SubagentUsageSummary } from '../../shared/usage';
import {
  type ChatStatus,
  type StreamSegment,
  type ToolBlock,
} from '../hooks/useChat';
import {
  foldActivityRuns,
  isActiveToolStatus,
  isGroupableTool,
} from './tool-grouping';

export type ActivityChild =
  | { kind: 'tool'; block: ToolBlock }
  | { kind: 'thought'; message: Message; isStreaming?: boolean };

/** Maximum fully-mounted chains; older ones collapse to stubs. */
export const CHAIN_COLLAPSE_THRESHOLD = 20;

/** React key prefix for live compaction widgets, shared by both scopes. */
export const COMPACTION_WIDGET_KEY_PREFIX = 'compaction-';

/**
 * Structural input shared by both compaction-progress sources: the main
 * scope's turn-projection state and the subagent live-projection event.
 */
export interface CompactionProgressInput {
  readonly phase: CompactionProgressPhase;
  readonly mode?: CompactionMode;
  readonly detail?: string;
  readonly streamText?: string | null;
  readonly estimatedTokens?: number | null;
}

/**
 * Live compaction widget item derived from a compaction-progress event.
 * Terminal phases (`complete`/`failed`) produce no item — the widget's final
 * state is carried by the persisted `compacted` marker on replay, rendered as
 * a `compaction-summary` item instead.
 */
export interface CompactionProgressWidgetItem {
  readonly kind: 'compaction-progress';
  readonly key: string;
  readonly status: 'running' | 'generating';
  readonly phase: CompactionProgressPhase;
  readonly mode?: CompactionMode;
  readonly detail?: string;
  readonly streamText?: string | null;
  readonly estimatedTokens?: number | null;
}

/**
 * Build the live compaction widget item for one agent scope. `scopeId` is the
 * `agentScopeId` the event carried (`'main'` or a subagent id); the React key
 * is `compaction-${scopeId}` — one live widget per scope at a time, so a
 * second compaction in the same view replaces the node instead of stacking.
 * Returns null for terminal phases and absent progress.
 */
export function compactionProgressToWidgetItem(
  scopeId: string,
  progress: CompactionProgressInput | null | undefined,
): CompactionProgressWidgetItem | null {
  if (!progress) return null;
  if (progress.phase === 'complete' || progress.phase === 'failed') return null;
  return {
    kind: 'compaction-progress',
    key: `${COMPACTION_WIDGET_KEY_PREFIX}${scopeId}`,
    status: progress.phase === 'preparing' ? 'running' : 'generating',
    phase: progress.phase,
    ...(progress.mode !== undefined ? { mode: progress.mode } : {}),
    ...(progress.detail !== undefined ? { detail: progress.detail } : {}),
    ...(progress.streamText !== undefined ? { streamText: progress.streamText } : {}),
    ...(progress.estimatedTokens !== undefined
      ? { estimatedTokens: progress.estimatedTokens }
      : {}),
  };
}

export type StreamItem =
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
      errorDetail?: string | null;
    }
  | {
      kind: 'collapsed-stub';
      key: string;
      chain: Chain;
      chainIndex: number;
    }
  | {
      kind: 'history-gap';
      key: string;
      chain: Chain;
      chainIndex: number;
    }
  | {
      kind: 'compaction-summary';
      key: string;
      message: Message;
    }
  | {
      kind: 'compacted-stub';
      key: string;
      messages: readonly Message[];
      count: number;
    };

export type FooterStreamItem = Extract<StreamItem, { kind: 'footer' }>;

function hasCompactedMarker(message: Message): boolean {
  return Boolean((message as unknown as { compacted?: unknown }).compacted);
}

export function shouldRenderChainFooter(input: {
  isActive: boolean;
  isTerminal: boolean;
  hasBody: boolean;
  hasUser: boolean;
}): boolean {
  // Active chains always footer (live turn). A terminal chain footers only
  // when it contributed renderable content or a user turn — a chain whose
  // whole message set is one compacted run (superseded summary rows, split
  // prefixes) must not drop a stray footer between the merged stub and the
  // next chain.
  if (input.isActive) return true;
  return (input.isTerminal || input.hasBody) && (input.hasBody || input.hasUser);
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
  const historyIds = new Set<string>();
  for (const item of historyItems) {
    if (item.kind !== 'message' || !item.message.id) continue;
    historyIds.add(item.message.id);
  }
  const remaining = new Map<string, number>();
  for (const item of historyItems) {
    if (item.kind !== 'message') continue;
    const key = assistantMessageDedupeKey(item.message);
    if (!key) continue;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  if (historyIds.size === 0 && remaining.size === 0) return liveItems as StreamItem[];

  return liveItems.filter((item) => {
    if (item.kind !== 'message') return true;
    if (item.message.id && historyIds.has(item.message.id)) return false;
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
 * Collapse consecutive **settled** thoughts + groupable tools into one group.
 * Streaming thoughts and generating/running tools stay solo so live work is visible.
 * Title is tool-only; expanded body keeps chronological thought/tool order.
 */
export function foldStreamActivityGroups(items: readonly StreamItem[]): StreamItem[] {
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

export interface HistoryBuildResult {
  items: StreamItem[];
  /** Tool ids already rendered in committed history (live tail skips these). */
  emittedToolIds: ReadonlySet<string>;
  /** Active-chain footer is rendered after the live tail. */
  activeFooter: FooterStreamItem | null;
}

/**
 * Build stream items for committed messages (+ idle leftover tools + footers).
 * Independent of streamingContent / streamSegments so it stays stable per token.
 *
 * Multi-chain layout: walk each session chain, collapse old ones, and render
 * one footer per chain with model + cumulative usage + sub attribution.
 */
export function buildHistoryStreamItems(opts: {
  messages: Message[];
  toolBlocks: ToolBlock[];
  status: ChatStatus;
  liveUsage: Usage | null;
  subagentUsage: SubagentUsageSummary;
  sessionChains: readonly Chain[];
  interrupted: boolean;
  expandedChainIndexes: ReadonlySet<number>;
  expandedCompactedKeys?: ReadonlySet<string>;
}): HistoryBuildResult {
  const {
    toolBlocks,
    status,
    liveUsage,
    subagentUsage,
    sessionChains,
    interrupted,
    expandedChainIndexes,
    expandedCompactedKeys,
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

  const walkState: ChainWalkState = {
    items,
    compactedBuffer: [],
    resultByCallId: new Map(),
    consumedResults: new Set(),
    seenMessageIds: new Set(),
  };
  /** Flush the open compacted run at a chain boundary (before footers/stubs). */
  const boundaryFlush = (keyPrefix: string): void => {
    flushCompactedBuffer(walkState, {
      liveById,
      emittedToolIds,
      keyPrefix,
      expandedCompactedKeys,
      counter: { value: 0 },
    });
  };

  const isActiveChain = (chain: Chain, chainIndex: number): boolean => (
    chain.status === ChainStatus.ACTIVE
    || (chainIndex === sessionChains.length - 1 && liveStreaming)
  );
  const globalHistoryGapChainIndex = sessionChains.findLastIndex((chain, chainIndex) => {
    const collapsed = chainIndex < collapseCount
      && !expandedChainIndexes.has(chainIndex)
      && !isActiveChain(chain, chainIndex);
    return !collapsed
      && chain.messagesLoaded === false
      && (chain.messageStartIndex ?? 0) > 0;
  });
  if (globalHistoryGapChainIndex >= 0) {
    const chain = sessionChains[globalHistoryGapChainIndex]!;
    items.push({
      kind: 'history-gap',
      key: `history-gap-global-${chain.id || globalHistoryGapChainIndex}-${chain.messageStartIndex}`,
      chain,
      chainIndex: globalHistoryGapChainIndex,
    });
  }

  // Each chain body comes from chain.messages (authoritative storage). Live
  // tools/text for the active turn still render via buildLiveTailItems.
  for (let chainIndex = 0; chainIndex < sessionChains.length; chainIndex++) {
    const chain = sessionChains[chainIndex];
    const isLastChain = chainIndex === sessionChains.length - 1;
    const isActive = isActiveChain(chain, chainIndex);
    const terminal =
      isTerminalChainStatus(chain.status) ||
      (isLastChain && (interrupted || status === 'error'));

    if (
      chainIndex < collapseCount &&
      !expandedChainIndexes.has(chainIndex) &&
      !isActive
    ) {
      boundaryFlush(`c${chainIndex}`);
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
    const startLen = items.length;
    const compactedAny = walkMessagesToItems(chain.messages, {
      toolBlocks,
      liveById,
      emittedToolIds,
      keyPrefix: `c${chainIndex}`,
      expandedCompactedKeys,
    }, walkState);
    // Contributed items BEFORE any boundary flush: a chain whose whole
    // message set is one compacted run contributes no body of its own.
    const contributed = items.slice(startLen);

    const chainUsage = sumChainUsage(chain);
    // Prefer live usage for the active/running chain so CHAT_USAGE events
    // update the agent: line mid-turn (context radial already uses the same
    // stream). Terminal chains must read their own durable usage: `liveUsage`
    // may fall back to the newest persisted usage and must never stamp a
    // FAILED/INTERRUPTED chain with a previous turn's tokens.
    const turnUsage = isLastChain && !terminal ? liveUsage ?? chainUsage : chainUsage;

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

    const hasBody = contributed.some(
      (it) =>
        it.kind === 'tool' ||
        it.kind === 'tool-group' ||
        (it.kind === 'message' && it.message.role !== MessageRole.USER) ||
        it.kind === 'compaction-summary' ||
        it.kind === 'compacted-stub',
    );
    const hasUser = chain.messages.some(
      (m) => m.role === MessageRole.USER && m.type === MessageType.TEXT,
    ) || Boolean(chain.preview);
    // A chain whose only contributions are a user message plus a compacted
    // run is the frozen prefix row of a mid-turn split — skipping its footer
    // keeps the run open so it merges with the next chain (the continuing
    // row's footer covers the whole turn).
    const compactedOnlyPrefix = !hasBody && compactedAny;
    // Every visible chain gets a footer, including the running/active chain.
    if (
      !compactedOnlyPrefix &&
      shouldRenderChainFooter({ isActive, isTerminal: terminal, hasBody, hasUser })
    ) {
      // A footer is a visible item: flush the open compacted run so the
      // stub renders ABOVE it. When no footer renders here, the run stays
      // open and merges into the next chain's walk.
      boundaryFlush(`c${chainIndex}`);
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
        errorDetail: chain.errorDetail,
      };
      if (isActive) {
        activeFooter = footer;
      } else {
        items.push(footer);
      }
    }
  }

  // Final boundary: a trailing compacted run flushes before idle leftover
  // tools so it never renders below them (or below the deferred active
  // footer, which renders after the live tail).
  boundaryFlush('tail');

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

/**
 * Cross-chain state threaded through every chain walk in one history build.
 *
 * A compaction splits durable chain rows around its summary head, and a
 * later compaction supersedes earlier heads — so one logical compacted run
 * can be spread across several sibling chains (flagged prefix row,
 * superseded-head summary rows, …). Buffering inside a single chain walk
 * flushes each fragment as its own stub ("Compacted 1 message"); the shared
 * accumulator lets the run carry across chain boundaries and collapse into
 * ONE stub, matching the post-finalize reloaded layout.
 */
interface ChainWalkState {
  /** Flat item sink shared by every walk (history order). */
  readonly items: StreamItem[];
  /** Open trailing compacted run — carried across chain boundaries. */
  compactedBuffer: Message[];
  /** tool_call_id → result message, seeded from every walked chain. */
  readonly resultByCallId: Map<string, Message>;
  /** tool_call_ids already rendered as paired tool items. */
  readonly consumedResults: Set<string>;
  /**
   * Message ids already handled by any walk. Durable split rows mirror the
   * same ids across chains (checkpoint rewrites the continuing row with the
   * full turn); replay semantics keep the first occurrence only.
   */
  readonly seenMessageIds: Set<string>;
}

/**
 * Flush the open compacted run into items — either as one collapsed stub or,
 * when expanded, by re-rendering each buffered message at full fidelity.
 * Callable at any chain boundary; a no-op when nothing is buffered.
 */
function flushCompactedBuffer(
  state: ChainWalkState,
  opts: {
    liveById: Map<string, ToolBlock>;
    emittedToolIds: Set<string>;
    keyPrefix: string;
    expandedCompactedKeys?: ReadonlySet<string>;
    /** Walk-local key counter mutated by emitted items so keys stay unique. */
    counter: { value: number };
  },
): void {
  if (state.compactedBuffer.length === 0) return;
  const { liveById, emittedToolIds, keyPrefix, expandedCompactedKeys, counter } = opts;
  // Rows mirrored across chains (stale split duplicates) collapse by id.
  const seenIds = new Set<string>();
  const buffer = state.compactedBuffer.filter((m) =>
    seenIds.has(m.id) ? false : (seenIds.add(m.id), true),
  );
  const firstId = buffer[0]?.id || `${keyPrefix}-compacted-${counter.value}`;
  const stubKey = `compacted-stub-${firstId}`;
  const isExpanded = expandedCompactedKeys?.has(stubKey) ?? false;

  const keyFor = (msg: Message, kind: string): string =>
    msg.id && msg.id.length > 0
      ? `${keyPrefix}-${kind}-${msg.id}-${counter.value}`
      : `${keyPrefix}-${kind}-${counter.value}`;

  const pushTool = (block: ToolBlock): void => {
    if (emittedToolIds.has(block.id)) return;
    emittedToolIds.add(block.id);
    state.items.push({
      kind: 'tool',
      key: block.id
        ? `${keyPrefix}-tool-${block.id}-${emittedToolIds.size}`
        : `${keyPrefix}-tool-${emittedToolIds.size}`,
      block,
    });
  };

  const pushMessage = (msg: Message, kind: string): void => {
    state.items.push({ kind: 'message', key: keyFor(msg, kind), message: msg });
  };

  if (isExpanded) {
    // Expand to full fidelity — render each buffered message with normal logic.
    const bufferedIds = new Set(buffer.map((m) => m.id));
    for (const buffered of buffer) {
      if (buffered.type === MessageType.TOOL_CALL) {
        const callId = buffered.tool_call_id ?? buffered.tool_calls?.[0]?.id ?? buffered.id;
        const result = state.resultByCallId.get(callId);
        if (result && bufferedIds.has(result.id)) {
          // Paired result also in buffer — render as one tool pair.
          if (!state.consumedResults.has(callId)) {
            state.consumedResults.add(callId);
            pushTool(liveById.get(callId) ?? messagePairToToolBlock(buffered, result));
          }
        } else {
          if (result) state.consumedResults.add(callId);
          pushTool(liveById.get(callId) ?? messagePairToToolBlock(buffered, result ?? null));
        }
        counter.value += 1;
        continue;
      }
      if (buffered.type === MessageType.TOOL_RESULT) {
        const callId = buffered.tool_call_id ?? buffered.id;
        if (!state.consumedResults.has(callId)) {
          pushTool(liveById.get(callId) ?? resultOnlyToToolBlock(buffered));
        }
        counter.value += 1;
        continue;
      }
      if (buffered.type === MessageType.THINKING) {
        pushMessage(buffered, 'thought');
        counter.value += 1;
        continue;
      }
      pushMessage(buffered, 'other');
      counter.value += 1;
    }
  } else {
    // Claim the buffered tool ids even while collapsed: a stale live tail
    // (or idle leftover tool blocks after CHAT_DONE) must not re-render
    // compacted-away tools below the stub — the collapsed range owns them.
    for (const buffered of buffer) {
      if (buffered.type === MessageType.TOOL_CALL) {
        emittedToolIds.add(buffered.tool_call_id ?? buffered.tool_calls?.[0]?.id ?? buffered.id);
      } else if (buffered.type === MessageType.TOOL_RESULT) {
        emittedToolIds.add(buffered.tool_call_id ?? buffered.id);
      }
    }
    state.items.push({
      kind: 'compacted-stub',
      key: stubKey,
      messages: buffer,
      count: buffer.length,
    });
    counter.value += buffer.length;
  }
  state.compactedBuffer = [];
}

/**
 * Walk a message slice into stream items, appending into the shared state.
 * An open compacted run at the end of the slice is deliberately left in the
 * buffer so the next chain's walk (or the build boundary) can merge it.
 * Returns whether the walk buffered any compacted content (a chain whose
 * only contributions are a user message plus a compacted run is the frozen
 * prefix row of a mid-turn split — its footer would split the run).
 */
function walkMessagesToItems(
  visibleSource: readonly Message[],
  opts: {
    toolBlocks: ToolBlock[];
    liveById: Map<string, ToolBlock>;
    emittedToolIds: Set<string>;
    keyPrefix: string;
    expandedCompactedKeys?: ReadonlySet<string>;
  },
  state: ChainWalkState,
): boolean {
  const { liveById, emittedToolIds, keyPrefix, expandedCompactedKeys } = opts;
  const visible = visibleSource.filter((m) => !m.hidden);
  for (const m of visible) {
    if (m.type === MessageType.TOOL_RESULT && m.tool_call_id) {
      state.resultByCallId.set(m.tool_call_id, m);
    }
  }

  let compactedAny = false;
  const counter = { value: 0 };
  const keyFor = (msg: Message, kind: string): string =>
    msg.id && msg.id.length > 0
      ? `${keyPrefix}-${kind}-${msg.id}-${counter.value}`
      : `${keyPrefix}-${kind}-${counter.value}`;

  const pushTool = (block: ToolBlock) => {
    if (emittedToolIds.has(block.id)) return;
    emittedToolIds.add(block.id);
    state.items.push({
      kind: 'tool',
      key: block.id ? `${keyPrefix}-tool-${block.id}-${emittedToolIds.size}` : `${keyPrefix}-tool-${emittedToolIds.size}`,
      block,
    });
  };

  const pushMessage = (msg: Message, kind: string) => {
    state.items.push({
      kind: 'message',
      key: keyFor(msg, kind),
      message: msg,
    });
  };

  const flush = () =>
    flushCompactedBuffer(state, { liveById, emittedToolIds, keyPrefix, expandedCompactedKeys, counter });

  for (const m of visible) {
    if (m.id && state.seenMessageIds.has(m.id)) continue;
    if (m.id) state.seenMessageIds.add(m.id);
    if (hasCompactedMarker(m)) {
      if (m.excludeFromModel) {
        state.compactedBuffer.push(m);
        compactedAny = true;
        continue;
      }
      flush();
      state.items.push({
        kind: 'compaction-summary',
        key: keyFor(m, 'compaction'),
        message: m,
      });
      counter.value += 1;
      continue;
    }
    if (m.excludeFromModel) {
      state.compactedBuffer.push(m);
      compactedAny = true;
      continue;
    }
    flush();
    if (m.role === MessageRole.USER && m.type === MessageType.TEXT) {
      state.items.push({
        kind: 'message',
        key: keyFor(m, 'user'),
        message: m,
      });
      counter.value += 1;
      continue;
    }

    if (m.type === MessageType.THINKING) {
      pushMessage(m, 'thought');
      counter.value += 1;
      continue;
    }

    if (m.type === MessageType.TOOL_CALL) {
      const callId = m.tool_call_id ?? m.tool_calls?.[0]?.id ?? m.id;
      const result = state.resultByCallId.get(callId);
      if (result) state.consumedResults.add(callId);
      const live = liveById.get(callId);
      pushTool(live ?? messagePairToToolBlock(m, result ?? null));
      counter.value += 1;
      continue;
    }

    if (m.type === MessageType.TOOL_RESULT) {
      const callId = m.tool_call_id ?? m.id;
      if (state.consumedResults.has(callId)) {
        counter.value += 1;
        continue;
      }
      const live = liveById.get(callId);
      pushTool(live ?? resultOnlyToToolBlock(m));
      counter.value += 1;
      continue;
    }

    if (m.role === MessageRole.ASSISTANT && m.type === MessageType.TEXT) {
      if (!m.content?.trim()) {
        counter.value += 1;
        continue;
      }
      pushMessage(m, 'asst');
      counter.value += 1;
      continue;
    }

    if (m.type === MessageType.ERROR || m.role === MessageRole.SYSTEM) {
      pushMessage(m, 'other');
      counter.value += 1;
      continue;
    }

    if (m.content?.trim()) {
      pushMessage(m, 'other');
      counter.value += 1;
    } else {
      counter.value += 1;
    }
  }
  return compactedAny;
}

/**
 * Build only the in-flight live tail (stream segments / fallback stream text).
 * Intentionally small so it can recompute cheaply on every token.
 */
export function buildLiveTailItems(opts: {
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
      key: isStreaming ? (msg.id ? `live-${msg.id}-streaming` : 'streaming') : `live-${msg.id}-${items.length}`,
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
      if (seg.kind === 'text' && seg.content.trim()) {
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
      if (seg.kind === 'thinking' && seg.content.trim()) {
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
  if (streamingContent.trim()) {
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
