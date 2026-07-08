/**
 * Agent types for the Orchid domain.
 *
 * Ported from src/orchid/domain/agent.py.
 */

import { z } from 'zod';

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
  readonly allowed_tools: readonly string[];
  readonly allowed_skills: readonly string[];
}

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const agentTypeSchema = z.enum([AgentType.INTERNAL, AgentType.SUBAGENT]);

export const agentTierSchema = z.enum([
  AgentTier.SEED,
  AgentTier.BLOOM,
  AgentTier.CROWN,
  AgentTier.SPROUT,
]);

export const agentSchema = z.object({
  name: z.string(),
  type: agentTypeSchema,
  tier: agentTierSchema.default(AgentTier.BLOOM),
  description: z.string(),
  allowed_tools: z.array(z.string()).default([]),
  allowed_skills: z.array(z.string()).default([]),
});

// ── Storage dict ────────────────────────────────────────────────────────────

export interface AgentStorageDict {
  name: string;
  type: string;
  tier?: string;
  description: string;
  allowed_tools?: string[];
  allowed_skills?: string[];
  [key: string]: unknown;
}

// ── Serialization ───────────────────────────────────────────────────────────

export function agentToStorageDict(agent: Agent): AgentStorageDict {
  return {
    name: agent.name,
    type: agent.type,
    tier: agent.tier,
    description: agent.description,
    allowed_tools: [...agent.allowed_tools],
    allowed_skills: [...agent.allowed_skills],
  };
}

export function agentFromStorageDict(data: unknown): Agent {
  const raw = data as Record<string, unknown>;

  // Parse type with fallback
  let type: AgentType = AgentType.SUBAGENT;
  const rawType = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  if (rawType === 'internal' || rawType === 'subagent') {
    type = rawType;
  }

  // Parse tier with fallback
  let tier: AgentTier = AgentTier.BLOOM;
  const rawTier = typeof raw.tier === 'string' ? raw.tier.toLowerCase() : '';
  if (
    rawTier === 'seed' || rawTier === 'bloom' ||
    rawTier === 'crown' || rawTier === 'sprout'
  ) {
    tier = rawTier;
  }

  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    type,
    tier,
    description: typeof raw.description === 'string' ? raw.description : '',
    allowed_tools: Array.isArray(raw.allowed_tools)
      ? (raw.allowed_tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    allowed_skills: Array.isArray(raw.allowed_skills)
      ? (raw.allowed_skills as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
  };
}
