/**
 * Subagent stream runner — drives streamChat for a delegated subagent.
 *
 * Used by SubagentManager when a runner is configured (production).
 * Tests leave the runner unset so spawn/markCompleted stay manual.
 */
import type { Agent } from '../../shared/types/agent';
import type { Message } from '../../shared/types/message';
import type { ReasoningProviderOptions } from '../providers/drivers/types';
import type { ModelSelection } from '../../shared/types/provider';
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
    let accountingStore: ReturnType<typeof getProviderAccountingStore>;
    try {
      accountingStore = getProviderAccountingStore();
      const execution = await getProviderRuntime().resolveExecution(selection);
      modelInstance = execution.modelInstance;
      providerSnapshot = execution.snapshot;
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
    };
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
      });
    } finally {
      releaseProjectMCPManager(runtime);
    }
  };
}
