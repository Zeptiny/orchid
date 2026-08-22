/**
 * Shared prompt injection into the static system instructions.
 *
 * Siblings to `appendProjectPersonality` / `appendRootAgentsMd`: append the
 * resolved shared prompt slots (from the project runtime snapshot) under
 * clear headings without mutating the base prompt. Pure — reads only the
 * frozen runtime, never touches disk or the AGENTS.md tracker.
 */
import type { ProjectRuntime } from './runtime';

/**
 * Append the all-agents shared rules. Injected for the main agent and every
 * subagent — internal agents (session-namer, web-fetch) opt out at their
 * call sites to keep their prompts minimal.
 */
export function appendSharedRules(
  agentSystemPrompt: string,
  runtime: ProjectRuntime,
): string {
  const rules = runtime.sharedPrompts['all-agents'];
  return rules
    ? `${agentSystemPrompt}\n\n## Shared rules\n\n${rules}\n`
    : agentSystemPrompt;
}

/**
 * Append the subagents-only shared rules (parallel-work awareness, mutation
 * limits, …). Injected after the all-agents slot so subagent-specific
 * guidance reads as a refinement of the shared baseline.
 */
export function appendSubagentRules(
  agentSystemPrompt: string,
  runtime: ProjectRuntime,
): string {
  const rules = runtime.sharedPrompts.subagents;
  return rules
    ? `${agentSystemPrompt}\n\n## Subagent rules\n\n${rules}\n`
    : agentSystemPrompt;
}
