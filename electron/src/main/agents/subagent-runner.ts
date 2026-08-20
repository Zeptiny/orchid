/**
 * Subagent stream runner — drives streamChat for a delegated subagent.
 *
 * Used by SubagentManager when a runner is configured (production).
 * Tests leave the runner unset so spawn/markCompleted stay manual.
 *
 * Mid-run compaction (U5): the run's history is a mutable box shared with the
 * manager's compaction controller. The orchestrator's early-stop predicate is
 * wired to the scoped pause registry; when the stream stops at a step boundary
 * with the pause armed, the runner awaits the pause controller's apply
 * (re-validate against live history, apply, swap the box) and RESTARTS the
 * stream with the box's (possibly compacted) history — the generator host of
 * main's idle-intercept resume. An abort or interrupt at any point breaks out
 * of the restart loop cleanly with no further events.
 */
import type { Agent } from '../../shared/types/agent';
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
import type {
  SubagentCompactionPauseController,
  SubagentHistoryBox,
  SubagentPauseApplyOutcome,
  SubagentStreamRunner,
} from './manager';
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
    /** Mutable history handoff for the run; absent = spawn path (task only). */
    historyBox?: SubagentHistoryBox;
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
    /** Compaction pause gate for this run's scope (U5); absent = never pauses. */
    compaction?: SubagentCompactionPauseController;
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
      // U5: the run's history is a mutable handoff. Every stream segment reads
      // the box's CURRENT contents, so a compaction apply that swaps it between
      // segments makes the next provider call replay the compacted history.
      // Without a box (spawn without one) the run replays just the task.
      const historyBox: SubagentHistoryBox =
        params.historyBox ?? { messages: [makeUserMessage(params.task)] };
      const pause = params.compaction;
      while (!params.abortSignal.aborted) {
        yield* streamChat({
          messages: [...historyBox.messages],
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
          // Scoped compaction pause (R28): the multi-step loop stops cleanly
          // at the next step boundary while the pause is armed.
          ...(pause ? { shouldStopEarly: () => pause.shouldPause() } : {}),
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
        if (!pause || params.abortSignal.aborted || !pause.shouldPause()) break;
        // The stream stopped at a step boundary with the pause armed — consume
        // it (re-validate + apply + swap the box) and restart with whatever
        // history the controller left in the box. 'applied' and 'skipped' both
        // resume the loop (main's semantics: resume with the accumulated
        // history when the summary cannot be applied); 'degraded' (partial
        // report set) and 'aborted' end the run without another segment.
        // The await races the abort signal so an interrupt during the pause
        // (or a summarizer wait) breaks out of the restart loop cleanly.
        const outcome = await new Promise<SubagentPauseApplyOutcome | null>((resolve) => {
          if (params.abortSignal.aborted) {
            resolve(null);
            return;
          }
          let settled = false;
          const settle = (value: SubagentPauseApplyOutcome | null): void => {
            if (settled) return;
            settled = true;
            params.abortSignal.removeEventListener('abort', onAbort);
            resolve(value);
          };
          const onAbort = (): void => settle(null);
          params.abortSignal.addEventListener('abort', onAbort, { once: true });
          pause.applyAtPause().then(settle, () => settle(null));
        });
        if (params.abortSignal.aborted || outcome == null || outcome === 'aborted' || outcome === 'degraded') {
          return;
        }
      }
    } finally {
      releaseProjectMCPManager(runtime);
    }
  };
}
