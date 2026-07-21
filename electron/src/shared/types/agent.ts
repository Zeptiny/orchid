/**
 * Agent types for the Orchid domain.
 *
 * Ported from src/orchid/domain/agent.py.
 */

// ── Enums as const objects ──────────────────────────────────────────────────

export const AgentType = {
  INTERNAL: 'internal',
  SUBAGENT: 'subagent',
} as const;

export type AgentType = (typeof AgentType)[keyof typeof AgentType];

export const AgentTier = {
  SEED: 'seed',
  BLOOM: 'bloom',
  CROWN: 'crown',
  SPROUT: 'sprout',
} as const;

export type AgentTier = (typeof AgentTier)[keyof typeof AgentTier];

export const TIER_DESCRIPTIONS: Record<AgentTier, string> = {
  [AgentTier.SEED]:
    'Fast and lightweight. Best for simple, mechanical tasks: file listing, ' +
    'basic searches, reading files, glob matching. No complex reasoning needed.',
  [AgentTier.SPROUT]:
    'Light reasoning. Good for code exploration, grep analysis, understanding ' +
    'file structure, reading comprehension, and summarizing findings.',
  [AgentTier.BLOOM]:
    'Standard reasoning. Use for implementation tasks, writing code, refactoring, ' +
    'multi-file changes, bug fixes, and following code conventions.',
  [AgentTier.CROWN]:
    'Deep reasoning. Use for architecture decisions, complex debugging, code review, ' +
    'design analysis, evaluating trade-offs, and tasks requiring careful judgment.',
};

// ── Agent ───────────────────────────────────────────────────────────────────

export interface Agent {
  readonly name: string;
  readonly type: AgentType;
  readonly tier: AgentTier;
  readonly description: string;
  readonly system_prompt: string;
  readonly allowed_tools: readonly string[];
  readonly allowed_skills: readonly string[];
  readonly reasoning_effort?: string | number;
}
