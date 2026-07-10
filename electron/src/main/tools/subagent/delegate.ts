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
import type { SubagentManager } from '../../agents/manager';
import { getModelForTier } from '../../config/loader';
import { getSessionManager } from '../../ipc/session';

/**
 * Result returned by all subagent tool handlers.
 */
export interface SubagentToolResult {
  /** Brief summary for UI display */
  display: string;
  /** Full content (may include XML-like structured data) */
  content: string;
  /** Explicit failure flag for UI/status (never inferred from content). */
  isError?: boolean;
}

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
        .string()
        .optional()
        .describe(
          `Override the agent's default model tier. ` +
            `The tier determines which model is used for this task. ` +
            `If omitted, the agent's predefined tier is used.\n\n` +
            `Available tiers (from fastest to most capable):\n${tierLines}`,
        ),
    }),
    actionLabel: 'Delegating...',
    category: 'subagent',
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<SubagentToolResult> => {
    const { name, task, type, tier } = input as {
      name: string;
      task: string;
      type: string;
      tier?: string;
    };

    // Look up agent from registry
    const agent = agents.get(type);
    if (!agent) {
      const available = Array.from(agents.keys()).join(', ');
      return {
        display: `Unknown agent type: ${type}`,
        content: `Error: agent type '${type}' does not exist. Available agents: ${available}`,
      isError: true,
      };
    }

    // Resolve tier — use override if provided, otherwise agent's default
    let resolvedTier: AgentTier;
    if (tier !== undefined) {
      const validTiers = new Set<string>(Object.values(AgentTier));
      if (!validTiers.has(tier)) {
        const valid = Object.values(AgentTier).join(', ');
        return {
          display: `Invalid tier: ${tier}`,
          content: `Error: tier '${tier}' is not valid. Available tiers: ${valid}`,
      isError: true,
        };
      }
      resolvedTier = tier as AgentTier;
    } else {
      resolvedTier = agent.tier;
    }

    // Resolve model from tier via config
    const model = getModelForTier(resolvedTier);

    // Attribute usage to the active parent chain when available
    const session = getSessionManager().getActive();
    let parentChainIndex: number | undefined;
    if (session) {
      const idx = session.activeChainId
        ? session.chains.findIndex((c) => c.id === session.activeChainId)
        : -1;
      parentChainIndex =
        idx >= 0 ? idx : Math.max(0, session.chains.length - 1);
    }

    // Spawn + start background run (when runner is configured).
    // Freeze parent-turn cwd so mid-turn workspace changes do not rebind the subagent.
    const record = manager.spawn(name, task, agent, {
      model,
      parentChainIndex,
      // Prefer frozen turn context sessionId over live getActive() (mid-turn switch).
      sessionId: ctx?.sessionId ?? session?.id,
      cwd: ctx?.cwd,
    });

    return {
      display: `Subagent '${name}' spawned (id: ${record.id}, tier: ${resolvedTier})`,
      content:
        `<subagent id="${record.id}" name="${name}" type="${type}" status="${record.state}" tier="${resolvedTier}">\n` +
        `<task>\n${task}\n</task>\n` +
        `</subagent>`,
    };
  };

  return { definition, handler };
}
