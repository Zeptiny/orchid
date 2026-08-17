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
  readonly chains: readonly import('../../shared/types/chain').Chain[];
  readonly selection: ModelSelection | null;
  readonly config: import('../config/schema').Config;
  readonly sessionId: string;
  readonly subagentId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly inputTokens: number;
  readonly contextTokens: number;
  readonly triggerState?: import('../llm/compaction/trigger').TriggerState;
}): Promise<import('../llm/compaction/apply').ApplyResult | null> {
  const { messages, chains, selection, config, sessionId, subagentId, chainId, turnId, inputTokens, contextTokens } = params;
  const subagentsScope = (config as unknown as { compaction?: import('../../shared/types/ipc-boundary').CompactionConfig }).compaction?.subagents;
  if (!subagentsScope) return null;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return null;
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return null;

  // Lazy imports to avoid cycle with provider runtime during typecheck
  const { selectCut } = await import('../llm/compaction/select.js');
  const { mechanicalReclaim } = await import('../llm/compaction/reclaim.js');
  const { evaluateTriggerWithReclaim } = await import('../llm/compaction/trigger.js');
  const { buildCompactionApply } = await import('../llm/compaction/apply.js');
  const { getProviderAccountingStore } = await import('../providers/accounting/store.js');

  let cut: ReturnType<typeof selectCut>;
  try {
    cut = selectCut(messages as Message[], {
      keepRecentChains: subagentsScope.keep_recent_chains,
    });
  } catch {
    return null;
  }
  const compactableRange = cut.compactableRange;
  const compactableTokensApprox = Math.max(0, compactableRange.end - compactableRange.start) * 250; // coarse ~250 tokens/msg floor; trigger uses floor gate
  // Need at least a coarse estimate; trigger will gate on min_compactable_tokens
  // Use a tokenEstimator-like char heuristic for the slice when available
  const slice = messages.slice(compactableRange.start, compactableRange.end);
  let compactableTokens = 0;
  for (const m of slice as readonly Message[]) {
    const c = (m.content?.length ?? 0) + (m.thinking?.length ?? 0) + (m.tool_call_id?.length ?? 0) + (m.name?.length ?? 0);
    compactableTokens += Math.max(1, Math.ceil(c / 4));
    if (m.tool_calls) compactableTokens += Math.ceil(JSON.stringify(m.tool_calls).length / 4);
    if (m.tool_result) compactableTokens += Math.ceil(JSON.stringify(m.tool_result).length / 4);
  }
  if (compactableTokens === 0) compactableTokens = compactableTokensApprox;

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

  // Branch on compaction mode: selective uses manifest+LLM caller, simple uses summarizeCompactableRange.
  // Simple is default (opt-in selective via config.compaction.subagents.mode==='selective').
  if ((subagentsScope.mode as string) === 'selective') {
    // Selective path: build manifest, create LLM caller with subagent-scoped accounting, run multi-turn loop with simple fallback.
    let manifest: import('../llm/compaction/selective/manifest').Manifest | null = null;
    try {
      const { buildManifest } = await import('../llm/compaction/selective/manifest.js');
      manifest = buildManifest(messages as Message[], compactableRange);
    } catch {
      return null;
    }
    if (!manifest || manifest.entries.length === 0) return null;

    let accountingStore: ReturnType<typeof getProviderAccountingStore> | undefined;
    try {
      accountingStore = getProviderAccountingStore();
    } catch {
      accountingStore = undefined;
    }

    const compactableSliceForFallback = messages.slice(compactableRange.start, compactableRange.end) as Message[];
    const simpleFallback = async (): Promise<{ text: string } | null> => {
      try {
        const { summarizeCompactableRange } = await import('../llm/compaction/summarize.js');
        const res = await summarizeCompactableRange({
          messages: compactableSliceForFallback,
          scope: 'subagents',
          config,
          fallbackSelection: selection,
          existingModelSelection: selection,
          accounting: accountingStore
            ? { store: accountingStore, sessionId, chainId, turnId }
            : ({ sessionId, chainId, turnId } as unknown as Parameters<typeof summarizeCompactableRange>[0]['accounting']),
          subagentId,
        });
        if (!res || !res.text?.trim()) return null;
        return { text: res.text };
      } catch {
        return null;
      }
    };

    let selectiveCaller: import('../llm/compaction/selective/run').SelectiveCaller | null = null;
    try {
      const { createLlmSelectiveCaller } = await import('../llm/compaction/selective/run.js');
      selectiveCaller = createLlmSelectiveCaller({
        config,
        scope: 'subagents',
        fallbackSelection: selection,
        subagentId,
        accounting: accountingStore
          ? { store: accountingStore, sessionId, chainId, turnId }
          : ({ sessionId, chainId, turnId } as unknown as Parameters<typeof createLlmSelectiveCaller>[0]['accounting']),
      });
    } catch {
      return null;
    }
    if (!selectiveCaller) return null;

    let selectiveResult: import('../llm/compaction/selective/run').SelectiveCompactionResult | null = null;
    try {
      const { runSelectiveCompaction } = await import('../llm/compaction/selective/run.js');
      selectiveResult = await runSelectiveCompaction({
        messages: messages as Message[],
        compactableRange,
        manifest,
        selectiveCaller,
        simpleFallback,
      });
    } catch {
      return null;
    }
    if (!selectiveResult) return null;

    if (selectiveResult.kind === 'selective') {
      const mergedFlagged = [...new Set([...(selectiveResult.flaggedIds ?? []), ...flaggedIds])];
      const updatedMessages = [...selectiveResult.replayMessages] as Message[];
      const summaryMessage = (selectiveResult.summaryMessage as unknown as Message | null) ?? null;
      let updatedChains: import('../../shared/types/chain').Chain[];
      if (chains.length === 0) {
        updatedChains = [];
      } else if (chains.length === 1) {
        updatedChains = [{ ...chains[0]!, messages: [...updatedMessages] }];
      } else {
        updatedChains = chains.map((c, idx) => (idx === 0 ? { ...c, messages: [...updatedMessages] } : { ...c, messages: [...c.messages] }));
      }
      const compactedMarker = (summaryMessage as unknown as { compacted?: import('../../shared/types/message').CompactedMarker | null })?.compacted ?? null;
      const didApply = mergedFlagged.length > 0 || summaryMessage !== null || updatedMessages.length !== messages.length;
      if (!didApply) return null;
      const applyResult: import('../llm/compaction/apply').ApplyResult = {
        updatedMessages,
        updatedChains,
        summaryMessage,
        newChain: null,
        flaggedIds: mergedFlagged,
        compactedMarker: compactedMarker as import('../../shared/types/message').CompactedMarker | null,
        didApply: true,
      };
      return applyResult;
    }

    if (selectiveResult.kind === 'fallback') {
      const fallbackText = selectiveResult.fallbackText;
      if (!fallbackText || fallbackText.trim().length === 0) return null;
      try {
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
        return applyResult;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Simple default behavior (unchanged) — task-focused compactor-subagent, subagent-scoped accounting (R18)
  const compactableSlice = messages.slice(compactableRange.start, compactableRange.end) as Message[];
  if (compactableSlice.length === 0) return null;

  let accountingStore: ReturnType<typeof getProviderAccountingStore> | undefined;
  try {
    accountingStore = getProviderAccountingStore();
  } catch {
    accountingStore = undefined;
  }

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
