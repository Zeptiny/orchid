/**
 * Subagent stream runner — drives streamChat for a delegated subagent.
 *
 * Used by SubagentManager when a runner is configured (production).
 * Tests leave the runner unset so spawn/markCompleted stay manual.
 */
import type { Agent } from '../../shared/types/agent';
import type { StreamEvent } from '../llm/orchestrator';
import { getConfig } from '../config/loader';
import { resolveModelRef } from '../llm/providers';
import { createProviderModel } from '../llm/providers-factory';
import { getSessionManager } from '../ipc/session';
import { getMCPManagerRef } from '../ipc/mcp';
import { toolRegistry } from '../tools';
import type { SubagentStreamRunner } from './manager';

/** Tools that must never run inside a subagent (no nested delegation). */
const SUBAGENT_FORBIDDEN_TOOLS = new Set([
  'delegate_to_subagent',
  'wait_for_subagent',
  'interrupt_subagents',
]);

/**
 * Create the production stream runner for subagents.
 * Resolves model, strips nested-subagent tools, and yields StreamEvents.
 */
export function createSubagentStreamRunner(): SubagentStreamRunner {
  return async function* subagentStream(params: {
    task: string;
    agent: Agent;
    model: string | null;
    abortSignal: AbortSignal;
    sessionId?: string;
  }): AsyncGenerator<StreamEvent> {
    const config = getConfig();
    const { streamChat } = await import('../llm/orchestrator');

    // Resolve model: explicit override → tier model → default
    const modelId =
      params.model ||
      config.tier_models[params.agent.tier] ||
      config.default_model;
    const modelRef = resolveModelRef(modelId, config);
    const modelInstance = await createProviderModel(modelRef);

    // Strip nested-subagent tools even when agent allows '*'
    const allowedPatterns =
      params.agent.allowed_tools.length > 0 ? [...params.agent.allowed_tools] : ['*'];
    const allowedNames = toolRegistry
      .filter(allowedPatterns)
      .map((t) => t.definition.name)
      .filter((name) => !SUBAGENT_FORBIDDEN_TOOLS.has(name));

    const agentForRun: Agent = {
      ...params.agent,
      allowed_tools: allowedNames,
    };

    const sessionId =
      params.sessionId ?? getSessionManager().getActive()?.id;

    const context = {
      cwd: process.cwd(),
      osInfo: `${process.platform} ${process.arch}`,
      time: new Date().toISOString(),
      subagentStates: [],
      todos: [],
      backgroundCommands: [],
    };

    // Isolated history: only the subagent's task (no parent context).
    // streamChat builds API messages from this; the manager owns the persisted chain.
    const messages: import('../../shared/types/message').Message[] = [
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: params.task,
        type: 'text',
        tool_calls: null,
        tool_call_id: null,
        name: null,
        thinking: null,
        timestamp: new Date().toISOString(),
        usage: null,
        hidden: false,
    is_error: false,
  },
    ];

    const stream = streamChat({
      messages,
      agent: agentForRun,
      systemPrompt: params.agent.system_prompt || 'You are a helpful assistant.',
      context,
      config,
      registry: toolRegistry,
      mcpManager: getMCPManagerRef(),
      sessionId,
      abortSignal: params.abortSignal,
      modelInstance,
    });

    yield* stream;
  };
}
