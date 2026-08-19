/**
 * Subagent stream runner — drives streamChat for a delegated subagent.
 *
 * Used by SubagentManager when a runner is configured (production).
 * Tests leave the runner unset so spawn/markCompleted stay manual.
 */
import type { Agent } from '../../shared/types/agent';
import type { Message } from '../../shared/types/message';
import type { ReasoningProviderOptions } from '../providers/drivers/types';
import {
  DEFAULT_THINKING_POLICY,
} from '../providers/facets/thinking';
import type { ThinkingReplayContext } from '../llm/history';
import type { CacheFacet, ThinkingPolicy } from '../../shared/types/provider-facets';
import { resolveSubagentTier } from '../providers/facets/tiers';
import { assembleFacetProviderOptions } from '../providers/facets/turn-options';
import type { ModelSelection, ProviderProtocol } from '../../shared/types/provider';
import { streamChat, type StreamEvent } from '../llm/orchestrator';
import { resolveSubagentEffort } from '../llm/reasoning-effort';
import { getConfig } from '../config/loader';
import { getSessionManager } from '../session/singleton';
import {
  getProjectRuntimeRegistry,
  type ProjectRuntime,
} from '../project/runtime';
import { appendRootAgentsMd, seedSubagentRootAgentsMd } from '../project/agents-md';
import type { SubagentStreamRunner } from './manager';
import { makeUserMessage } from '../llm/message-factories';
import { buildSystemPromptContext } from '../llm/build-prompt-context';
import {
  acquireProjectMCPManager,
  releaseProjectMCPManager,
} from '../mcp/project-registry';
import { getBuiltinToolRegistryForRuntime } from '../tools';
import { getProviderRuntime } from '../providers';
import { getProviderAccountingStore } from '../providers/accounting/store';
import { getSubagentAttributionStore } from '../providers/accounting/subagent-attribution-store';
import type { ProviderAttemptAccountingContext } from '../providers/accounting/middleware';
import type { Config } from '../config/schema';
import type { Chain } from '../../shared/types/chain';
import { buildCompactionApply, type ApplyResult } from '../llm/compaction/apply';
import type { TriggerState } from '../llm/compaction/trigger';
import type { CompactionAttemptOutcome } from '../llm/compaction/run-attempt';
import { estimateMessageChars } from '../llm/compaction/message-chars';
import type { CutResult } from '../llm/compaction/select';
import type { SelectiveCompactionResult } from '../llm/compaction/selective/run';

/** Subagent mid-run compaction (U9): partial-report helper for R17. */
export interface SubagentPartialReportInput {
  readonly done: string;
  readonly remaining: string;
  readonly stoppedAt: string;
}

/**
 * Build a structured partial report returned to the parent as a normal tool
 * result when the run still exceeds the window after compaction (R17).
 *
 * The parent sees this as `record.result` inside the wait_for_subagent XML;
 * it is not a hard failure.
 */
export function buildSubagentPartialReport(input: SubagentPartialReportInput): string {
  const done = input.done?.trim() || '(no completed steps reported)';
  const remaining = input.remaining?.trim() || '(unknown remaining work)';
  const stoppedAt = input.stoppedAt?.trim() || 'unknown step';
  return [
    '[Subagent partial report — context window limit reached after compaction]',
    '',
    'Done:',
    done,
    '',
    'Remaining:',
    remaining,
    '',
    `Stopped at: ${stoppedAt}`,
    '',
    'Note: The subagent stopped early because the context window was still exceeded after compaction. This is a partial result returned as a normal tool result to the parent.',
  ].join('\n');
}

/**
 * Resolve a subagent run's own model limits (contextTokens) via the frozen
 * selection's trusted provider execution (R16). Returns null when the catalog
 * has no limits or the selection is unusable — caller falls back to no-op.
 */
export async function resolveSubagentContextTokens(
  selection: ModelSelection | null,
): Promise<number | null> {
  if (!selection) return null;
  try {
    const execution = await getProviderRuntime().resolveExecution(selection);
    const tokens = execution.model.limits?.contextTokens;
    return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null;
  } catch {
    return null;
  }
}

/**
 * Materialize a SUCCESSFUL selective-compaction run for a subagent chain (R3).
 *
 * The selective loop decides which messages leave the MODEL view; persistence
 * must never delete them from the transcript. Adopting the materialized
 * replay (`replayMessages`) wholesale would hard-delete every summarized
 * original — inside summarize/drop/keep_range spans they exist only as
 * `flaggedIds`, never in the replay. Instead this routes the result through
 * buildCompactionApply (the same never-delete helper the simple and fallback
 * paths use): every original message is kept, the covered ids
 * (summarized/dropped/ranged-kept + mechanical reclaim) get
 * excludeFromModel:true, and one summary head carrying the compacted marker
 * (mode 'selective') is inserted at the cut.
 *
 * buildCompactionApply flags the ENTIRE compactable range, so afterwards this
 * settles the flags: ids the selective pass kept verbatim become visible
 * again, and user messages are never flagged (R9 — the same protection the
 * fallback path applies). Pre-existing flags outside the covered range apply
 * only to non-user messages — a user message inside `userIds` is always
 * unflagged; other pre-existing flags outside the range are left untouched.
 */
export function buildSelectiveSubagentApply(params: {
  readonly messages: readonly Message[];
  readonly chains: readonly Chain[];
  readonly cutResult: CutResult;
  readonly selectiveResult: Extract<SelectiveCompactionResult, { kind: 'selective' }>;
  /** Mechanical-reclaim ids from this run's pre-pass; merged with the selective flags. */
  readonly reclaimedIds?: readonly string[];
  readonly sessionId?: string;
}): ApplyResult | null {
  const { messages, chains, cutResult, selectiveResult } = params;

  // R9: user messages are never excluded from the model view.
  const userIds = new Set(messages.filter((m) => m.role === 'user').map((m) => m.id));
  const mergedFlagged = [...new Set([...selectiveResult.flaggedIds, ...(params.reclaimedIds ?? [])])]
    .filter((id) => !userIds.has(id));

  // Compose the per-op summaries into one summary head — the same plain-text
  // shape the simple path passes to buildCompactionApply.
  const summaryParts = selectiveResult.summaryMessages.length > 0
    ? selectiveResult.summaryMessages.map((m) => m.content)
    : (selectiveResult.summaryMessage ? [selectiveResult.summaryMessage.content] : []);
  const summaryText = summaryParts.join('\n\n---\n\n').trim();
  if (mergedFlagged.length === 0 && summaryText.length === 0) return null;

  let applyResult: ApplyResult;
  try {
    applyResult = buildCompactionApply({
      messages: [...messages],
      chains,
      cutResult,
      summaryText: summaryText.length > 0 ? summaryText : null,
      mode: 'selective',
      reclaimedIds: mergedFlagged,
      sessionId: params.sessionId,
    });
  } catch {
    // e.g. range already flagged by an earlier compaction — mirror the simple
    // path's failure mode (no-op) rather than risk the transcript.
    return null;
  }
  if (!applyResult.didApply) return null;

  // Settle flags: reset excludeFromModel on covered ids that selective kept
  // verbatim (and on user messages) so the model view matches the selective
  // decision while the transcript keeps every original.
  const n = messages.length;
  const start = Math.max(0, Math.min(cutResult.compactableRange.start, n));
  const end = Math.max(start, Math.min(cutResult.compactableRange.end, n));
  const coveredIds = new Set<string>(mergedFlagged);
  for (let i = start; i < end; i += 1) {
    const m = messages[i];
    if (m) coveredIds.add(m.id);
  }
  const flaggedSet = new Set(mergedFlagged);
  const settle = (m: Message): Message => {
    if (userIds.has(m.id)) return m.excludeFromModel ? { ...m, excludeFromModel: false } : m;
    if (flaggedSet.has(m.id)) return m.excludeFromModel ? m : { ...m, excludeFromModel: true };
    if (coveredIds.has(m.id) && m.excludeFromModel) return { ...m, excludeFromModel: false };
    return m;
  };
  return {
    ...applyResult,
    updatedMessages: applyResult.updatedMessages.map(settle),
    updatedChains: applyResult.updatedChains.map((c) => ({ ...c, messages: c.messages.map(settle) })),
    flaggedIds: mergedFlagged,
  };
}

/**
 * Shared subagent compaction attempt — uses the same trigger engine as U6 but
 * with the subagents scope config (R16). The caller supplies the current chain
 * history, latest provider-reported inputTokens, and resolved contextTokens.
 *
 * Returns a compaction ApplyResult when the trigger fired and the summary was
 * built, or null for no-op (below threshold / floor / hysteresis, or summarizer
 * unavailable). Reclaim-only (no summary head) is returned as an ApplyResult
 * with flaggedIds and no summaryMessage, which the caller persists via the
 * subagent checkpoint path.
 *
 * Accounting inside the summarizer already carries subagent scope (R18) when
 * called with scope='subagents' + subagentId — see summarize.ts.
 */
export async function tryCompactSubagentHistory(params: {
  readonly messages: readonly Message[];
  readonly chains: readonly Chain[];
  readonly selection: ModelSelection | null;
  readonly config: Config;
  readonly sessionId: string;
  readonly subagentId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly inputTokens: number;
  readonly contextTokens: number;
  readonly triggerState?: TriggerState;
}): Promise<ApplyResult | null> {
  const { messages, chains, selection, config, sessionId, subagentId, chainId, turnId, inputTokens, contextTokens } = params;
  const subagentsScope = config.compaction?.subagents;
  if (!subagentsScope) return null;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return null;
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return null;

  // Lazy imports to avoid cycle with provider runtime during typecheck
  const { selectCut, resolvePreservePercent } = await import('../llm/compaction/select.js');
  const { mechanicalReclaim } = await import('../llm/compaction/reclaim.js');
  const { evaluateTriggerWithReclaim } = await import('../llm/compaction/trigger.js');
  const { getProviderAccountingStore } = await import('../providers/accounting/store.js');

  let totalCharsAll = 0;
  for (const m of messages) totalCharsAll += estimateMessageChars(m);
  if (totalCharsAll === 0) totalCharsAll = 1;
  const tokensPerCharSub = (() => {
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return undefined;
    const r = inputTokens / totalCharsAll;
    if (!Number.isFinite(r) || r <= 0) return undefined;
    return Math.max(0.05, Math.min(r, 2));
  })();
  if (!tokensPerCharSub) return null;
  let cut: ReturnType<typeof selectCut>;
  try {
    const calibratedEstimatorSub = (slice: readonly Message[]): number => {
      let chars = 0;
      for (const m of slice) chars += estimateMessageChars(m);
      return Math.max(slice.length, Math.ceil(chars * tokensPerCharSub));
    };
    cut = selectCut(messages as Message[], {
      preserveTokens: Math.floor(resolvePreservePercent(subagentsScope) * contextTokens),
      tokenEstimator: calibratedEstimatorSub,
    });
  } catch {
    return null;
  }
  const compactableRange = cut.compactableRange;
  let sliceChars = 0;
  for (let i = compactableRange.start; i < compactableRange.end; i += 1) {
    const m = (messages as readonly Message[])[i];
    if (!m) continue;
    sliceChars += estimateMessageChars(m);
  }
  const compactableTokens = Math.ceil(sliceChars * tokensPerCharSub);
  if (compactableTokens <= 0) return null;

  // Mechanical reclaim pass before summarizer (v1 single rule, R25)
  let flaggedIds: string[] = [];
  if (subagentsScope.mechanical_reclaim) {
    try {
      const reclaim = mechanicalReclaim(messages as Message[], compactableRange);
      flaggedIds = [...reclaim.flaggedIds];
    } catch {
      // non-fatal
    }
  }

  const decision = evaluateTriggerWithReclaim({
    inputTokens,
    contextTokens,
    threshold: subagentsScope.threshold,
    hysteresisDelta: subagentsScope.hysteresis_delta,
    compactableTokens,
    minCompactableTokens: subagentsScope.min_compactable_tokens,
    compactableRange,
    messages: messages as Message[],
    flaggedIds,
    ...(params.triggerState ? { state: params.triggerState } : {}),
  });

  // Reclaim-only short-circuit: build apply without summarizer
  if (decision.shouldApply && !decision.shouldPrepare && flaggedIds.length > 0) {
    try {
      const applyResult = buildCompactionApply({
        messages: messages as Message[],
        chains,
        cutResult: cut,
        summaryText: null,
        mode: subagentsScope.mode as import('../../shared/types/message').CompactionMode,
        reclaimedIds: flaggedIds,
      });
      return applyResult.didApply ? applyResult : null;
    } catch {
      return null;
    }
  }

  if (!decision.shouldPrepare) return null;

  // Ledger for both compaction modes — resolved once before the mode branch.
  let accountingStore: ReturnType<typeof getProviderAccountingStore> | undefined;
  try {
    accountingStore = getProviderAccountingStore();
  } catch {
    accountingStore = undefined;
  }

  // Branch on compaction mode: selective uses manifest+LLM caller, simple uses summarizeCompactableRange.
  // Simple is default (opt-in selective via config.compaction.subagents.mode==='selective').
  if ((subagentsScope.mode as string) === 'selective') {
    // Shared selective runner (#11): slice → manifest → LLM caller →
    // multi-turn loop with simple fallback, with subagent-scoped accounting
    // and the R9 never-flag-user invariant applied to the result. The runner
    // module is imported lazily like the other compaction leaves to keep this
    // module's load graph free of the provider runtime chain.
    const compactableSliceForFallback = (messages.slice(compactableRange.start, compactableRange.end) as Message[]).filter((m) => !m.excludeFromModel && !m.hidden);
    if (compactableSliceForFallback.length === 0) return null;

    let attempt: CompactionAttemptOutcome;
    try {
      const { runCompactionAttempt, unflagUserMessagesInApply } = await import('../llm/compaction/run-attempt.js');
      attempt = await runCompactionAttempt({
        messages: messages as Message[],
        cut,
        scope: 'subagents',
        config,
        deps: {
          fallbackSelection: selection,
          subagentId,
          accounting: accountingStore
            ? { store: accountingStore, sessionId, chainId, turnId }
            : { sessionId, chainId, turnId },
        },
      });
      if (attempt.kind === 'ran' && attempt.result.kind === 'selective') {
        // R3: never delete the transcript. Preserve every original message
        // (excludeFromModel flags + one compacted-marker summary head at the
        // cut) instead of hard-replacing the chain with the materialized
        // replay, whose summarized originals exist only as flagged ids.
        return buildSelectiveSubagentApply({
          messages: messages as Message[],
          chains,
          cutResult: cut,
          selectiveResult: attempt.result,
          reclaimedIds: flaggedIds,
          sessionId,
        });
      }
      if (attempt.kind === 'ran' && attempt.result.kind === 'fallback') {
        const fallbackText = attempt.result.fallbackText;
        if (!fallbackText || fallbackText.trim().length === 0) return null;
        const applyResult = buildCompactionApply({
          messages: messages as Message[],
          chains,
          cutResult: cut,
          summaryText: fallbackText,
          mode: 'simple' as import('../../shared/types/message').CompactionMode,
          reclaimedIds: flaggedIds,
          sessionId,
        });
        if (!applyResult.didApply) return null;
        // R9: user messages are never excluded from the model view — shared
        // helper (#11a), previously inlined here (and now applied by the main
        // scope's selective fallback too).
        return unflagUserMessagesInApply(applyResult, messages as Message[]);
      }
      return null;
    } catch {
      return null;
    }
  }

  // Simple default behavior (unchanged) — task-focused compactor-subagent, subagent-scoped accounting (R18)
  const compactableSlice = (messages.slice(compactableRange.start, compactableRange.end) as Message[]).filter((m) => !m.excludeFromModel && !m.hidden);
  if (compactableSlice.length === 0) return null;

  let summarizeResult: Awaited<ReturnType<typeof import('../llm/compaction/summarize.js').summarizeCompactableRange>> | null;
  try {
    const { summarizeCompactableRange } = await import('../llm/compaction/summarize.js');
    summarizeResult = await summarizeCompactableRange({
      messages: compactableSlice,
      scope: 'subagents',
      config,
      fallbackSelection: selection,
      existingModelSelection: selection,
      accounting: accountingStore
        ? { store: accountingStore, sessionId, chainId, turnId }
        : ({ sessionId, chainId, turnId } as unknown as Parameters<typeof summarizeCompactableRange>[0]['accounting']),
      subagentId,
    });
  } catch {
    return null;
  }
  if (!summarizeResult || !summarizeResult.text?.trim()) {
    // Summarizer unavailable — if reclaim had ids, we already handled short-circuit; otherwise no-op
    return null;
  }

  try {
    const applyResult = buildCompactionApply({
      messages: messages as Message[],
      chains,
      cutResult: cut,
      summaryText: summarizeResult!.text,
      mode: subagentsScope.mode as import('../../shared/types/message').CompactionMode,
      reclaimedIds: flaggedIds,
      sessionId,
    });
    if (!applyResult.didApply) return null;
    return applyResult;
  } catch {
    return null;
  }
}

/** Delegated workers cannot recursively fan out or control sibling workers. */
const SUBAGENT_FORBIDDEN_TOOLS = new Set([
  'delegate_to_subagent',
  'wait_for_subagent',
  'interrupt_subagents',
  'close_subagents',
  'answer_subagent',
  'follow_up_subagent',
]);

/**
 * Fallback cwd when spawn did not pass a frozen parent-turn path.
 * Never uses process.cwd().
 */
function resolveParentSessionCwdFallback(sessionId?: string): string | null {
  try {
    const manager = getSessionManager();
    const session = sessionId
      ? manager.getSession(sessionId)
      : manager.getActive();
    if (session?.cwd != null && session.cwd !== '') {
      return session.cwd;
    }
    const sticky = getConfig().default_project_dir;
    if (sticky != null && sticky !== '') {
      return sticky;
    }
  } catch {
    // Session manager may be unavailable in tests
  }
  return null;
}

/**
 * Create the production stream runner for subagents.
 * A child uses the exact frozen selection inherited from its parent turn;
 * it never parses an alias or consults mutable provider configuration.
 */
export function createSubagentStreamRunner(): SubagentStreamRunner {
  return async function* subagentStream(params: {
    task: string;
    /** Full chain to replay for a resumed run; absent = spawn path. */
    history?: Message[];
    agent: Agent;
    selection: ModelSelection | null;
    abortSignal: AbortSignal;
    sessionId?: string;
    /** Originating renderer window frozen by the parent turn. */
    windowId?: string;
    /** Frozen parent-turn workspace cwd. */
    cwd?: string;
    /** This subagent's scope id (record.id) for todos / bg / prompt isolation. */
    agentScopeId: string;
    /** Durable child-chain and turn ids for provider-attempt attribution. */
    chainId?: string;
    turnId?: string;
    /** Immutable project config/definitions captured by the parent turn. */
    projectRuntime?: ProjectRuntime;
    /** Reports the resolved reasoning effort once the provider execution is known. */
    onReasoningEffort?: (effort: string | number | undefined) => void;
  }): AsyncGenerator<StreamEvent> {
    const sessionId = params.sessionId;
    if (!sessionId) {
      yield {
        type: 'error',
        title: 'Missing session',
        detail: 'Subagent cannot run without an explicit parent session id.',
      };
      return;
    }

    // Prefer frozen parent-turn cwd; only fall back if spawn omitted it.
    const parentCwd =
      (params.cwd != null && params.cwd !== '' ? params.cwd : null) ??
      resolveParentSessionCwdFallback(sessionId);
    if (parentCwd == null) {
      yield {
        type: 'error',
        title: 'No workspace',
        detail:
          'Subagent cannot run: parent session has no project working directory.',
      };
      return;
    }

    const runtime =
      params.projectRuntime ?? getProjectRuntimeRegistry().get(parentCwd);
    const config = runtime.config;
    // Resolve selection: explicit override → tier selection → nullable default.
    const selection =
      params.selection ??
      (config.tier_models[params.agent.tier] ?? config.default_model);
    if (selection == null) {
      yield {
        type: 'error',
        title: 'Provider connection required',
        detail: 'Connect a provider and select a model before delegating a subagent.',
      };
      return;
    }

    let modelInstance;
    let providerSnapshot: ProviderAttemptAccountingContext['snapshot'];
    let providerOptions: ReasoningProviderOptions | undefined;
    let pricingFacet: ProviderAttemptAccountingContext['pricingFacet'];
    let thinkingPolicy: ThinkingPolicy | undefined;
    let cacheFacet: CacheFacet | undefined;
    let cacheTtl: string | undefined;
    let cacheSessionKey: string | undefined;
    let tierMechanism: ProviderAttemptAccountingContext['tierMechanism'];
    let accountingStore: ReturnType<typeof getProviderAccountingStore>;
    try {
      accountingStore = getProviderAccountingStore();
      const tierContext = await getProviderRuntime().resolveTierContext(selection);
      const effectiveTier = resolveSubagentTier(
        tierContext.connection, selection.modelId, tierContext.tierMechanism,
      );
      const execution = await getProviderRuntime().resolveExecution(
        selection,
        effectiveTier !== undefined ? { tier: effectiveTier } : {},
      );
      tierMechanism = execution.tierMechanism;
      modelInstance = execution.modelInstance;
      providerSnapshot = execution.snapshot;
      pricingFacet = execution.pricingFacet;
      thinkingPolicy = execution.thinkingPolicy;
      cacheFacet = execution.cacheFacet;
      const effort = resolveSubagentEffort(
        params.agent,
        config,
        execution.connection,
        selection.modelId,
        execution.model.capabilities?.reasoning === true,
      );
      params.onReasoningEffort?.(effort);
      providerOptions =
        effort === undefined ? undefined : execution.buildReasoningOptions?.(effort);
      const facetOptions = assembleFacetProviderOptions({
        providerOptions,
        thinkingPolicy,
        providerId: providerSnapshot.providerId,
        tierId: resolveSubagentTier(
          execution.connection, selection.modelId, execution.tierMechanism,
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
      yield {
        type: 'error',
        title: 'Provider unavailable',
        detail: error instanceof Error ? error.message : String(error),
      };
      return;
    }

    const context = await buildSystemPromptContext({
      cwd: parentCwd,
      config,
      sessionId,
      agentScopeId: params.agentScopeId,
    });
    // Seed the subagent's scope-keyed tracker with the root instruction file
    // (R13/R15) so the nested read-path mechanism never re-injects it (R4). The
    // subagent starts fresh with only the root — it does not inherit the
    // parent's seen nested files. Non-fatal (never breaks subagent startup).
    seedSubagentRootAgentsMd(sessionId, params.agentScopeId, runtime);
    const accounting: ProviderAttemptAccountingContext = {
      store: accountingStore,
      sessionId,
      chainId: params.chainId ?? null,
      turnId: params.turnId ?? params.agentScopeId,
      snapshot: providerSnapshot,
      agentScope: params.agentScopeId,
      agentName: params.agent.name,
      agentType: params.agent.type,
      agentTier: params.agent.tier,
     attemptIdHolder: { value: null },
      pricingFacet,
      tierMechanism,
    };
    try {
      getSubagentAttributionStore().insert({
        subagentId: params.agentScopeId,
        sessionId,
        chainId: params.chainId ?? params.agentScopeId,
        parentChainId: null,
        agentName: params.agent.name,
        agentType: params.agent.type,
        agentTier: params.agent.tier,
        modelId: selection.modelId,
        connectionId: providerSnapshot.connectionId,
      });
    } catch (error) {
      console.warn('[subagent-runner] Subagent attribution insert failed', { error });
    }
    const mcpManager = acquireProjectMCPManager(runtime);
    try {
      const registry = getBuiltinToolRegistryForRuntime(runtime, {
        agents: new Map(runtime.agents),
        skills: new Map(runtime.skills),
        mcpManager,
      });
      // Empty allowlist = no tools. Agents that need all tools must use ['*'].
      const allowedTools = registry
        .filter([...params.agent.allowed_tools])
        .map((tool) => tool.definition.name)
        .filter((name) => !SUBAGENT_FORBIDDEN_TOOLS.has(name));
      const agentForRun: Agent = { ...params.agent, allowed_tools: allowedTools };
      // Root AGENTS.md injection is non-fatal: an fs/config failure falls back
      // to the un-augmented prompt rather than failing the delegation (the
      // adjacent tracker seeding is already non-fatal).
      const basePrompt = params.agent.system_prompt || 'You are a helpful assistant.';
      let fullPrompt = basePrompt;
      try {
        fullPrompt = appendRootAgentsMd(basePrompt, runtime);
      } catch (err) {
        console.debug('root AGENTS.md injection failed (non-fatal):', err);
      }
      yield* streamChat({
        // A resumed run replays its full chain; a spawn sends just the task.
        messages: params.history ?? [makeUserMessage(params.task)],
        agent: agentForRun,
        systemPrompt: fullPrompt,
        context,
        config,
        registry,
        mcpManager,
        sessionId,
        windowId: params.windowId,
        projectRuntime: runtime,
        agentScopeId: params.agentScopeId,
        abortSignal: params.abortSignal,
        modelInstance,
        accounting,
        providerOptions,
        thinkingReplay: {
          policy: thinkingPolicy ?? DEFAULT_THINKING_POLICY,
          selection: { providerId: providerSnapshot.providerId, modelId: selection.modelId },
          protocol: providerSnapshot.protocol as ProviderProtocol,
        } satisfies ThinkingReplayContext,
        cachePlacement: cacheFacet
          ? { facet: cacheFacet, ttl: cacheTtl, sessionKey: cacheSessionKey }
          : undefined,
      });
    } finally {
      releaseProjectMCPManager(runtime);
    }
  };
}
