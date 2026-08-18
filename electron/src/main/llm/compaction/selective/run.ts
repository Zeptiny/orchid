/**
 * U14: Selective multi-turn loop and materialization
 *
 * Requirements R8,R9,R24. Dependencies U4,U13.
 *
 * Upgrade invocation to multi-turn streamChat (or generateText loop). Cap correction
 * rounds (2-3) and fall back to simple on exhaustion. Materialize: kept messages verbatim,
 * ranged keeps as content-truncated copies (annotated), summarized spans as one synthetic
 * message with originals flagged. Provide function runSelectiveCompaction.
 */

import { randomUUID } from 'node:crypto';
import type { Message, CompactedMarker } from '../../../../shared/types/message';
import { MessageRole, MessageType } from '../../../../shared/types/message';
import { reconcileOrphanToolResults } from '../../../../shared/types/chain';
import { toApiMessages } from '../../history';
import type { Manifest, SelectiveOp } from './manifest';
import { buildManifest, parseSelectiveOps } from './manifest';
import { validateSelectiveOps } from './validate';
import { AgentType } from '../../../../shared/types/agent';
import type { Agent } from '../../../../shared/types/agent';
import type { ModelSelection } from '../../../../shared/types/provider';
import type { Config } from '../../../config/schema';
import type { ProjectRuntime } from '../../../project/runtime';
import { getAgent } from '../../../agents/registry';
import { getProviderRuntime } from '../../../providers';
import { getProviderAccountingStore } from '../../../providers/accounting/store';
import type { ProviderAccountingStore } from '../../../providers/accounting/store';
import { createMiddlewareStack } from '../../middleware';
import type { ProviderAttemptAccountingContext } from '../../../providers/accounting/middleware';
import { importESM } from '../../../utils/esm-import';
import { resolveCompactorModelSelection } from '../summarize';

export function buildSelectiveUserPrompt(manifest: Manifest, previousErrors?: readonly string[]): string {
  const lines = manifest.entries.map((e) => `${e.id} [${e.kind}] ${e.preview}`).join('\n');
  const manifestBlock = `<manifest>\n${lines}\n</manifest>`;
  const errorBlock = previousErrors && previousErrors.length > 0
    ? `\n\nPrevious attempt failed validation:\n${previousErrors.map((e) => `- ${e}`).join('\n')}\nFix the errors and return a corrected JSON array.`
    : '';
  return `${manifestBlock}${errorBlock}`;
}

export function createLlmSelectiveCaller(params: {
  config: Config;
  scope: 'main' | 'subagents';
  fallbackSelection?: ModelSelection | null;
  runtime?: ProjectRuntime;
  agents?: ReadonlyMap<string, Agent>;
  subagentId?: string;
  accounting: { store?: ProviderAccountingStore; sessionId: string; chainId: string | null; turnId: string | null };
  abortSignal?: AbortSignal;
}): SelectiveCaller {
  return async ({ manifest, attempt, previousErrors }): Promise<SelectiveOp[]> => {
    const { config, scope, fallbackSelection, runtime, agents, subagentId, accounting, abortSignal } = params;
    const agentName = scope === 'main' ? 'compactor-selective' : 'compactor-subagent-selective';
    let agent: Agent | undefined;
    if (agents?.has(agentName)) agent = agents.get(agentName);
    else if (runtime?.agents.has(agentName)) agent = runtime.agents.get(agentName);
    else agent = getAgent(agentName);
    if (!agent || agent.type !== AgentType.INTERNAL) throw new Error(`selective compactor agent "${agentName}" unavailable`);
    // Shared fallback chain via summarize helper (P2 #24 dedup)
    const selection = resolveCompactorModelSelection(config, agent, scope, fallbackSelection ?? null);
    if (!selection) throw new Error('no model for selective compactor');
    const execution = await getProviderRuntime().resolveExecution(selection);
    const store = accounting.store ?? (() => { try { return getProviderAccountingStore(); } catch { return null; } })();
    if (!store) throw new Error('accounting store unavailable');
    const agentScope = scope === 'subagents' ? (subagentId ?? 'subagent') : 'main';
    const attemptHolder: { value: string | null } = { value: null };
    const ctx: ProviderAttemptAccountingContext = {
      store, sessionId: accounting.sessionId, chainId: accounting.chainId, turnId: accounting.turnId,
      snapshot: execution.snapshot, agentScope, agentName: agent.name, agentType: agent.type, agentTier: agent.tier,
      pricingFacet: execution.pricingFacet, tierMechanism: execution.tierMechanism, attemptIdHolder: attemptHolder,
    };
    const { generateText, wrapLanguageModel } = await importESM<typeof import('ai')>('ai');
    const model = wrapLanguageModel({ model: execution.modelInstance, middleware: createMiddlewareStack({ retry: { maxRetries: config.llm_stream_retries }, accounting: ctx }) });
    const timeoutMs = Math.max(1, (config.llm_stream_idle_timeout ?? 30) * 1000);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = abortSignal == null ? timeoutSignal : AbortSignal.any([abortSignal, timeoutSignal]);
    const userPrompt = buildSelectiveUserPrompt(manifest, previousErrors);
    const raw = await generateText({ model, instructions: agent.system_prompt, messages: [{ role: 'user', content: userPrompt }], abortSignal: combinedSignal, maxRetries: 0 }) as { text: string };
    const text = (raw.text ?? '').trim();
    if (!text) return [];
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    const jsonSlice = start >= 0 && end > start ? text.slice(start, end + 1) : text;
    return parseSelectiveOps(jsonSlice);
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface SelectiveCompactionInput {
  readonly messages: readonly Message[];
  readonly compactableRange: { start: number; end: number };
  readonly manifest?: Manifest;
  readonly maxCorrectionRounds?: number;
  /** Pluggable LLM caller — returns ops for a given attempt. Inject for tests or wire to real LLM. */
  readonly selectiveCaller: SelectiveCaller;
  /** Optional simple fallback — called when selective exhausts. If omitted, fallback is a synthetic simple marker. */
  readonly simpleFallback?: SimpleFallback;
  /** Optional hook to observe correction attempts (for logging). */
  readonly onCorrection?: (attempt: number, errors: string[], corrections: string[]) => void;
}

export type SelectiveCaller = (input: {
  manifest: Manifest;
  messages: readonly Message[];
  attempt: number;
  previousErrors?: readonly string[];
}) => Promise<SelectiveOp[]> | SelectiveOp[];

export type SimpleFallback = () => Promise<{ text: string } | null> | { text: string } | null;

export interface MaterializeResult {
  readonly replayMessages: Message[];
  readonly flaggedIds: string[];
  /** Summary messages (one per summarize op) */
  readonly summaryMessages: Message[];
  /** For compatibility with simple path: first summary or combined */
  readonly summaryMessage: Message | null;
  /** Compacted marker for persistence (if needed) */
  readonly compactedMarker?: CompactedMarker;
}

export interface SelectiveCompactionSuccess extends MaterializeResult {
  readonly kind: 'selective';
  readonly correctedOps: SelectiveOp[];
  readonly attempts: number;
}

export interface SelectiveCompactionFallback {
  readonly kind: 'fallback';
  readonly reason: string;
  readonly fallbackText: string | null;
  readonly attempts: number;
  // For callers that expect replayMessages shape
  readonly replayMessages?: Message[];
  readonly flaggedIds?: string[];
  readonly summaryMessage?: Message | null;
}

export type SelectiveCompactionResult = SelectiveCompactionSuccess | SelectiveCompactionFallback;

// ── Materialization ─────────────────────────────────────────────────────────

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

function truncateRange(content: string, startLine: number, endLine: number): { truncated: string; total: number } {
  const lines = content.split('\n');
  const total = lines.length;
  const s = Math.max(1, Math.min(startLine, total));
  const e = Math.max(1, Math.min(endLine, total));
  const lo = Math.min(s, e);
  const hi = Math.max(s, e);
  const slice = lines.slice(lo - 1, hi);
  return { truncated: slice.join('\n'), total };
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeSummaryMessage(text: string, mode: 'selective' | 'simple' = 'selective', rangeInfo?: { start: string; end: string; count?: number }): Message {
  const marker: CompactedMarker = {
    rangeStart: rangeInfo?.start ?? 'selective-start',
    rangeEnd: rangeInfo?.end ?? 'selective-end',
    mode,
    ...(rangeInfo?.count !== undefined ? { summarizedCount: rangeInfo.count } : {}),
  };
  return {
    id: randomUUID(),
    role: MessageRole.ASSISTANT,
    content: text,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: nowIso(),
    usage: null,
    hidden: false,
    excludeFromModel: false,
    compacted: marker,
    tool_result: null,
  };
}

function makeRangedCopy(original: Message, startLine: number, endLine: number): Message {
  const content = original.content ?? '';
  const { truncated, total } = truncateRange(content, startLine, endLine);
  const annotation = `\n\n[truncated: lines ${Math.min(startLine, endLine)}-${Math.max(startLine, endLine)} of ${total}; showing ${truncated.split('\n').length} lines]`;
  return {
    ...original,
    id: `${original.id}:range:${startLine}-${endLine}:${randomUUID().slice(0, 8)}`,
    content: truncated + annotation,
    // Preserve other fields but ensure new id is unique for replay
    timestamp: nowIso(),
    // Keep original tool_calls etc as is (for pairing, but truncated content is what matters)
  };
}

/**
 * Pure transform: materialize ops into a replay list.
 *
 * Kept messages verbatim, ranged keeps as content-truncated copies (annotated),
 * summarized spans as one synthetic message with originals flagged.
 * Originals in summarized/ranged ranges are added to flaggedIds.
 *
 * Full replay = materialized compactable prefix + preserve suffix (verbatim).
 */
export function materializeSelectiveOps(input: {
  manifest: Manifest;
  messages: readonly Message[];
  ops: readonly SelectiveOp[];
}): MaterializeResult {
  const { manifest, messages, ops } = input;
  const compactableRange = manifest.compactableRange;
  const n = messages.length;
  const start = Math.max(0, Math.min(compactableRange.start, n));
  const end = Math.max(start, Math.min(compactableRange.end, n));

  // Map id -> message for fast lookup
  const msgById = new Map<string, Message>();
  for (const m of messages) msgById.set(m.id, m);

  const flaggedIds: string[] = [];
  const flaggedSet = new Set<string>();
  const summaryMessages: Message[] = [];
  const replayPrefix: Message[] = [];

  // Track which manifest ids have been covered by ops
  const covered = new Set<string>();

  // Helper to add flagged without duplicate
  const addFlagged = (id: string) => {
    if (!flaggedSet.has(id)) {
      flaggedSet.add(id);
      flaggedIds.push(id);
    }
  };

  // Ops are expected sorted to manifest order (validate does this)
  for (const op of ops) {
    if (op.type === 'keep') {
      const msg = msgById.get(op.id);
      if (!msg) continue;
      replayPrefix.push(msg);
      covered.add(op.id);
    } else if (op.type === 'keep_range') {
      const msg = msgById.get(op.id);
      if (!msg) continue;
      addFlagged(op.id);
      const copy = makeRangedCopy(msg, op.startLine, op.endLine);
      replayPrefix.push(copy);
      covered.add(op.id);
    } else if (op.type === 'drop') {
      addFlagged(op.id);
      covered.add(op.id);
    } else {
      // summarize: create one synthetic per op
      const ids = op.ids as readonly string[];
      for (const id of ids) {
        addFlagged(id);
        covered.add(id);
      }
      // Determine range anchors for marker
      const firstId = ids[0] ?? 'unknown';
      const lastId = ids[ids.length - 1] ?? 'unknown';
      const syn = makeSummaryMessage(op.text || '(empty summary)', 'selective', {
        start: firstId,
        end: lastId,
        count: ids.length,
      });
      summaryMessages.push(syn);
      replayPrefix.push(syn);
    }
  }

  // Any manifest ids not covered -> flagged. With explicit drop ops, this should not happen for valid ops;
  // retained as fallback for mechanical tolerance but flagged as dropped.
  for (const entry of manifest.entries) {
    if (!covered.has(entry.id)) {
      addFlagged(entry.id);
    }
  }

  // Preserve suffix: messages after compactable end, verbatim
  const preserveSuffix: Message[] = [];
  for (let i = end; i < n; i += 1) {
    preserveSuffix.push(messages[i]!);
  }

  // Full replay list
  const replayMessages: Message[] = [...replayPrefix, ...preserveSuffix];

  // Primary summaryMessage for compatibility: first synthetic or combined if multiple
  let summaryMessage: Message | null = null;
  if (summaryMessages.length === 1) {
    summaryMessage = summaryMessages[0]!;
  } else if (summaryMessages.length > 1) {
    const combined = summaryMessages.map((m) => m.content).join('\n\n---\n\n');
    summaryMessage = makeSummaryMessage(combined, 'selective', {
      start: manifest.entries[0]?.id ?? 'unknown',
      end: manifest.entries[manifest.entries.length - 1]?.id ?? 'unknown',
      count: flaggedIds.length,
    });
    // Note: summaryMessages remain as separate, but summaryMessage is combined for fallback compat
  }

  return {
    replayMessages,
    flaggedIds,
    summaryMessages,
    summaryMessage,
  };
}

// ── Replay invariant check ──────────────────────────────────────────────────

export function passesReplayInvariant(messages: readonly Message[]): { ok: boolean; reason?: string } {
  try {
    // Use reconcileOrphanToolResults + toApiMessages survival check
    const reconciled = reconcileOrphanToolResults([...messages] as Message[]);
    // toApiMessages drops orphans; if length differs significantly, check
    const api = toApiMessages(reconciled as Message[]);
    // Basic check: no dangling tool_calls without result
    // We can verify that every tool_call_id in a tool_calls block has a following TOOL result in reconciled
    // Simpler: if reconciled still contains both call and result counts equal for those in compactable?
    // For now, consider that reconcileOrphanToolResults already prunes orphans, so if api conversion succeeds without throwing, it's ok.
    // Additional check: ensure no orphan remains after reconcile
    const callIds = new Set<string>();
    for (const m of reconciled) {
      if (m.tool_calls) for (const tc of m.tool_calls as readonly { id: string }[]) if (tc.id) callIds.add(tc.id);
    }
    const resultIds = new Set<string>();
    for (const m of reconciled) {
      if (m.role === MessageRole.TOOL && m.tool_call_id) resultIds.add(m.tool_call_id);
    }
    for (const id of callIds) {
      if (!resultIds.has(id)) return { ok: false, reason: `tool_call ${id} missing matching tool result` };
    }
    void api;
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── Multi-turn loop ─────────────────────────────────────────────────────────

export async function runSelectiveCompaction(
  input: SelectiveCompactionInput,
): Promise<SelectiveCompactionResult> {
  const messages = input.messages;
  const compactableRange = input.compactableRange;
  const manifest = input.manifest ?? buildManifest(messages, compactableRange);
  const maxRounds = Math.max(1, Math.min(input.maxCorrectionRounds ?? 3, 5));
  let previousErrors: string[] | undefined = undefined;
  let lastCorrectedOps: SelectiveOp[] | undefined = undefined;
  let attempts = 0;

  for (let attempt = 0; attempt < maxRounds; attempt += 1) {
    attempts = attempt + 1;
    let ops: SelectiveOp[];
    try {
      const result = await input.selectiveCaller({ manifest, messages, attempt, previousErrors });
      if (!Array.isArray(result) || result.length === 0) {
        const reason = !Array.isArray(result) ? 'selective caller returned non-array ops' : 'selective caller returned empty ops list';
        previousErrors = [reason];
        if (input.onCorrection) input.onCorrection(attempt, previousErrors, []);
        if (attempt + 1 >= maxRounds) break;
        continue;
      }
      ops = result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      previousErrors = [`selective caller failed: ${msg}`];
      if (input.onCorrection) input.onCorrection(attempt, previousErrors, []);
      // Treat as correctable error — retry if rounds left, else fallback
      if (attempt + 1 >= maxRounds) break;
      continue;
    }

    const validation = validateSelectiveOps(ops, manifest, messages);
    lastCorrectedOps = validation.correctedOps;

    if (input.onCorrection && (validation.errors.length > 0 || validation.mechanicalCorrections.length > 0)) {
      input.onCorrection(attempt, validation.errors, validation.mechanicalCorrections);
    }

    if (validation.valid) {
      // Materialize and check invariant
      const materialized = materializeSelectiveOps({ manifest, messages, ops: validation.correctedOps });
      const invariant = passesReplayInvariant(materialized.replayMessages);
      if (!invariant.ok) {
        previousErrors = [`replay invariant violated: ${invariant.reason}`];
        if (attempt + 1 >= maxRounds) break;
        continue;
      }
      return {
        kind: 'selective',
        replayMessages: materialized.replayMessages,
        flaggedIds: materialized.flaggedIds,
        summaryMessages: materialized.summaryMessages,
        summaryMessage: materialized.summaryMessage,
        correctedOps: validation.correctedOps,
        attempts,
      };
    }

    // Not valid -> prepare reprompt
    previousErrors = [...validation.errors];
    if (attempt + 1 >= maxRounds) {
      break;
    }
    // Continue to next round; caller will be invoked with previousErrors for re-prompt
  }

  // Exhausted correction rounds → fallback to simple
  let fallbackText: string | null = null;
  let reason = `selective compaction failed after ${attempts} attempt(s): ${previousErrors?.join('; ') ?? 'unknown'}`;
  if (input.simpleFallback) {
    try {
      const fb = await input.simpleFallback();
      if (fb && typeof fb.text === 'string' && fb.text.trim().length > 0) {
        fallbackText = fb.text.trim();
      }
    } catch (e) {
      reason += `; fallback also failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Produce a fallback synthetic if we have text, to keep callers simple
  if (fallbackText) {
    const fbMsg = makeSummaryMessage(fallbackText, 'simple', {
      start: manifest.entries[0]?.id ?? 'fallback-start',
      end: manifest.entries[manifest.entries.length - 1]?.id ?? 'fallback-end',
      count: manifest.entries.filter((e) => e.kind !== 'user').length || manifest.entries.length,
    });
    // For fallback, flaggedIds must NOT include user messages (R9: keep user verbatim).
    // Filter to non-user only; users are kept via keep ops / replay interleaving.
    const flaggedIds = manifest.entries.filter((e) => e.kind !== 'user').map((e) => e.id);
    // Preserve suffix still needed for full replay — build replay correctly interleaved
    // (users kept verbatim at their manifest positions, single summary at first non-user slot)
    // so callers do not need to re-insert at a single cut.
    const n = messages.length;
    const end = Math.max(0, Math.min(compactableRange.end, n));
    const preserveSuffix = messages.slice(end);
    const msgById = new Map<string, Message>(messages.map((m) => [m.id, m]));
    const replayPrefix: Message[] = [];
    let summaryInserted = false;
    for (const entry of manifest.entries) {
      if (entry.kind === 'user') {
        const original = msgById.get(entry.id);
        if (original) replayPrefix.push(original);
      } else {
        if (!summaryInserted) {
          replayPrefix.push(fbMsg);
          summaryInserted = true;
        }
        // non-user originals are flagged, not replayed verbatim
      }
    }
    if (!summaryInserted) {
      // Edge: range contained only user messages — still insert summary
      replayPrefix.push(fbMsg);
    }
    const replayMessages = [...replayPrefix, ...preserveSuffix];
    return {
      kind: 'fallback',
      reason,
      fallbackText,
      attempts,
      replayMessages,
      flaggedIds,
      summaryMessage: fbMsg,
    };
  }

  return {
    kind: 'fallback',
    reason,
    fallbackText,
    attempts,
  };
}

// ── Integration helper: choose mode ─────────────────────────────────────────

/**
 * Convenience: run compaction according to mode.
 * When mode is selective, call runSelectiveCompaction; otherwise call simpleFallback.
 * Exposed so trigger engine can branch.
 */
export async function runCompactionByMode(input: {
  mode: 'simple' | 'selective';
  messages: readonly Message[];
  compactableRange: { start: number; end: number };
  manifest?: Manifest;
  selectiveCaller?: SelectiveCaller;
  simpleFallback?: SimpleFallback;
  maxCorrectionRounds?: number;
}): Promise<SelectiveCompactionResult | { kind: 'simple'; text: string | null }> {
  if (input.mode === 'selective') {
    if (!input.selectiveCaller) {
      // No selective caller provided → fallback to simple
      const fb = input.simpleFallback ? await input.simpleFallback() : null;
      const text = fb?.text ?? null;
      if (text) return { kind: 'fallback', reason: 'no selectiveCaller', fallbackText: text, attempts: 0, summaryMessage: makeSummaryMessage(text, 'simple') } as SelectiveCompactionFallback;
      return { kind: 'fallback', reason: 'no selectiveCaller and no simple fallback', fallbackText: null, attempts: 0 };
    }
    return runSelectiveCompaction({
      messages: input.messages,
      compactableRange: input.compactableRange,
      manifest: input.manifest,
      selectiveCaller: input.selectiveCaller,
      simpleFallback: input.simpleFallback,
      maxCorrectionRounds: input.maxCorrectionRounds,
    });
  }
  // simple mode
  const fb = input.simpleFallback ? await input.simpleFallback() : null;
  return { kind: 'simple', text: fb?.text ?? null };
}
