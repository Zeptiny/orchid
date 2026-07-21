import type { ReasoningModelConfig } from '../../shared/types/provider';

interface ReasoningConnection {
  reasoningConfig?: Record<string, ReasoningModelConfig>;
}

/**
 * Resolve the effective reasoning effort for a main agent turn.
 *
 * Cascade: session override → connection model default → undefined (omit).
 * Returns undefined when the model does not support reasoning.
 */
export function resolveMainAgentEffort(
  session: { reasoningEffortOverride: string | number | null },
  connection: ReasoningConnection,
  modelId: string,
  modelSupportsReasoning: boolean,
): string | number | undefined {
  if (!modelSupportsReasoning) return undefined;
  return (
    session.reasoningEffortOverride ??
    connection.reasoningConfig?.[modelId]?.default ??
    undefined
  );
}

/**
 * Resolve the effective reasoning effort for a subagent turn.
 *
 * Cascade: agent definition field → tier config → connection model default →
 * undefined (omit). Returns undefined when the model does not support
 * reasoning.
 */
export function resolveSubagentEffort(
  agent: { reasoning_effort?: string | number; tier: string },
  config: { tier_reasoning_effort: Record<string, string | number | null> },
  connection: ReasoningConnection,
  modelId: string,
  modelSupportsReasoning: boolean,
): string | number | undefined {
  if (!modelSupportsReasoning) return undefined;
  return (
    agent.reasoning_effort ??
    config.tier_reasoning_effort[agent.tier] ??
    connection.reasoningConfig?.[modelId]?.default ??
    undefined
  );
}
