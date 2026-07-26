/**
 * Root AGENTS.md injection into the static system instructions.
 *
 * A sibling to `appendProjectPersonality`: locate the workspace-root instruction
 * file (root tier only) and append its byte-capped content under a clear
 * heading. No-op when the feature is disabled or no root file exists. Pure and
 * side-effect-light — reads the single root file and never touches the tracker
 * (seeding the session tracker happens at the chat.ts call site, R13).
 */
import path from 'node:path';
import {
  readAgentsMdContent,
  resolveAgentsMdChain,
  type AgentsMdEntry,
} from '../agents-md/resolver';
import type { Config } from '../config/schema';
import type { ProjectRuntime } from './runtime';

/**
 * Find the root instruction file governing the workspace, or null when the
 * feature is disabled or no root-tier file exists. `projectDir` is already
 * canonical (it comes from `ProjectRuntime.projectDir`), matching how the
 * resolver treats `cwd`.
 */
export function findRootAgentsMdEntry(
  projectDir: string,
  config: Config,
): AgentsMdEntry | null {
  // A missing `agents_md` block (e.g. a partial config) degrades to disabled.
  if (!config.agents_md?.enabled) return null;

  // The resolver walks up from `dirname(target)` and tags the `cwd`-level file
  // `root`. Targeting `projectDir` itself would start the walk one level too
  // high (its parent) and miss the root, so resolve for a synthetic path
  // directly inside the root — only its containing directory matters.
  const chain = resolveAgentsMdChain(
    path.join(projectDir, 'AGENTS.md'),
    projectDir,
    config,
  );
  return chain.find((entry) => entry.tier === 'root') ?? null;
}

/**
 * Append the root instruction file's content to the system prompt without
 * mutating the base prompt. Returns the prompt unchanged when the feature is
 * disabled or no root file exists. Over-cap files inject a head plus a `read`
 * pointer instead of the full content (R5).
 */
export function appendRootAgentsMd(
  agentSystemPrompt: string,
  runtime: ProjectRuntime,
): string {
  const entry = findRootAgentsMdEntry(runtime.projectDir, runtime.config);
  if (entry === null) return agentSystemPrompt;

  const maxBytes = runtime.config.agents_md.max_file_bytes;
  const { content, truncated } = readAgentsMdContent(entry, maxBytes);
  const note = truncated
    ? `\n[truncated to ${maxBytes} bytes — use read for the full file]\n`
    : '';
  return `${agentSystemPrompt}\n\n## Project instructions (${entry.displayPath})\n\n${content}\n${note}`;
}
