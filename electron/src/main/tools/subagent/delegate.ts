/**
 * delegate_to_subagent tool — dynamically built from agent registry.
 *
 * Description lists available subagent agents with their tiers.
 * Params: name, task, type (agent name), optional tier override.
 * Looks up agent, resolves model via tier, spawns via SubagentManager.
 *
 * Ported from Python `src/orchid/tools/subagent.py` (build_delegate_tool / execute_delegate_to_subagent).
 */
import { z } from 'zod';
import type { Agent } from '../../../shared/types/agent';
import { AgentType, AgentTier, TIER_DESCRIPTIONS } from '../../../shared/types/agent';
import type { ToolDefinition, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import {
  genericBuiltInToolOutcome,
  type GenericBuiltInToolOutcome,
} from '../result';
import type { SubagentManager, SubagentRecord } from '../../agents/manager';
import { SubagentQueueFullError } from '../../agents/manager';
import { SubagentState } from '../../agents/types';
import { getTierModelSelection } from '../../config/loader';
import { getSessionManager } from '../../session/singleton';

/**
 * Result returned by all subagent tool handlers.
 */
export type SubagentToolResult = GenericBuiltInToolOutcome;

/**
 * Build the delegate_to_subagent tool.
 *
 * The description is dynamically constructed from the available agents,
 * listing each agent's name, tier, and description.
 *
 * @param agents - Map of agent name → Agent from the agent registry
 * @param manager - SubagentManager instance for spawning subagents
 */
export function buildDelegateTool(
  agents: Map<string, Agent>,
  manager: SubagentManager,
): { definition: ToolDefinition; handler: ToolHandler } {
  // Build dynamic description lines for available subagent agents
  const agentLines = Array.from(agents.entries())
    .filter(([, agent]) => agent.type === AgentType.SUBAGENT)
    .map(([name, agent]) => `- ${name} [${agent.tier}]: ${agent.description}`)
    .join('\n');

  // Build tier description lines
  const tierLines = Object.entries(TIER_DESCRIPTIONS)
    .map(([tier, desc]) => `- ${tier}: ${desc}`)
    .join('\n');

  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'delegate_to_subagent',
    description:
      'Delegate a task to a specialized subagent with an isolated context. ' +
      'Subagents do not share your context — you must provide all necessary information in the task description. ' +
      'Subagents cannot create subagents. Avoid spawning parallel subagents that edit the same files.',
    inputSchema: z.object({
      name: z
        .string()
        .describe(
          "A descriptive name for this subagent instance (e.g. 'explore auth module', 'review payment flow')",
        ),
      task: z
        .string()
        .describe(
          'The complete task description. Include all context the subagent needs: file paths, code snippets, requirements, constraints, and what to return.',
        ),
      type: z
        .string()
        .describe(`The agent type to delegate to. Available agents:\n${agentLines}`),
      tier: z
        .nativeEnum(AgentTier)
        .optional()
        .describe(
          `Override the agent's default model tier. ` +
            `The tier determines which model is used for this task. ` +
            `If omitted, the agent's predefined tier is used.\n\n` +
            `Available tiers (from fastest to most capable):\n${tierLines}`,
        ),
    }),
    category: 'subagent',
    riskClass: RiskClass.DELEGATION,
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<SubagentToolResult> => {
    const { name, task, type, tier } = input as {
      name: string;
      task: string;
      type: string;
      tier?: AgentTier;
    };

    // Look up agent from registry
    const agent = agents.get(type);
    if (!agent) {
      const available = Array.from(agents.keys()).join(', ');
      return genericBuiltInToolOutcome('delegate_to_subagent', `Error: agent type '${type}' does not exist. Available agents: ${available}`, 'error');
    }

    // Resolve tier — use override if provided, otherwise agent's default
    const resolvedTier: AgentTier = tier ?? agent.tier;

    // Resolve model from tier via config
    if (!ctx?.projectRuntime || !ctx.sessionId) {
      return genericBuiltInToolOutcome('delegate_to_subagent', 'Error: delegate_to_subagent requires a frozen project runtime and session id.', 'error');
    }
    const selection = ctx.selection
      ?? getTierModelSelection(ctx.projectRuntime.config, resolvedTier);

    // Attribute to the frozen parent turn. Never discover ownership from the
    // process's currently selected session after another session is opened.
    const sessionManager = getSessionManager();
    const session = sessionManager.getSession(ctx.sessionId);
    let parentChainIndex: number | undefined;
    if (session) {
      const idx = session.activeChainId
        ? session.chains.findIndex((c) => c.id === session.activeChainId)
        : -1;
      parentChainIndex =
        idx >= 0 ? idx : Math.max(0, session.chains.length - 1);
    }

    // Spawn + start background run (when runner is configured), or park in
    // the admission queue when the active limits are reached.
    // Freeze parent-turn cwd so mid-turn workspace changes do not rebind the subagent.
    let record: SubagentRecord;
    try {
      record = manager.spawn(name, task, agent, {
        selection,
        parentChainIndex,
        // Prefer frozen turn context sessionId over live getActive() (mid-turn switch).
        sessionId: ctx.sessionId,
        windowId: ctx.windowId,
        cwd: ctx.cwd,
        projectRuntime: ctx.projectRuntime,
      });
    } catch (err) {
      if (err instanceof SubagentQueueFullError) {
        return genericBuiltInToolOutcome('delegate_to_subagent', `Error: ${err.message}`, 'error');
      }
      throw err;
    }

    const queuePosition = record.state === SubagentState.QUEUED
      ? manager.getQueuePosition(record.id)
      : null;

    return genericBuiltInToolOutcome(
      'delegate_to_subagent',
      {
        id: record.id,
        name,
        type,
        status: record.state,
        tier: resolvedTier,
        task,
        ...(queuePosition !== null ? { queue_position: queuePosition } : {}),
      },
      'complete',
    );
  };

  return { definition, handler };
}
