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
import type { SessionManager } from '../session/manager';

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

/**
 * Seed a subagent's scope-keyed tracker with the root instruction file
 * (R13/R15). A subagent starts fresh with only the root — it never inherits the
 * parent's seen nested files — so the nested read-path mechanism never
 * re-injects the root for it (R4). Because the store is keyed by session AND
 * agent scope (U2), seeding the subagent's scope does not touch the parent's
 * store. Non-fatal: a seeding failure must never break subagent startup.
 *
 * The session manager is resolved lazily via `createRequire` (mirroring
 * build-prompt-context.ts and tool-dispatch.ts) to avoid a circular init with
 * session/tools; tests may inject a constructed manager directly.
 */
export function seedSubagentRootAgentsMd(
  sessionId: string | undefined,
  agentScopeId: string,
  runtime: ProjectRuntime,
  manager?: SessionManager,
): void {
  if (!sessionId) return;
  try {
    let resolved = manager;
    if (!resolved) {
      // Lazy require avoids circular init with session/tools.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createRequire } = require('node:module') as typeof import('node:module');
      const req = createRequire(__filename);
      const session = req('../ipc/session') as typeof import('../ipc/session');
      resolved = session.getSessionManager();
    }
    const root = findRootAgentsMdEntry(runtime.projectDir, runtime.config);
    if (root) {
      resolved.getAgentsMdContextStore(sessionId, agentScopeId).seedRoot(root);
    }
  } catch (err) {
    console.debug('seedSubagentRootAgentsMd AGENTS.md context failed (non-fatal):', err);
  }
}
