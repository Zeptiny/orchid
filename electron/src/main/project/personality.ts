import type { ProjectRuntime } from './runtime';

/** Append the selected project personality without mutating the base prompt. */
export function appendProjectPersonality(
  agentSystemPrompt: string,
  runtime: ProjectRuntime,
): string {
  const name = runtime.config.personality;
  const personality = name ? runtime.personalities.get(name) : undefined;
  return personality
    ? `${agentSystemPrompt}\n\n## Personality\n\n${personality}\n`
    : agentSystemPrompt;
}
