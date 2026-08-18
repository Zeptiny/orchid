/**
 * Turn-scoped implementation behind the chat:send IPC boundary.
 *
 * `chat.ts` validates the untrusted payload and delegates here. Keeping the
 * actor lifecycle in this module prevents IPC registration from also owning
 * projection, persistence, and resource cleanup policies.
 */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { WebContents } from 'electron';
import { createActor } from 'xstate';
import { z } from 'zod';
import { agentMachine, type AgentContext } from '../../agents/xstate/agent-machine';
import { interruptMachine } from '../../agents/xstate/interrupt-machine';
import { appendRootAgentsMd, findRootAgentsMdEntry } from '../../project/agents-md';
import { appendProjectPersonality } from '../../project/personality';
import { getProviderRuntime } from '../../providers';
import { getProviderAccountingStore } from '../../providers/accounting/store';
import type { ProviderAttemptAccountingContext } from '../../providers/accounting/middleware';
import type { ReasoningProviderOptions } from '../../providers/drivers/types';
import {
  DEFAULT_THINKING_POLICY,
} from '../../providers/facets/thinking';
import type { ThinkingReplayContext } from '../../llm/history';
import type { CacheFacet, ThinkingPolicy } from '../../../shared/types/provider-facets';
import type { ProviderProtocol } from '../../../shared/types/provider';
import { resolveMainAgentTier } from '../../providers/facets/tiers';
import { assembleFacetProviderOptions } from '../../providers/facets/turn-options';
import { getSessionManager } from '../../session/singleton';
import { saveSession } from '../../session/storage';
import { getBuiltinToolRegistryForRuntime, getSubagentManager } from '../../tools';
import type { ToolExecutionContext } from '../../tools/types';
import { awaitSessionSubagentHydration } from '../../tools/subagent/hydrate';
import { resolveMainAgentEffort } from '../../llm/reasoning-effort';
import {
  makeAssistantMessage,
  makeThinkingMessage,
  makeToolCallMessage,
  makeToolResultMessage,
  makeUserMessage,
} from '../../llm/message-factories';
import { acquireProjectMCPManager, releaseProjectMCPManager } from '../../mcp/project-registry';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { ChainStatus } from '../../../shared/types/chain';
import type { Chain } from '../../../shared/types/chain';
import { MessageType, type Message, type Usage } from '../../../shared/types/message';
import { getChatHistory, setChatHistory } from '../chat-history';
import { chatSendSchema } from '../payload-schemas';
import { clearNextRequestStop, requestCompactionPause, clearCompactionPause, shouldPauseForCompaction } from '../next-request-stop';
import { completeSessionActivity, publishSessionActivity } from '../session-activity';
import { disposeActiveAgent, forceAbortSession } from './abort';
import { emitSessionUpdated, sendChatState, sendTurnEvent, webContentsForWindowId } from './events';
import {
  activeAgents,
  canEmitStreamEvents,
  isCurrentAgent,
  nextAgentGeneration,
  sessionsStarting,
  type ActiveAgent,
} from './state';
import {
  attachUsageToLatestAssistant,
  checkpointActiveTurn,
  currentTurnSnapshot,
  flushPartialTurnContent,
  historyFromSession,
  persistTurnConversation,
  turnMessagesFromAgent,
  persistCompactionBetweenTurns as persistCompaction,
} from './persist';
import {
  appendTextSegment,
  ensureToolSnapshot,
  textSegmentIdAtOffset,
  updateToolSnapshot,
} from './snapshot';
import { ensureActiveSessionSingleFlight } from './session';
import { classifyErrorKind, createProviderStreamFn } from './stream';
import { triggerSessionAutoName } from './title';
import { selectCut, type CutResult } from '../../llm/compaction/select';
import { mechanicalReclaim } from '../../llm/compaction/reclaim';
import { summarizeCompactableRange } from '../../llm/compaction/summarize';
import { buildCompactionApply, CompactionApplyError } from '../../llm/compaction/apply';
import { CompactionTrigger } from '../../llm/compaction/trigger';
import { buildManifest } from '../../llm/compaction/selective/manifest';
import type { Manifest } from '../../llm/compaction/selective/manifest';
import { createLlmSelectiveCaller, runSelectiveCompaction } from '../../llm/compaction/selective/run';
import type { SelectiveCompactionResult } from '../../llm/compaction/selective/run';
import { isContextLengthExceededError } from '../../llm/middleware/error-classification';
import { onSessionDeleted } from '../../session/manager';

export type ChatSendPayload = z.infer<typeof chatSendSchema>;

// ── Compaction state per session (U8, R13) ──────────────────────────────────

const FALLBACK_CONTEXT_TOKENS = 128_000;

const compactionTriggers = new Map<string, CompactionTrigger>();
const compactionPending = new Map<string, {
  cut: CutResult;
  flaggedIds: string[];
  expectedIds?: string[];
  estimatedInput: number;
  contextTokens: number;
  mode: 'simple' | 'selective';
  promise?: Promise<import('../../llm/compaction/summarize').SummarizeResult | null>;
  selectivePromise?: Promise<SelectiveCompactionResult>;
  manifest?: Manifest;
}>();
const compactionRetryTried = new Set<string>();

export function clearCompactionState(sessionId: string): void {
  compactionTriggers.delete(sessionId);
  compactionPending.delete(sessionId);
  for (const key of [...compactionRetryTried]) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) compactionRetryTried.delete(key);
  }
}

// Evict compaction Maps when a session is deleted — prevents unbounded growth.
try {
  onSessionDeleted((sessionId) => clearCompactionState(sessionId));
} catch {
  // manager may be unavailable in unit-test imports
}

function getCompactionTrigger(sessionId: string): CompactionTrigger {
  let t = compactionTriggers.get(sessionId);
  if (!t) {
    t = new CompactionTrigger();
    compactionTriggers.set(sessionId, t);
  }
  return t;
}

function estimateMessageChars(msg: Message): number {
  let n = 0;
  if (msg.content) n += msg.content.length;
  if (msg.thinking) n += msg.thinking.length;
  if (msg.tool_calls) n += JSON.stringify(msg.tool_calls).length;
  if (msg.tool_result) n += JSON.stringify(msg.tool_result).length;
  if (msg.tool_call_id) n += msg.tool_call_id.length;
  if (msg.name) n += msg.name.length;
  return n === 0 ? 1 : n;
}

function totalChars(messages: readonly Message[]): number {
  let s = 0;
  for (const m of messages) s += estimateMessageChars(m);
  return s === 0 ? 1 : s;
}

function compactableTokenEstimate(messages: readonly Message[], range: { start: number; end: number }, tokensPerChar: number | undefined): number {
  if (tokensPerChar == null || !Number.isFinite(tokensPerChar) || tokensPerChar <= 0) return 0;
  let chars = 0;
  for (let i = range.start; i < range.end; i += 1) chars += estimateMessageChars(messages[i]!);
  return Math.ceil(chars * tokensPerChar);
}

function deriveTokensPerChar(inputTokens: number, messages: readonly Message[], fallback?: number | null): number | undefined {
  const chars = totalChars(messages);
  if (chars <= 0) return fallback ?? undefined;
  if (Number.isFinite(inputTokens) && inputTokens > 0) {
    const r = inputTokens / chars;
    if (Number.isFinite(r) && r > 0) return Math.max(0.05, Math.min(r, 2));
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) return fallback;
  return undefined;
}

function isPendingCutStillValid(pending: { cut: CutResult; flaggedIds: string[]; expectedIds?: string[] }, messages: readonly Message[]): boolean {
  const { start, end } = pending.cut.compactableRange;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < 0 || end > messages.length || start >= end) return false;
  if (pending.cut.cutIndex < 0 || pending.cut.cutIndex > messages.length) return false;
  for (let i = start; i < end; i += 1) {
    if (messages[i]?.excludeFromModel) return false;
  }
  if (pending.flaggedIds.length > 0) {
    const idToMsg = new Map<string, Message>();
    for (const m of messages) idToMsg.set(m.id, m);
    for (const id of pending.flaggedIds) {
      const msg = idToMsg.get(id);
      if (!msg) return false;
      if (msg.excludeFromModel) return false;
    }
  }
  if (pending.expectedIds) {
    if (pending.expectedIds.length !== end - start) return false;
    for (let i = 0; i < pending.expectedIds.length; i += 1) {
      if (messages[start + i]?.id !== pending.expectedIds[i]) return false;
    }
  }
  return true;
}

// ── Selective persistence helper (minimal between-turns) ─────────────────────
function persistSelectiveCompaction(
  sessionId: string,
  result: Extract<SelectiveCompactionResult, { kind: 'selective' }>,
  cut: CutResult,
): boolean {
  try {
    const manager = getSessionManager();
    const existing = manager.getSession(sessionId) ?? manager.load(sessionId);
    if (!existing) return true;
    const flaggedSet = new Set(result.flaggedIds);
    let updatedChains: Chain[] = existing.chains.map((chain) => {
      let changed = false;
      const newMessages = chain.messages.map((m) => {
        if (flaggedSet.has(m.id) && !m.excludeFromModel) {
          changed = true;
          return { ...m, excludeFromModel: true };
        }
        return m;
      });
      return changed ? { ...chain, messages: newMessages } : { ...chain, messages: [...chain.messages] };
    }) as Chain[];
    const summaryMessages = result.summaryMessages.length > 0
      ? result.summaryMessages
      : (result.summaryMessage ? [result.summaryMessage] : []);
    if (summaryMessages.length > 0) {
      let insertionIdx = updatedChains.length;
      try {
        const idToChainIdx = new Map<string, number>();
        existing.chains.forEach((ch, idx) => {
          for (const m of ch.messages) if (!idToChainIdx.has(m.id)) idToChainIdx.set(m.id, idx);
        });
        const flatOriginal: Message[] = existing.chains.flatMap((c) => c.messages as unknown as Message[]);
        const preserveStart = cut.compactableRange.end;
        if (preserveStart < flatOriginal.length) {
          const preserveId = flatOriginal[preserveStart]!.id;
          const idx = idToChainIdx.get(preserveId);
          if (typeof idx === 'number') insertionIdx = idx;
        } else {
          insertionIdx = updatedChains.length;
        }
      } catch {}
      const now = new Date().toISOString();
      let chainsWithSummaries: Chain[] = [...updatedChains];
      for (let s = 0; s < summaryMessages.length; s += 1) {
        const msg = summaryMessages[s]!;
        const newChain = {
          id: `selective-${Date.now()}-${s}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId,
          messages: [msg] as unknown as readonly Message[],
          status: ChainStatus.COMPLETED,
          selection: null,
          modelLabel: null,
          agentName: 'compactor',
          agentType: 'internal' as const,
          agentTier: 'seed' as const,
          subagentRecord: null,
          startTime: now,
          endTime: now,
          errorDetail: null,
          errorTitle: null,
        } as Chain;
        chainsWithSummaries = [
          ...chainsWithSummaries.slice(0, insertionIdx + s),
          newChain,
          ...chainsWithSummaries.slice(insertionIdx + s),
        ];
      }
      updatedChains = chainsWithSummaries;
    }
    const updatedAt = new Date().toISOString();
    const nextSession = { ...existing, chains: updatedChains as typeof existing.chains, updatedAt } as typeof existing;
    saveSession(nextSession);
    try {
      (manager as unknown as { _sessions: Map<string, unknown> })._sessions?.set(sessionId, nextSession);
    } catch {
    }
    try {
      const { IPC_CHANNELS } = require('../../../shared/types/ipc') as typeof import('../../../shared/types/ipc');
      const { buildSessionUpdatedEvent } = require('./events') as typeof import('./events');
      const { webContents } = require('electron') as typeof import('electron');
      const all = (webContents?.getAllWebContents?.() ?? []) as unknown as Array<{ id: number; send: (ch: string, p: unknown) => void; isDestroyed?: () => boolean }>;
      const prevIds = new Set(existing.chains.map((c) => c.id));
      const changedIds = new Set<string>();
      for (const c of updatedChains) {
        const prev = existing.chains.find((p) => p.id === c.id);
        if (!prev || prev.messages.length !== c.messages.length || prev.messages.some((m, i) => m.excludeFromModel !== c.messages[i]?.excludeFromModel)) changedIds.add(c.id);
      }
      for (const c of updatedChains) if (!prevIds.has(c.id)) changedIds.add(c.id);
      for (const chainId of changedIds) {
        const chain = nextSession.chains.find((c) => c.id === chainId);
        if (!chain) continue;
        const event = buildSessionUpdatedEvent(nextSession as unknown as import('../../../shared/types/session').Session, chain.id);
        if (!event) continue;
        for (const wc of all) {
          try {
            const active = (manager as unknown as { getActive: (id: string) => unknown }).getActive(String(wc.id));
            if ((active as unknown as { id?: string })?.id !== sessionId) continue;
            if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) continue;
            wc.send(IPC_CHANNELS.SESSION_UPDATED, event);
          } catch {
          }
        }
      }
      try {
        const { webContents: wc2 } = require('electron') as typeof import('electron');
        const all2 = (wc2?.getAllWebContents?.() ?? []) as unknown as Array<{ id: number; send: (ch: string, p: unknown) => void; isDestroyed?: () => boolean }>;
        const compactionEvent = { sessionId, updatedAt: nextSession.updatedAt };
        for (const wc of all2) {
          try {
            const active = (manager as unknown as { getActive: (id: string) => unknown }).getActive(String(wc.id));
            if ((active as unknown as { id?: string })?.id !== sessionId) continue;
            if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) continue;
            wc.send(IPC_CHANNELS.SESSION_COMPACTION, compactionEvent);
          } catch {
          }
        }
      } catch {
      }
    } catch {
    }
    return true;
  } catch (err) {
    console.debug('[compaction] selective chain persist failed (non-fatal):', err);
    return false;
  }
}

async function applyPendingCompactionIfAny(
  sessionId: string,
  messages: Message[],
  runtime: import('../../project/runtime').ProjectRuntime,
): Promise<{ applied: boolean; updatedMessages?: Message[] }> {
  const pending = compactionPending.get(sessionId);
  if (!pending) return { applied: false };
  if (!isPendingCutStillValid(pending, messages)) {
    compactionPending.delete(sessionId);
    const t = getCompactionTrigger(sessionId);
    t.abortPrepare();
    return { applied: false };
  }
  compactionPending.delete(sessionId);
  const trigger = getCompactionTrigger(sessionId);
  try {
    // ── Selective pending ───────────────────────────────────────────────
    if (pending.mode === 'selective' && pending.selectivePromise) {
      const result = await pending.selectivePromise;
      if (result.kind === 'selective') {
        // Atomic: DB first, then memory. Single DB write via persistSelectiveCompaction.
        const ok = persistSelectiveCompaction(sessionId, result, pending.cut);
        if (!ok) {
          trigger.abortPrepare();
          return { applied: false };
        }
        setChatHistory(sessionId, [...result.replayMessages]);
        const postTokens = (() => {
          const tpc = trigger.state.tokensPerChar ?? (totalChars(result.replayMessages) > 0 ? pending.estimatedInput / Math.max(1, totalChars(messages)) : undefined);
          return tpc ? Math.ceil(totalChars(result.replayMessages) * tpc) : pending.estimatedInput;
        })();
        trigger.onCompactionApplied(pending.estimatedInput, postTokens);
        trigger.abortPrepare();
        return { applied: true, updatedMessages: [...result.replayMessages] };
      }
      if (result.kind === 'fallback' && result.fallbackText && result.fallbackText.trim()) {
        const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
        let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
        try {
          applyResult = buildCompactionApply({
            messages,
            chains: chains as Chain[],
            cutResult: pending.cut,
            summaryText: result.fallbackText,
            mode: runtime.config.compaction.main.mode,
            flaggedIds: pending.flaggedIds,
            sessionId,
          });
        } catch (e) {
          if (e instanceof CompactionApplyError) {
            trigger.abortPrepare();
            compactionPending.delete(sessionId);
            return { applied: false };
          }
          throw e;
        }
        if (applyResult.didApply) {
          const ok = persistCompaction(sessionId, applyResult);
          if (ok) {
            setChatHistory(sessionId, [...applyResult.updatedMessages]);
            const tpc = trigger.state.tokensPerChar ?? (totalChars(applyResult.updatedMessages) > 0 ? pending.estimatedInput / Math.max(1, totalChars(messages)) : undefined);
            const postTokens = tpc ? Math.ceil(totalChars(applyResult.updatedMessages) * tpc) : pending.estimatedInput;
            trigger.onCompactionApplied(pending.estimatedInput, postTokens);
            trigger.abortPrepare();
            return { applied: true, updatedMessages: [...applyResult.updatedMessages] };
          }
        }
        if (result.replayMessages && result.replayMessages.length > 0) {
          // Fallback replay without summary — treat as selective success with single DB write via helper if possible
          const selectiveLike = { kind: 'selective' as const, replayMessages: result.replayMessages, flaggedIds: result.flaggedIds ?? pending.flaggedIds, summaryMessages: [], summaryMessage: result.summaryMessage ?? null } as unknown as Extract<SelectiveCompactionResult, { kind: 'selective' }>;
          const ok = persistSelectiveCompaction(sessionId, selectiveLike, pending.cut);
          if (ok) {
            setChatHistory(sessionId, [...result.replayMessages]);
            const tpc = trigger.state.tokensPerChar ?? (totalChars(result.replayMessages) > 0 ? pending.estimatedInput / Math.max(1, totalChars(messages)) : undefined);
            const postTokens = tpc ? Math.ceil(totalChars(result.replayMessages) * tpc) : pending.estimatedInput;
            trigger.onCompactionApplied(pending.estimatedInput, postTokens);
          }
          trigger.abortPrepare();
          return { applied: ok, updatedMessages: ok ? [...result.replayMessages] : undefined };
        }
      }
      trigger.abortPrepare();
      return { applied: false };
    }
    // ── Simple pending (existing) ───────────────────────────────────────
    if (pending.promise) {
      const result = await pending.promise;
      if (result && result.text && result.text.trim()) {
        const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
        let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
        try {
          applyResult = buildCompactionApply({
            messages,
            chains: chains as Chain[],
            cutResult: pending.cut,
            summaryText: result.text,
            mode: runtime.config.compaction.main.mode,
            flaggedIds: pending.flaggedIds,
            sessionId,
          });
        } catch (e) {
          if (e instanceof CompactionApplyError) {
            trigger.abortPrepare();
            return { applied: false };
          }
          throw e;
        }
        if (applyResult.didApply) {
          const ok = persistCompaction(sessionId, applyResult);
          if (ok) {
            setChatHistory(sessionId, [...applyResult.updatedMessages]);
            const tpc = trigger.state.tokensPerChar ?? (totalChars(applyResult.updatedMessages) > 0 ? pending.estimatedInput / Math.max(1, totalChars(messages)) : undefined);
            const postTokens = tpc ? Math.ceil(totalChars(applyResult.updatedMessages) * tpc) : pending.estimatedInput;
            trigger.onCompactionApplied(pending.estimatedInput, postTokens);
            trigger.abortPrepare();
            return { applied: true, updatedMessages: [...applyResult.updatedMessages] };
          }
        }
      }
      // Summarizer failed or persist failed — clear pending flag
      trigger.abortPrepare();
      return { applied: false };
    }
    // Reclaim-only pending
    if (pending.flaggedIds.length > 0) {
      const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
      let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
      try {
        applyResult = buildCompactionApply({
          messages,
          chains: chains as Chain[],
          cutResult: pending.cut,
          summaryText: null,
          mode: runtime.config.compaction.main.mode,
          flaggedIds: pending.flaggedIds,
          sessionId,
        });
      } catch (e) {
        if (e instanceof CompactionApplyError) {
          trigger.abortPrepare();
          return { applied: false };
        }
        throw e;
      }
      if (applyResult.didApply) {
        const ok = persistCompaction(sessionId, applyResult);
        if (ok) {
          setChatHistory(sessionId, [...applyResult.updatedMessages]);
          const tpc = trigger.state.tokensPerChar ?? (totalChars(applyResult.updatedMessages) > 0 ? pending.estimatedInput / Math.max(1, totalChars(messages)) : undefined);
          const postTokens = tpc ? Math.ceil(totalChars(applyResult.updatedMessages) * tpc) : pending.estimatedInput;
          trigger.onCompactionApplied(pending.estimatedInput, postTokens);
          return { applied: true, updatedMessages: [...applyResult.updatedMessages] };
        }
      }
    }
  } catch (err) {
    console.debug('[compaction] pending apply failed (non-fatal):', err);
    const t = getCompactionTrigger(sessionId);
    t.abortPrepare();
  }
  return { applied: false };
}

async function tryCompactSynchronously(
  sessionId: string,
  messages: Message[],
  runtime: import('../../project/runtime').ProjectRuntime,
  selection: import('../../../shared/types/provider').ModelSelection,
  contextTokens: number,
  accountingStore: ReturnType<typeof getProviderAccountingStore>,
  chainId: string | null,
  turnId: string,
): Promise<{ didApply: boolean; updatedMessages?: Message[] }> {
  const trigger = getCompactionTrigger(sessionId);
  const cfg = runtime.config.compaction?.main;
  if (!cfg) return { didApply: false };
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return { didApply: false };
  if (trigger.state.pendingPrepare) return { didApply: false };
  try {
    // Single-pass: compute totalChars once, reuse for estimate and trigger ratio
    const totalCharsValue = totalChars(messages);
    let tokensPerChar = trigger.state.tokensPerChar;
    if (tokensPerChar == null && Number.isFinite(trigger.state.lastObservedInputTokens ?? NaN) && totalCharsValue > 0) {
      const obs = trigger.state.lastObservedInputTokens as number;
      const r = obs / totalCharsValue;
      if (Number.isFinite(r) && r > 0) tokensPerChar = Math.max(0.05, Math.min(r, 2));
    }
    if (tokensPerChar == null || !Number.isFinite(tokensPerChar) || tokensPerChar <= 0) {
      tokensPerChar = 0.25;
    }
    const estimatedInput = Math.ceil(totalCharsValue * tokensPerChar);
    // Early gate before expensive selectCut/reclaim: only proceed if threshold crossed or hysteresis accrual allows re-fire
    const ratio = estimatedInput / contextTokens;
    const hysteresisDelta = cfg.hysteresis_delta ?? 0.1;
    const isOverWindow = estimatedInput >= contextTokens;
    if (ratio + 1e-9 < cfg.threshold && !isOverWindow) {
      const baseline = trigger.state.postCompactionInputTokens;
      if (!(trigger.state.hysteresisArmed && typeof baseline === 'number' && estimatedInput - baseline >= cfg.min_compactable_tokens)) {
        return { didApply: false };
      }
    }
    const calibratedEstimator = (slice: readonly Message[]): number => {
      let chars = 0;
      for (const m of slice) {
        if (m.content) chars += m.content.length;
        if (m.thinking) chars += m.thinking.length;
        if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
        if (m.tool_result) chars += JSON.stringify(m.tool_result).length;
        if (m.tool_call_id) chars += m.tool_call_id.length;
        if (m.name) chars += m.name.length;
        if ((m as unknown as { compacted?: unknown }).compacted) chars += JSON.stringify((m as unknown as { compacted: unknown }).compacted).length;
      }
      return Math.max(slice.length, Math.ceil(chars * tokensPerChar));
    };
    const cut = selectCut(messages, { keepRecentChains: cfg.keep_recent_chains, budget: { contextTokens, threshold: cfg.threshold }, tokenEstimator: calibratedEstimator });
    if (cut.compactableRange.end <= cut.compactableRange.start) return { didApply: false };
    const compactableTokens = compactableTokenEstimate(messages, cut.compactableRange, tokensPerChar);
    if (compactableTokens < cfg.min_compactable_tokens) return { didApply: false };
    // Gate reclaim behind threshold: only compute reclaim if we passed the gates above
    const reclaim = mechanicalReclaim(messages, cut.compactableRange);
    const flaggedIds = reclaim.flaggedIds;
    const decision = trigger.evaluateWithReclaim({
      inputTokens: estimatedInput,
      contextTokens,
      threshold: cfg.threshold,
      hysteresisDelta,
      compactableTokens,
      minCompactableTokens: cfg.min_compactable_tokens,
      compactableRange: cut.compactableRange,
      messages,
      flaggedIds,
      estimatedInputTokens: estimatedInput,
    });
    if (!decision.shouldPrepare && !decision.shouldApply) return { didApply: false };
    const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
    if (decision.shouldApply && !decision.shouldPrepare) {
      let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
      try {
        applyResult = buildCompactionApply({
          messages,
          chains: chains as Chain[],
          cutResult: cut,
          summaryText: null,
          mode: cfg.mode,
          flaggedIds,
          sessionId,
        });
      } catch (e) {
        if (e instanceof CompactionApplyError) return { didApply: false };
        throw e;
      }
      if (!applyResult.didApply) return { didApply: false };
      const ok = persistCompaction(sessionId, applyResult);
      if (!ok) return { didApply: false };
      setChatHistory(sessionId, [...applyResult.updatedMessages]);
      const tpc2 = trigger.state.tokensPerChar ?? tokensPerChar;
      const postTokens = Math.ceil(totalChars(applyResult.updatedMessages) * tpc2);
      trigger.onCompactionApplied(estimatedInput, postTokens);
      return { didApply: true, updatedMessages: [...applyResult.updatedMessages] };
    }
    if (decision.shouldPrepare) {
      // ── Selective branch ──────────────────────────────────────────────
      if (cfg.mode === 'selective') {
        const rawSlice = messages.slice(cut.compactableRange.start, cut.compactableRange.end);
        const slice = rawSlice.filter((m) => !m.excludeFromModel && !m.hidden);
        if (slice.length === 0) return { didApply: false };
        trigger.markPrepareStarted(cut.compactableRange, flaggedIds);
        const manifest = buildManifest(messages, cut.compactableRange);
        const selectiveCaller = createLlmSelectiveCaller({
          config: runtime.config,
          scope: 'main',
          fallbackSelection: selection,
          runtime,
          accounting: { store: accountingStore, sessionId, chainId, turnId },
        });
        const simpleFallback = async () => {
          const fb = await summarizeCompactableRange({
            messages: slice,
            scope: 'main',
            config: runtime.config,
            fallbackSelection: selection,
            accounting: { store: accountingStore, sessionId, chainId, turnId },
            runtime,
          });
          return fb ? { text: fb.text } : null;
        };
        let selResult: SelectiveCompactionResult;
        try {
          selResult = await runSelectiveCompaction({
            messages,
            compactableRange: cut.compactableRange,
            manifest,
            selectiveCaller,
            simpleFallback,
            maxCorrectionRounds: 3,
          });
        } catch (err) {
          console.debug('[compaction] selective run failed, falling back (non-fatal):', err);
          trigger.abortPrepare();
          return { didApply: false };
        }
        if (selResult.kind === 'selective') {
          const ok = persistSelectiveCompaction(sessionId, selResult, cut);
          if (!ok) {
            trigger.abortPrepare();
            return { didApply: false };
          }
          setChatHistory(sessionId, [...selResult.replayMessages]);
          const tpcSel = trigger.state.tokensPerChar ?? tokensPerChar;
          const postTokensSel = Math.ceil(totalChars(selResult.replayMessages) * tpcSel);
          trigger.onCompactionApplied(estimatedInput, postTokensSel);
          trigger.abortPrepare();
          return { didApply: true, updatedMessages: [...selResult.replayMessages] };
        }
        if (selResult.kind === 'fallback' && selResult.fallbackText && selResult.fallbackText.trim()) {
          let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
          try {
            applyResult = buildCompactionApply({
              messages,
              chains: chains as Chain[],
              cutResult: cut,
              summaryText: selResult.fallbackText,
              mode: cfg.mode,
              flaggedIds,
              sessionId,
            });
          } catch (e) {
            if (e instanceof CompactionApplyError) {
              trigger.abortPrepare();
              return { didApply: false };
            }
            throw e;
          }
          if (!applyResult.didApply) {
            if (selResult.replayMessages && selResult.replayMessages.length > 0) {
              // fallback replay without summary — single DB write via selective helper
              // If flaggedIds derived from manifest, use those; else use flaggedIds from reclaim
              const flaggedForLike = (selResult.flaggedIds ?? flaggedIds) as string[];
              const like2: Extract<SelectiveCompactionResult, { kind: 'selective' }> = { kind: 'selective', replayMessages: selResult.replayMessages!, flaggedIds: flaggedForLike, summaryMessages: [], summaryMessage: selResult.summaryMessage ?? null, correctedOps: [], attempts: selResult.attempts } as unknown as Extract<SelectiveCompactionResult, { kind: 'selective' }>;
              const ok2 = persistSelectiveCompaction(sessionId, like2, cut);
              if (ok2) {
                setChatHistory(sessionId, [...selResult.replayMessages!]);
                const tpcF = trigger.state.tokensPerChar ?? tokensPerChar;
                const postF = Math.ceil(totalChars(selResult.replayMessages!) * tpcF);
                trigger.onCompactionApplied(estimatedInput, postF);
              }
              trigger.abortPrepare();
              return { didApply: ok2, updatedMessages: ok2 ? [...selResult.replayMessages!] : undefined };
            }
            trigger.abortPrepare();
            return { didApply: false };
          }
          const ok = persistCompaction(sessionId, applyResult);
          if (!ok) {
            trigger.abortPrepare();
            return { didApply: false };
          }
          setChatHistory(sessionId, [...applyResult.updatedMessages]);
          const tpcF2 = trigger.state.tokensPerChar ?? tokensPerChar;
          const postF2 = Math.ceil(totalChars(applyResult.updatedMessages) * tpcF2);
          trigger.onCompactionApplied(estimatedInput, postF2);
          trigger.abortPrepare();
          return { didApply: true, updatedMessages: [...applyResult.updatedMessages] };
        }
        if (selResult.kind === 'fallback' && selResult.replayMessages && selResult.replayMessages.length > 0) {
          const flaggedForFallback = (selResult.flaggedIds ?? flaggedIds) as string[];
          const like3: Extract<SelectiveCompactionResult, { kind: 'selective' }> = { kind: 'selective', replayMessages: selResult.replayMessages, flaggedIds: flaggedForFallback, summaryMessages: [], summaryMessage: selResult.summaryMessage ?? null, correctedOps: [], attempts: selResult.attempts } as unknown as Extract<SelectiveCompactionResult, { kind: 'selective' }>;
          const ok3 = persistSelectiveCompaction(sessionId, like3, cut);
          if (!ok3) {
            trigger.abortPrepare();
            return { didApply: false };
          }
          setChatHistory(sessionId, [...selResult.replayMessages]);
          const tpcF3 = trigger.state.tokensPerChar ?? tokensPerChar;
          const postF3 = Math.ceil(totalChars(selResult.replayMessages) * tpcF3);
          trigger.onCompactionApplied(estimatedInput, postF3);
          trigger.abortPrepare();
          return { didApply: true, updatedMessages: [...selResult.replayMessages] };
        }
        trigger.abortPrepare();
        return { didApply: false };
      }
      // ── Simple branch (unchanged) ─────────────────────────────────────
      const rawSlice2 = messages.slice(cut.compactableRange.start, cut.compactableRange.end);
      const slice = rawSlice2.filter((m) => !m.excludeFromModel && !m.hidden);
      if (slice.length === 0) return { didApply: false };
      trigger.markPrepareStarted(cut.compactableRange, flaggedIds);
      const result = await summarizeCompactableRange({
        messages: slice,
        scope: 'main',
        config: runtime.config,
        fallbackSelection: selection,
        accounting: { store: accountingStore, sessionId, chainId, turnId },
        runtime,
      });
      if (!result || !result.text || !result.text.trim()) {
        trigger.abortPrepare();
        return { didApply: false };
      }
      let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
      try {
        applyResult = buildCompactionApply({
          messages,
          chains: chains as Chain[],
          cutResult: cut,
          summaryText: result.text,
          mode: cfg.mode,
          flaggedIds,
          sessionId,
        });
      } catch (e) {
        if (e instanceof CompactionApplyError) {
          trigger.abortPrepare();
          return { didApply: false };
        }
        throw e;
      }
      if (!applyResult.didApply) {
        trigger.abortPrepare();
        return { didApply: false };
      }
      const ok = persistCompaction(sessionId, applyResult);
      if (!ok) {
        trigger.abortPrepare();
        return { didApply: false };
      }
      setChatHistory(sessionId, [...applyResult.updatedMessages]);
      const tpcSimple = trigger.state.tokensPerChar ?? tokensPerChar;
      const postSimple = Math.ceil(totalChars(applyResult.updatedMessages) * tpcSimple);
      trigger.onCompactionApplied(estimatedInput, postSimple);
      trigger.abortPrepare();
      return { didApply: true, updatedMessages: [...applyResult.updatedMessages] };
    }
  } catch (err) {
    console.debug('[compaction] synchronous compact failed (non-fatal):', err);
    try { getCompactionTrigger(sessionId).abortPrepare(); } catch {}
  }
  return { didApply: false };
}

function handleUsageCompaction(
  sessionId: string,
  fullHistory: Message[],
  inputTokens: number,
  contextTokens: number,
  runtime: import('../../project/runtime').ProjectRuntime,
  selection: import('../../../shared/types/provider').ModelSelection,
  accountingStore: ReturnType<typeof getProviderAccountingStore>,
  chainId: string | null,
  turnId: string,
): void {
  const trigger = getCompactionTrigger(sessionId);
  const cfg = runtime.config.compaction?.main;
  if (!cfg) return;
  const effectiveContextTokens = Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : FALLBACK_CONTEXT_TOKENS;
  // Single-pass totalChars reuse + early threshold gate (avoids 4× scans per CHAT_USAGE)
  const totalCharsValue = totalChars(fullHistory);
  // Derive calibrated tokensPerChar from provider inputTokens / totalChars (no /4 fallback)
  let tokensPerChar: number | undefined = trigger.state.tokensPerChar;
  if (totalCharsValue > 0 && Number.isFinite(inputTokens) && inputTokens > 0) {
    const r = inputTokens / totalCharsValue;
    if (Number.isFinite(r) && r > 0) {
      const clamped = Math.max(0.05, Math.min(r, 2));
      tokensPerChar = clamped;
      trigger.state.tokensPerChar = clamped;
    }
  }
  trigger.state.lastObservedInputTokens = inputTokens;
  trigger.onUsage(inputTokens, effectiveContextTokens, cfg.threshold, cfg.hysteresis_delta);
  if (trigger.state.pendingPrepare) return;
  if (compactionPending.has(sessionId)) return;
  const isOverWindow = inputTokens >= effectiveContextTokens;
  if (!isOverWindow) {
    const ratio = inputTokens / effectiveContextTokens;
    if (ratio + 1e-9 < cfg.threshold) {
      const baseline = trigger.state.postCompactionInputTokens;
      if (!(trigger.state.hysteresisArmed && typeof baseline === 'number' && Number.isFinite(baseline) && inputTokens - baseline >= cfg.min_compactable_tokens)) {
        return;
      }
    }
  }
  try {
    const calibratedEstimator2 = (slice: readonly Message[]): number => {
      let chars = 0;
      for (const m of slice) {
        if (m.content) chars += m.content.length;
        if (m.thinking) chars += m.thinking.length;
        if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
        if (m.tool_result) chars += JSON.stringify(m.tool_result).length;
        if (m.tool_call_id) chars += m.tool_call_id.length;
        if (m.name) chars += m.name.length;
        if ((m as unknown as { compacted?: unknown }).compacted) chars += JSON.stringify((m as unknown as { compacted: unknown }).compacted).length;
      }
      return Math.max(slice.length, Math.ceil(chars * (tokensPerChar ?? 0.25)));
    };
    const cut = selectCut(fullHistory, { keepRecentChains: cfg.keep_recent_chains, budget: { contextTokens: effectiveContextTokens, threshold: cfg.threshold }, tokenEstimator: calibratedEstimator2 });
    if (cut.compactableRange.end <= cut.compactableRange.start) return;
    if (tokensPerChar == null || !Number.isFinite(tokensPerChar) || tokensPerChar <= 0) {
      tokensPerChar = 0.25;
    }
    const compactableTokens = compactableTokenEstimate(fullHistory, cut.compactableRange, tokensPerChar);
    if (compactableTokens < cfg.min_compactable_tokens) return;
    const reclaim = mechanicalReclaim(fullHistory, cut.compactableRange);
    const flaggedIds = reclaim.flaggedIds;
    const decision = trigger.evaluateWithReclaim({
      inputTokens,
      contextTokens: effectiveContextTokens,
      threshold: cfg.threshold,
      hysteresisDelta: cfg.hysteresis_delta,
      compactableTokens,
      minCompactableTokens: cfg.min_compactable_tokens,
      compactableRange: cut.compactableRange,
      messages: fullHistory,
      flaggedIds,
    });
    if (!decision.shouldPrepare && !decision.shouldApply) return;
    if (decision.shouldApply && !decision.shouldPrepare) {
      const expectedIds = fullHistory.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
      compactionPending.set(sessionId, { cut, flaggedIds, expectedIds, estimatedInput: inputTokens, contextTokens: effectiveContextTokens, mode: cfg.mode });
      trigger.markPrepareStarted(cut.compactableRange, flaggedIds);
      try {
        const active = activeAgents.get(sessionId);
        if (active && !active.finalized) {
          const compactionToolId = `compaction-${sessionId}`;
          ensureToolSnapshot(active, compactionToolId, 'compaction');
          updateToolSnapshot(active, compactionToolId, 'compaction', { status: 'running', args: JSON.stringify({ phase: 'reclaiming', mode: cfg.mode }), content: null, toolResult: null, finishedAt: null });
          const wc = webContentsForWindowId(active.windowId);
          if (wc) sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'running', args: JSON.stringify({ phase: 'reclaiming', mode: cfg.mode }) });
        }
      } catch {}
      if (!shouldPauseForCompaction(sessionId)) {
        requestCompactionPause(sessionId);
        publishSessionActivity(sessionId, { cwd: runtime.projectDir ?? '', state: 'working', phase: 'agent', detail: 'Compacting context — reclaiming duplicates…', canCancel: true });
      }
      return;
    }
    if (decision.shouldPrepare) {
      // ── Selective pending branch ──────────────────────────────────────
      if (cfg.mode === 'selective') {
        const rawSlice = fullHistory.slice(cut.compactableRange.start, cut.compactableRange.end);
        const slice = rawSlice.filter((m) => !m.excludeFromModel && !m.hidden);
        if (slice.length === 0) return;
        trigger.markPrepareStarted(cut.compactableRange, flaggedIds);
        const manifest = buildManifest(fullHistory, cut.compactableRange);
        const selectiveCaller = createLlmSelectiveCaller({
          config: runtime.config,
          scope: 'main',
          fallbackSelection: selection,
          runtime,
          accounting: { store: accountingStore, sessionId, chainId, turnId },
        });
        const simpleFallback = async () => {
          const fb = await summarizeCompactableRange({
            messages: slice,
            scope: 'main',
            config: runtime.config,
            fallbackSelection: selection,
            accounting: { store: accountingStore, sessionId, chainId, turnId },
            runtime,
          });
          return fb ? { text: fb.text } : null;
        };
        const selectivePromise = runSelectiveCompaction({
          messages: fullHistory,
          compactableRange: cut.compactableRange,
          manifest,
          selectiveCaller,
          simpleFallback,
          maxCorrectionRounds: 3,
        });
        const expectedIdsForSelective = fullHistory.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
        compactionPending.set(sessionId, { cut, flaggedIds, expectedIds: expectedIdsForSelective, estimatedInput: inputTokens, contextTokens: effectiveContextTokens, mode: 'selective', selectivePromise, manifest });
        selectivePromise.catch((err) => {
          console.debug('[compaction] selective prepare failed (non-fatal):', err);
          try {
            const active = activeAgents.get(sessionId);
            if (active && !active.finalized) {
              const compactionToolId = `compaction-${sessionId}`;
              const wc = webContentsForWindowId(active.windowId);
              const result = { schemaVersion: 1 as const, family: 'generic' as const, status: 'complete' as const, completeness: 'complete' as const, data: { value: '', origin: { kind: 'built-in' as const, name: 'compaction' } } };
              updateToolSnapshot(active, compactionToolId, 'compaction', { status: 'complete', args: '', content: '', toolResult: result as unknown as never, finishedAt: new Date().toISOString() });
              if (wc) sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'complete', args: '', content: '', toolResult: result as unknown as Record<string, unknown> });
            }
          } catch {}
        });
        try {
          const active = activeAgents.get(sessionId);
          if (active && !active.finalized) {
            const compactionToolId = `compaction-${sessionId}`;
            ensureToolSnapshot(active, compactionToolId, 'compaction');
            updateToolSnapshot(active, compactionToolId, 'compaction', { status: 'running', args: JSON.stringify({ phase: 'summarizing', mode: 'selective' }), content: null, toolResult: null, finishedAt: null });
            const wc = webContentsForWindowId(active.windowId);
            if (wc) sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'running', args: JSON.stringify({ phase: 'summarizing', mode: 'selective' }) });
          }
        } catch {}
        if (!shouldPauseForCompaction(sessionId)) {
          requestCompactionPause(sessionId);
          publishSessionActivity(sessionId, { cwd: runtime.projectDir ?? '', state: 'working', phase: 'agent', detail: 'Compacting context — summarizing history…', canCancel: true });
        }
        return;
      }
      // ── Simple pending branch (unchanged) ─────────────────────────────
      const rawSlice2 = fullHistory.slice(cut.compactableRange.start, cut.compactableRange.end);
      const slice = rawSlice2.filter((m) => !m.excludeFromModel && !m.hidden);
      if (slice.length === 0) return;
      trigger.markPrepareStarted(cut.compactableRange, flaggedIds);
      const promise = summarizeCompactableRange({
        messages: slice,
        scope: 'main',
        config: runtime.config,
        fallbackSelection: selection,
        accounting: { store: accountingStore, sessionId, chainId, turnId },
        runtime,
      });
      const expectedIdsForSimple = fullHistory.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
      compactionPending.set(sessionId, { cut, flaggedIds, expectedIds: expectedIdsForSimple, promise, estimatedInput: inputTokens, contextTokens: effectiveContextTokens, mode: 'simple' });
      promise.catch((err) => {
        console.debug('[compaction] prepare failed (non-fatal):', err);
        try {
          const active = activeAgents.get(sessionId);
          if (active && !active.finalized) {
            const compactionToolId = `compaction-${sessionId}`;
            const wc = webContentsForWindowId(active.windowId);
            const result = { schemaVersion: 1 as const, family: 'generic' as const, status: 'complete' as const, completeness: 'complete' as const, data: { value: '', origin: { kind: 'built-in' as const, name: 'compaction' } } };
            updateToolSnapshot(active, compactionToolId, 'compaction', { status: 'complete', args: '', content: '', toolResult: result as unknown as never, finishedAt: new Date().toISOString() });
            if (wc) sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'complete', args: '', content: '', toolResult: result as unknown as Record<string, unknown> });
          }
        } catch {}
      });
      try {
        const active = activeAgents.get(sessionId);
        if (active && !active.finalized) {
          const compactionToolId = `compaction-${sessionId}`;
          ensureToolSnapshot(active, compactionToolId, 'compaction');
          updateToolSnapshot(active, compactionToolId, 'compaction', { status: 'running', args: JSON.stringify({ phase: 'summarizing', mode: 'simple' }), content: null, toolResult: null, finishedAt: null });
          const wc = webContentsForWindowId(active.windowId);
          if (wc) sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'running', args: JSON.stringify({ phase: 'summarizing', mode: 'simple' }) });
        }
      } catch {}
      if (!shouldPauseForCompaction(sessionId)) {
        requestCompactionPause(sessionId);
        publishSessionActivity(sessionId, { cwd: runtime.projectDir ?? '', state: 'working', phase: 'agent', detail: 'Compacting context — summarizing history…', canCancel: true });
      }
    }
  } catch (err) {
    console.debug('[compaction] usage trigger failed (non-fatal):', err);
  }
}

export async function startChatTurn(
  webContents: WebContents,
  { message, model: preferredModel, sessionId: requestedSessionId, draftGeneration }: ChatSendPayload,
) {
  const windowId = String(webContents.id);
  const sessionGate = await Promise.resolve(
    ensureActiveSessionSingleFlight(webContents, preferredModel, requestedSessionId, draftGeneration),
  );
  if (!sessionGate.ok) return sessionGate.result;

  const sessionId = sessionGate.session.id;
  clearNextRequestStop(sessionId);
  clearCompactionPause(sessionId);
  if (sessionsStarting.has(sessionId)) {
    return { status: 'error', error: 'A turn is already starting for this session.', kind: 'session_busy' };
  }
  sessionsStarting.add(sessionId);
  const existing = activeAgents.get(sessionId);
  const runtime = sessionGate.runtime;
  try {
    await awaitSessionSubagentHydration(getSubagentManager(), sessionId, {
      projectRuntime: runtime,
      windowId,
      cwd: sessionGate.cwd,
    });
  } catch (error) {
    sessionsStarting.delete(sessionId);
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      kind: 'runtime_hydration_failed',
    };
  }
  if (existing) forceAbortSession(sessionId);
  publishSessionActivity(sessionId, {
    cwd: sessionGate.cwd, state: 'working', phase: 'agent', detail: 'Generating response',
    startedAt: Date.now(), completedAt: null, unread: false, canCancel: true,
  });
  const turnSelection = sessionGate.session.selection;
  if (turnSelection == null) {
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error',
      error: 'A provider connection and model are required before sending a message.',
      kind: 'provider_required',
    };
  }

  let existingMessages: Message[];
  try {
    existingMessages = getChatHistory(sessionId) ?? historyFromSession(sessionId);
  } catch (error) {
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error',
      error: `Could not load complete conversation history: ${
        error instanceof Error ? error.message : String(error)
      }`,
      kind: 'history_load_failed',
    };
  }

  let modelInstance: LanguageModelV4;
  let providerSnapshot: ProviderAttemptAccountingContext['snapshot'];
  let providerOptions: ReasoningProviderOptions | undefined;
  let pricingFacet: ProviderAttemptAccountingContext['pricingFacet'];
  let thinkingPolicy: ThinkingPolicy | undefined;
  let cacheFacet: CacheFacet | undefined;
  let cacheTtl: string | undefined;
  let cacheSessionKey: string | undefined;
  let tierMechanism: ProviderAttemptAccountingContext['tierMechanism'];
  let accountingStore: ReturnType<typeof getProviderAccountingStore>;
  let contextTokens: number | null = null;
  try {
    accountingStore = getProviderAccountingStore();
    // Resolve the effective tier before model construction so the variant
    // mapping and the frozen snapshot both observe the same selection (R21).
    const tierContext = await getProviderRuntime().resolveTierContext(turnSelection);
    const effectiveTier = resolveMainAgentTier(
      sessionGate.session,
      tierContext.connection,
      turnSelection.modelId,
      tierContext.tierMechanism,
    );
    const execution = await getProviderRuntime().resolveExecution(
      turnSelection,
      effectiveTier !== undefined ? { tier: effectiveTier } : {},
    );
    tierMechanism = execution.tierMechanism;
    modelInstance = execution.modelInstance;
    providerSnapshot = execution.snapshot;
    pricingFacet = execution.pricingFacet;
    thinkingPolicy = execution.thinkingPolicy;
    cacheFacet = execution.cacheFacet;
    contextTokens = execution.model.limits?.contextTokens ?? null;
    const effort = resolveMainAgentEffort(
      sessionGate.session, execution.connection, turnSelection.modelId,
      execution.model.capabilities?.reasoning === true,
    );
    providerOptions = effort === undefined ? undefined : execution.buildReasoningOptions?.(effort);
    const facetOptions = assembleFacetProviderOptions({
      providerOptions,
      thinkingPolicy,
      providerId: execution.snapshot.providerId,
      tierId: resolveMainAgentTier(
        sessionGate.session, execution.connection, turnSelection.modelId, execution.tierMechanism,
      ),
      tierMechanism: execution.tierMechanism,
      cacheFacet,
      cacheTtlSelection: execution.connection.cacheTtl,
      sessionId,
    });
    providerOptions = facetOptions.providerOptions;
    cacheSessionKey = facetOptions.cacheSessionKey;
    cacheTtl = facetOptions.cacheTtl;
  } catch (error) {
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error', error: error instanceof Error ? error.message : String(error),
      kind: 'provider_unavailable',
    };
  }

  const agents = [...runtime.agents.values()];
  const userMessage = makeUserMessage(message);
  const priorMessageCount = existingMessages.length;
  let messages: Message[] = [...existingMessages, userMessage];
  const thinkingReplay: ThinkingReplayContext = {
    policy: thinkingPolicy ?? DEFAULT_THINKING_POLICY,
    selection: { providerId: providerSnapshot.providerId, modelId: turnSelection.modelId },
    protocol: providerSnapshot.protocol as ProviderProtocol,
  };
  const agent = agents.find((candidate) => candidate.name === 'general') ?? agents[0] ?? {
    name: 'general', type: 'subagent' as const, tier: 'bloom' as const,
    description: 'General-purpose agent', system_prompt: 'You are a helpful assistant.',
    allowed_tools: ['*'], allowed_skills: ['*'],
  };
  const sessionManager = getSessionManager();
  const turnCtx: ToolExecutionContext = {
    cwd: sessionGate.cwd, sessionId, windowId, projectRuntime: runtime,
    agentScopeId: 'main', selection: turnSelection,
  };
  let turnId: string = crypto.randomUUID();
  let chainId: string | null = null;

  {
    const effectiveContextTokens = contextTokens != null && contextTokens > 0 ? contextTokens : FALLBACK_CONTEXT_TOKENS;
    const pendingApplied = await applyPendingCompactionIfAny(sessionId, messages, runtime);
    if (pendingApplied.applied && pendingApplied.updatedMessages) {
      messages = pendingApplied.updatedMessages;
      existingMessages = messages.slice(0, messages.length - 1);
    }
    const syncResult = await tryCompactSynchronously(sessionId, messages, runtime, turnSelection, effectiveContextTokens, accountingStore!, chainId, turnId);
    if (syncResult.didApply && syncResult.updatedMessages) {
      messages = syncResult.updatedMessages;
      existingMessages = messages.slice(0, messages.length - 1);
    }
  }

  try {
    const chain = sessionManager.startChain({
      selection: turnSelection, modelLabel: turnSelection.modelId, agentName: agent.name,
      agentType: agent.type, agentTier: agent.tier, messages: [userMessage],
    }, sessionId);
    chainId = chain?.id ?? null;
    turnId = chain?.id ?? turnId;
    emitSessionUpdated(webContents, sessionId);
  } catch (error) {
    console.debug('startChain failed (non-fatal):', error);
  }

  const abortController = new AbortController();
  const baseSystemPrompt = agent.system_prompt || 'You are a helpful assistant.';
  try {
    const rootAgentsMdEntry = findRootAgentsMdEntry(runtime.projectDir, runtime.config);
    if (rootAgentsMdEntry) sessionManager.getAgentsMdContextStore(sessionId).seedRoot(rootAgentsMdEntry);
  } catch (error) {
    console.debug('seedRoot AGENTS.md context failed (non-fatal):', error);
  }
  const accounting: ProviderAttemptAccountingContext = {
    store: accountingStore, sessionId, chainId, turnId, snapshot: providerSnapshot,
    agentScope: 'main', agentName: agent.name, agentType: agent.type, agentTier: agent.tier,
   attemptIdHolder: { value: null }, pricingFacet, tierMechanism,
  };
  const mcpManager = acquireProjectMCPManager(runtime);
  let resourcesReleased = false;
  const releaseResources = () => {
    if (resourcesReleased) return;
    resourcesReleased = true;
    releaseProjectMCPManager(runtime);
  };
  let actor: ReturnType<typeof createActor<typeof agentMachine>>;
  let interruptActor: ReturnType<typeof createActor<typeof interruptMachine>>;
  try {
    const turnRegistry = getBuiltinToolRegistryForRuntime(runtime, {
      agents: new Map(runtime.agents), skills: new Map(runtime.skills), mcpManager,
    });
    const personalityPrompt = appendProjectPersonality(baseSystemPrompt, runtime);
    let fullSystemPrompt = personalityPrompt;
    try {
      fullSystemPrompt = appendRootAgentsMd(personalityPrompt, runtime);
    } catch (error) {
      console.debug('root AGENTS.md injection failed (non-fatal):', error);
    }
    actor = createActor(agentMachine, {
      input: {
        agent, systemPrompt: fullSystemPrompt,
        streamFn: createProviderStreamFn({
          messages, runtime, sessionId, windowId, modelInstance, accounting, registry: turnRegistry,
          mcpManager, providerOptions, thinkingReplay,
          cachePlacement: cacheFacet
            ? { facet: cacheFacet, ttl: cacheTtl, sessionKey: cacheSessionKey }
            : undefined,
        }),
      },
    });
    interruptActor = createActor(interruptMachine);
  } catch (error) {
    releaseResources();
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error', error: error instanceof Error ? error.message : String(error),
      kind: 'runtime_hydration_failed',
    };
  }

  let lastSentLength = 0;
  let lastThinkingLength = 0;
  let completed = false;
  let overflowRetryInFlight = false;
  let subscription: { unsubscribe: () => void } | null = null;
  let interruptSubscription: { unsubscribe: () => void } | null = null;
  let lastUsage: Usage | null = null;
  let interruptResetTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStreamingToolCallId: string | null = null;
  const lastStreamingToolArgLength = new Map<string, number>();
  let lastToolUpdateSequence = 0;
  let lastActivityKey = 'streaming:agent:Generating response';
  const generation = nextAgentGeneration(sessionId);
  const activeAgent: ActiveAgent = {
    sessionId, windowId, turnId, cwd: turnCtx.cwd, startedAt: Date.now(), actor, interruptActor,
    abortController, messages, priorMessageCount: messages.length - 1, turnMessages: [], responseCommittedLength: 0,
    thinkingCommittedLength: 0, thinkingArtifactsCommitted: 0, agent, selection: turnSelection,
    thinkingReplay, agentCancelled: false,
    finalized: false, generation, eventSequence: 0, lastChatState: null, toolCalls: new Map(),
    streamSegments: [], unsubscribe: () => subscription?.unsubscribe(),
    interruptUnsubscribe: () => interruptSubscription?.unsubscribe(), interruptResetTimer: null,
    sessionTitleTimer: null, runtime, chainId,
    releaseResources,
  };
  activeAgents.set(sessionId, activeAgent);
  sessionsStarting.delete(sessionId);

  // A long-running first turn must not leave the session unnamed forever:
  // after the configured wait, name from the current in-flight history even
  // while the agent keeps working. 0 disables the deadline.
  const titleWaitSeconds = runtime.config.session_title_max_wait_seconds;
  if (titleWaitSeconds > 0 && sessionGate.session.name.startsWith('Session ')) {
    const titleTimer = setTimeout(() => {
      activeAgent.sessionTitleTimer = null;
      if (!isCurrentAgent(sessionId, activeAgent)) return;
      if (activeAgent.finalized || activeAgent.agentCancelled) return;
      const current = sessionManager.getSession(sessionId);
      if (!current || !current.name.startsWith('Session ')) return;
      triggerSessionAutoName({
        sessionId,
        runtime,
        webContents,
        messages: currentTurnSnapshot(activeAgent, actor.getSnapshot().context as AgentContext),
        fallbackSelection: activeAgent.selection,
        accounting: { store: accountingStore, sessionId, chainId, turnId },
      });
    }, Math.round(titleWaitSeconds * 1000));
    activeAgent.sessionTitleTimer = titleTimer;
  }

  const flushResponseSegment = (fullResponse: string, attachUsage: Usage | null = null) => {
    if (fullResponse.length <= activeAgent.responseCommittedLength) return;
    const segment = fullResponse.slice(activeAgent.responseCommittedLength);
    const segmentId = textSegmentIdAtOffset(activeAgent, 'text', activeAgent.responseCommittedLength);
    activeAgent.responseCommittedLength = fullResponse.length;
    if (!segment.trim() && !attachUsage) return;
    activeAgent.turnMessages.push(makeAssistantMessage(segment, attachUsage, segmentId));
  };
  const flushThinkingSegment = (
    context: Pick<AgentContext, 'thinking' | 'thinkingPayloads' | 'thinkingArtifacts'>,
  ) => {
    const fullThinking = context.thinking ?? '';
    if (fullThinking.length > activeAgent.thinkingCommittedLength) {
      const segment = fullThinking.slice(activeAgent.thinkingCommittedLength);
      const segmentId = textSegmentIdAtOffset(activeAgent, 'thinking', activeAgent.thinkingCommittedLength);
      const payload = context.thinkingPayloads?.[fullThinking.length];
      activeAgent.thinkingCommittedLength = fullThinking.length;
      if (segment.trim()) {
        activeAgent.turnMessages.push(makeThinkingMessage(segment, segmentId, payload));
      }
    }
    const artifacts = context.thinkingArtifacts ?? [];
    for (let index = activeAgent.thinkingArtifactsCommitted; index < artifacts.length; index += 1) {
      activeAgent.turnMessages.push(makeThinkingMessage('', undefined, artifacts[index]));
    }
    activeAgent.thinkingArtifactsCommitted = artifacts.length;
  };
  // Opaque thinking renders as an indicator with a token count (R17); the
  // provider reports reasoning tokens per step, so only a single text-less
  // artifact can be stamped unambiguously.
  const stampOpaqueThinkingTokenCount = (usage: Usage | null) => {
    const reasoningTokens = usage?.reasoning_tokens;
    if (!reasoningTokens) return;
    const candidates = activeAgent.turnMessages.filter((message) =>
      message.type === MessageType.THINKING
      && !message.content
      && message.thinking_payload
      && message.thinking_payload.reasoningTokenCount === undefined);
    if (candidates.length !== 1) return;
    const target = candidates[0];
    const index = activeAgent.turnMessages.indexOf(target);
    activeAgent.turnMessages[index] = {
      ...target,
      thinking_payload: { ...target.thinking_payload!, reasoningTokenCount: reasoningTokens },
    };
  };
  const finalizeTurn = (opts: { response: string; usage: Usage | null; interrupted: boolean; sendDone: boolean }) => {
    if (activeAgent.finalized) return;
    activeAgent.finalized = true;
    completed = true;
    if (activeAgent.sessionTitleTimer) {
      clearTimeout(activeAgent.sessionTitleTimer);
      activeAgent.sessionTitleTimer = null;
    }
    flushThinkingSegment(activeAgent.actor.getSnapshot().context as AgentContext);
    stampOpaqueThinkingTokenCount(opts.usage);
    const remaining = opts.response.slice(activeAgent.responseCommittedLength);
    if (remaining || (opts.interrupted && activeAgent.responseCommittedLength === 0 && !opts.response)) {
      activeAgent.turnMessages.push(makeAssistantMessage(
        remaining || opts.response || '', opts.usage,
        textSegmentIdAtOffset(activeAgent, 'text', activeAgent.responseCommittedLength),
      ));
      activeAgent.responseCommittedLength = opts.response.length;
    } else if (opts.usage && !attachUsageToLatestAssistant(activeAgent.turnMessages, opts.usage)) {
      activeAgent.turnMessages.push({ ...makeAssistantMessage('', opts.usage), hidden: true });
    }
    const turnExtras = [...activeAgent.turnMessages];
    const terminalMessages = turnMessagesFromAgent(activeAgent);
    const fullHistory = [...messages, ...turnExtras];
    // keep hysteresis calibrated with final usage
    if (opts.usage && contextTokens != null) {
      const inputTokens = opts.usage.context?.input_tokens ?? opts.usage.prompt_tokens;
      const trig = getCompactionTrigger(sessionId);
      trig.observeUsage(inputTokens, fullHistory);
      trig.onUsage(inputTokens, contextTokens, runtime.config.compaction.main.threshold, runtime.config.compaction.main.hysteresis_delta);
    }
    persistTurnConversation(
      sessionId, fullHistory, terminalMessages,
      opts.interrupted ? ChainStatus.INTERRUPTED : ChainStatus.COMPLETED,
      agent, activeAgent.selection, webContents,
    );
    activeAgent.messages = fullHistory;
    completeSessionActivity(sessionId, getSessionManager().getActive(windowId)?.id !== sessionId);
    if (opts.sendDone) {
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_DONE, {
        type: 'done', response: opts.response, messages: terminalMessages,
        interrupted: opts.interrupted, usage: opts.usage,
      });
    }
    // Interrupted turns name too: the user's request is already on record and
    // an abandoned first turn should not stay "Session …" forever. The trigger
    // dedupes against a mid-turn deadline attempt already in flight.
    triggerSessionAutoName({
      sessionId,
      runtime,
      webContents,
      messages: fullHistory,
      fallbackSelection: activeAgent.selection,
      accounting: { store: accountingStore, sessionId, chainId, turnId },
    });
    compactionRetryTried.delete(`${sessionId}:${turnId}`);
  };

  interruptSubscription = interruptActor.subscribe((interruptSnapshot) => {
    if (!isCurrentAgent(sessionId, activeAgent)) return;
    const interruptState = interruptSnapshot.value as 'idle' | 'confirmAgent' | 'confirmSubagents';
    if (interruptResetTimer) {
      clearTimeout(interruptResetTimer);
      interruptResetTimer = null;
      activeAgent.interruptResetTimer = null;
    }
    if (interruptState !== 'idle') {
      interruptResetTimer = setTimeout(() => interruptActor.send({ type: 'INTERRUPT_TIMEOUT' }), 5000);
      activeAgent.interruptResetTimer = interruptResetTimer;
    } else if (activeAgent.agentCancelled) {
      queueMicrotask(() => {
        if (activeAgents.get(sessionId) === activeAgent) disposeActiveAgent(sessionId, activeAgent);
      });
    }
    const context = actor.getSnapshot().context as AgentContext;
    sendChatState(webContents, activeAgent, {
      state: String(actor.getSnapshot().value), error: context.error, interruptState, cwd: turnCtx.cwd,
    });
  });

  subscription = actor.subscribe((snapshot) => {
    if (!canEmitStreamEvents(sessionId, activeAgent)) return;
    const context = snapshot.context as AgentContext;
    const activityDetail = context.streamingToolCall?.toolName
      ? `Preparing ${context.streamingToolCall.toolName}`
      : 'Generating response';
    const activityKey = `${String(snapshot.value)}:agent:${activityDetail}`;
    if (activityKey !== lastActivityKey) {
      lastActivityKey = activityKey;
      publishSessionActivity(sessionId, {
        cwd: turnCtx.cwd, state: 'working', phase: 'agent', detail: activityDetail, canCancel: true,
      });
    }
    if (context.response.length > lastSentLength) {
      const newContent = context.response.slice(lastSentLength);
      lastSentLength = context.response.length;
      const segmentId = appendTextSegment(activeAgent, 'text', newContent);
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_CHUNK, { type: 'chunk', data: newContent, segmentId });
    }
    const thinking = context.thinking ?? '';
    if (thinking.length > lastThinkingLength) {
      const newThinking = thinking.slice(lastThinkingLength);
      lastThinkingLength = thinking.length;
      const segmentId = appendTextSegment(activeAgent, 'thinking', newThinking);
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_THINKING, { type: 'thinking', data: newThinking, segmentId });
    }
    const interruptState = interruptActor.getSnapshot().value as 'idle' | 'confirmAgent' | 'confirmSubagents';
    sendChatState(webContents, activeAgent, {
      state: String(snapshot.value), error: context.error, interruptState, cwd: turnCtx.cwd,
    });
    if (context.usage && context.usage !== lastUsage) {
      lastUsage = context.usage;
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_USAGE, { type: 'usage', usage: context.usage });
      checkpointActiveTurn(activeAgent, context);
      if (contextTokens != null) {
        const inputTokens = context.usage.context?.input_tokens ?? context.usage.prompt_tokens;
        const fullHistory = [...messages, ...turnMessagesFromAgent(activeAgent)];
        handleUsageCompaction(sessionId, fullHistory, inputTokens, contextTokens, runtime, turnSelection, accountingStore!, chainId, turnId);
      }
    }
    if (context.streamingToolCall) {
      const stc = context.streamingToolCall;
      if (stc.toolCallId !== lastStreamingToolCallId) {
        lastStreamingToolCallId = stc.toolCallId;
        lastStreamingToolArgLength.set(stc.toolCallId, 0);
        ensureToolSnapshot(activeAgent, stc.toolCallId, stc.toolName);
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_START, {
          type: 'tool_call_start', toolCallId: stc.toolCallId, toolName: stc.toolName,
        });
      }
      const previousLength = lastStreamingToolArgLength.get(stc.toolCallId) ?? 0;
      const argsDelta = stc.partialArgs.slice(previousLength);
      if (argsDelta) {
        lastStreamingToolArgLength.set(stc.toolCallId, stc.partialArgs.length);
        const current = ensureToolSnapshot(activeAgent, stc.toolCallId, stc.toolName);
        updateToolSnapshot(activeAgent, stc.toolCallId, stc.toolName, { partialArgs: current.partialArgs + argsDelta });
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_DELTA, {
          type: 'tool_call_delta', toolCallId: stc.toolCallId, argsDelta,
        });
      }
    } else if (lastStreamingToolCallId) {
      lastStreamingToolCallId = null;
    }
    if (context.toolLifecycleUpdate && context.toolLifecycleUpdate.sequence !== lastToolUpdateSequence) {
      const update = context.toolLifecycleUpdate;
      lastToolUpdateSequence = update.sequence;
      updateToolSnapshot(activeAgent, update.toolCallId, update.toolName ?? 'unknown', {
        toolName: update.toolName ?? 'unknown', status: update.status, args: update.args ?? '',
        content: update.content ?? null, toolResult: update.toolResult ?? null,
        finishedAt: update.status === 'running' ? null : new Date().toISOString(),
      });
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, {
        type: 'tool_call_update', toolCallId: update.toolCallId, toolName: update.toolName,
        status: update.status, args: update.args, content: update.content, toolResult: update.toolResult,
      });
      if (update.status === 'running' && update.args != null) {
        const already = activeAgent.turnMessages.some((entry) =>
          entry.type === MessageType.TOOL_CALL && entry.tool_call_id === update.toolCallId,
        );
        if (!already) {
          flushThinkingSegment(context);
          flushResponseSegment(context.response);
          activeAgent.turnMessages.push(makeToolCallMessage(
            update.toolCallId, update.toolName ?? 'unknown', update.args,
          ));
        }
      }
      if (update.status !== 'running') {
        const hasCall = activeAgent.turnMessages.some((entry) =>
          entry.type === MessageType.TOOL_CALL && entry.tool_call_id === update.toolCallId,
        );
        if (!hasCall) {
          flushThinkingSegment(context);
          flushResponseSegment(context.response);
          activeAgent.turnMessages.push(makeToolCallMessage(
            update.toolCallId, update.toolName ?? 'unknown', update.args ?? '{}',
          ));
        }
        const hasResult = activeAgent.turnMessages.some((entry) =>
          entry.type === MessageType.TOOL_RESULT && entry.tool_call_id === update.toolCallId,
        );
        if (!hasResult) {
          const toolResultMessage = makeToolResultMessage(
            update.toolCallId, update.toolName ?? 'unknown', update.content ?? '', update.toolResult!,
          );
          activeAgent.turnMessages.push(
            update.toolResult?.status === 'cancelled'
              ? { ...toolResultMessage, excludeFromModel: true }
              : toolResultMessage,
          );
        }
      }
    }
    if (snapshot.value === 'idle' && context.currentInput && !completed && !activeAgent.agentCancelled) {
      if (shouldPauseForCompaction(sessionId)) {
        clearCompactionPause(sessionId);
        const fullHistoryForPause = [...messages, ...turnMessagesFromAgent(activeAgent)];
        publishSessionActivity(sessionId, { cwd: turnCtx.cwd, state: 'working', phase: 'agent', detail: 'Compacting context — applying summary…', canCancel: true });
        const compactionToolId = `compaction-${sessionId}`;
        ensureToolSnapshot(activeAgent, compactionToolId, 'compaction');
        updateToolSnapshot(activeAgent, compactionToolId, 'compaction', { status: 'running', args: JSON.stringify({ phase: 'compacting' }), content: null, toolResult: null, finishedAt: null });
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'running', args: JSON.stringify({ phase: 'compacting' }) });
        (async () => {
          try {
            let applied = false;
            let updated: Message[] | undefined;
            const pendingRes = await applyPendingCompactionIfAny(sessionId, fullHistoryForPause, runtime);
            if (pendingRes.applied && pendingRes.updatedMessages) {
              applied = true;
              updated = pendingRes.updatedMessages;
            }
            if (applied && updated) {
              messages.splice(0, messages.length, ...updated);
              activeAgent.messages.splice(0, activeAgent.messages.length, ...updated);
              activeAgent.turnMessages = [];
              activeAgent.responseCommittedLength = 0;
              activeAgent.thinkingCommittedLength = 0;
              activeAgent.thinkingArtifactsCommitted = 0;
              lastSentLength = 0;
              lastThinkingLength = 0;
              lastUsage = null;
              try {
                actor.send({ type: 'USER_INPUT', message });
                publishSessionActivity(sessionId, { cwd: turnCtx.cwd, state: 'working', phase: 'agent', detail: 'Resuming after compaction', canCancel: true });
                const compactionCompleteResult = {
                  schemaVersion: 1 as const,
                  family: 'generic' as const,
                  status: 'complete' as const,
                  completeness: 'complete' as const,
                  data: { value: 'Context compacted — resuming', origin: { kind: 'built-in' as const, name: 'compaction' } },
                };
                updateToolSnapshot(activeAgent, compactionToolId, 'compaction', { status: 'complete', args: '', content: 'Context compacted — resuming', toolResult: compactionCompleteResult as unknown as typeof activeAgent.toolCalls extends Map<string, infer V> ? V extends { toolResult: infer R } ? R : never : never, finishedAt: new Date().toISOString() });
                sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'complete', args: '', content: 'Context compacted — resuming', toolResult: compactionCompleteResult as unknown as Record<string, unknown> });
                return;
              } catch (e) {
                console.debug('[compaction] mid-turn resume failed:', e);
              }
            }
          } catch (e) {
            console.debug('[compaction] mid-turn pause handling failed:', e);
          }
          {
            const compactionCompleteResult = {
              schemaVersion: 1 as const,
              family: 'generic' as const,
              status: 'complete' as const,
              completeness: 'complete' as const,
              data: { value: '', origin: { kind: 'built-in' as const, name: 'compaction' } },
            };
            updateToolSnapshot(activeAgent, compactionToolId, 'compaction', { status: 'complete', args: '', content: '', toolResult: compactionCompleteResult as unknown as never, finishedAt: new Date().toISOString() });
            sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'complete', args: '', content: '', toolResult: compactionCompleteResult as unknown as Record<string, unknown> });
          }
          clearCompactionPause(sessionId);
          finalizeTurn({ response: context.response, usage: context.usage ?? null, interrupted: false, sendDone: true });
          queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
        })();
        return;
      }
      finalizeTurn({ response: context.response, usage: context.usage ?? null, interrupted: false, sendDone: true });
      queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
    }
    if (snapshot.value === 'error') {
      const detail = context.error ?? 'Unknown error';
      const title = context.errorTitle ?? 'Stream Error';
      const isOverflow = isContextLengthExceededError(`${title} ${detail}`);
      const retryKey = `${sessionId}:${turnId}`;
      if (isOverflow && !compactionRetryTried.has(retryKey) && contextTokens != null) {
        if (overflowRetryInFlight) return;
        compactionRetryTried.add(retryKey);
        overflowRetryInFlight = true;
        // One compaction-and-retry (R15). Compact the prefix (messages) and retry once before declaring failed.
        const historyForRetry = [...messages];
        (async () => {
          try {
            try {
              const retryResult = await tryCompactSynchronously(sessionId, historyForRetry, runtime, turnSelection, contextTokens, accountingStore!, chainId, turnId);
              if (retryResult.didApply && retryResult.updatedMessages) {
                messages.splice(0, messages.length, ...retryResult.updatedMessages);
                activeAgent.messages.splice(0, activeAgent.messages.length, ...retryResult.updatedMessages);
                activeAgent.turnMessages = [];
                activeAgent.responseCommittedLength = 0;
                activeAgent.thinkingCommittedLength = 0;
                activeAgent.thinkingArtifactsCommitted = 0;
                lastSentLength = 0;
                lastThinkingLength = 0;
                lastUsage = null;
                try {
                  actor.send({ type: 'USER_INPUT', message });
                  publishSessionActivity(sessionId, {
                    cwd: turnCtx.cwd, state: 'working', phase: 'agent', detail: 'Retrying after compaction', canCancel: true,
                  });
                  return;
                } catch (e) {
                  console.debug('[compaction] retry USER_INPUT failed:', e);
                }
              }
            } catch (e) {
            console.debug('[compaction] overflow retry compaction failed:', e);
          }
          completed = true;
          activeAgent.finalized = true;
          publishSessionActivity(sessionId, {
            cwd: turnCtx.cwd, state: 'needs_attention', phase: 'agent', detail: title || detail, canCancel: false,
          });
          flushPartialTurnContent(activeAgent, context);
          const terminalMessages = turnMessagesFromAgent(activeAgent);
          const fullHistory = [...messages, ...activeAgent.turnMessages];
          persistTurnConversation(
            sessionId, fullHistory, terminalMessages, ChainStatus.FAILED,
            agent, activeAgent.selection, webContents,
            detail, title,
          );
          activeAgent.messages = fullHistory;
          sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_ERROR, {
            type: 'error', error: detail, messages: terminalMessages, title, kind: classifyErrorKind(title, detail),
          });
          queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
          compactionRetryTried.delete(retryKey);
          } finally {
            overflowRetryInFlight = false;
          }
        })();
        return;
      }
      if (overflowRetryInFlight) return;
      completed = true;
      activeAgent.finalized = true;
      publishSessionActivity(sessionId, {
        cwd: turnCtx.cwd, state: 'needs_attention', phase: 'agent', detail: title || detail, canCancel: false,
      });
      flushPartialTurnContent(activeAgent, context);
      const terminalMessages = turnMessagesFromAgent(activeAgent);
      const fullHistory = [...messages, ...activeAgent.turnMessages];
      persistTurnConversation(
        sessionId, fullHistory, terminalMessages, ChainStatus.FAILED,
        agent, activeAgent.selection, webContents,
        detail, title,
      );
      activeAgent.messages = fullHistory;
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_ERROR, {
        type: 'error', error: detail, messages: terminalMessages, title, kind: classifyErrorKind(title, detail),
      });
      queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
      compactionRetryTried.delete(retryKey);
    }
  });
  try {
    actor.start();
    interruptActor.start();
    sendChatState(webContents, activeAgent, {
      state: 'streaming', error: null, interruptState: 'idle', cwd: turnCtx.cwd,
    });
    actor.send({ type: 'USER_INPUT', message });
  } catch (error) {
    disposeActiveAgent(sessionId, activeAgent);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error', error: error instanceof Error ? error.message : String(error),
      kind: 'runtime_hydration_failed',
    };
  }
  return { status: 'started', sessionId, turnId };
}
