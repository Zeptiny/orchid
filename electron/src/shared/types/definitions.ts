/**
 * Shared types for skills / agents / personalities management UI + IPC.
 */

import type { AgentTier, AgentType } from './agent';
import type { SkillResource } from './skill';

/** Where a definition file lives on disk. */
export type DefinitionScope = 'global' | 'project';

/** Safe directory / file stem names: `my-skill`, `code_review`, `explorer`. */
export const DEFINITION_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

export interface ManagedSkill {
  readonly name: string;
  readonly description: string;
  readonly requires: readonly string[];
  readonly content: string;
  readonly resources: readonly SkillResource[];
  readonly scope: DefinitionScope;
  /** Absolute path to SKILL.md */
  readonly path: string;
  /** True when a project-level file with the same name also exists. */
  readonly overriddenByProject: boolean;
}

export interface ManagedAgent {
  readonly name: string;
  readonly type: AgentType;
  readonly tier: AgentTier;
  readonly description: string;
  readonly system_prompt: string;
  readonly allowed_tools: readonly string[];
  readonly allowed_skills: readonly string[];
  readonly reasoning_effort?: string | number;
  readonly scope: DefinitionScope;
  /** Absolute path to AGENT.md */
  readonly path: string;
  readonly overriddenByProject: boolean;
}

export interface ManagedPersonality {
  readonly name: string;
  readonly content: string;
  readonly scope: DefinitionScope;
  /** Absolute path to `<name>.md` */
  readonly path: string;
  readonly overriddenByProject: boolean;
}

/**
 * Shared prompt slots — fixed singleton prompt files injected into the
 * system prompt alongside each agent's own instructions.
 *
 * - `all-agents`: injected for the main agent and every subagent
 * - `subagents`: injected for subagents only (parallel-work awareness, …)
 */
export type SharedPromptSlot = 'all-agents' | 'subagents';

export const SHARED_PROMPT_SLOTS: readonly SharedPromptSlot[] = ['all-agents', 'subagents'];

export interface ManagedSharedPrompt {
  readonly slot: SharedPromptSlot;
  readonly content: string;
  readonly scope: DefinitionScope;
  /** Absolute path to `<slot>.md` */
  readonly path: string;
  readonly overriddenByProject: boolean;
}

export interface SkillSaveMessage {
  /** Write scope. Project requires a bound workspace. */
  scope: DefinitionScope;
  name: string;
  description: string;
  requires?: string[];
  content: string;
  /**
   * When renaming, previous name under the same scope.
   * If omitted, name is treated as the sole identity.
   */
  previousName?: string;
}

export interface AgentSaveMessage {
  scope: DefinitionScope;
  name: string;
  type: AgentType;
  tier: AgentTier;
  description: string;
  system_prompt: string;
  allowed_tools: string[];
  allowed_skills: string[];
  reasoning_effort?: string | number;
  previousName?: string;
}

export interface PersonalitySaveMessage {
  scope: DefinitionScope;
  name: string;
  content: string;
  previousName?: string;
}

export interface SharedPromptSaveMessage {
  /** Write scope. Project requires a bound workspace. */
  scope: DefinitionScope;
  slot: SharedPromptSlot;
  content: string;
}

export interface SharedPromptDeleteMessage {
  scope: DefinitionScope;
  slot: SharedPromptSlot;
}

export interface DefinitionDeleteMessage {
  scope: DefinitionScope;
  name: string;
}

export interface DefinitionRevealMessage {
  /** Absolute path returned by list/get. */
  path: string;
}

export interface DefinitionsListResult {
  /** Bound workspace project root, or null when unbound. */
  projectDir: string | null;
  skills: ManagedSkill[];
  agents: ManagedAgent[];
  personalities: ManagedPersonality[];
  sharedPrompts: ManagedSharedPrompt[];
  /**
   * Registered tool names available for agent `allowed_tools` selection.
   * Includes built-ins and currently registered MCP tools.
   */
  availableTools: string[];
  /**
   * Unique skill names (effective registry) available for `allowed_skills`.
   * Does not include the `*` wildcard — UI may offer it separately.
   */
  availableSkills: string[];
}
