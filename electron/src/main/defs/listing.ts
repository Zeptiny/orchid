/**
 * Definitions listing — the electron-free `definitions.list` builder shared
 * by the definitions IPC boundary (ipc/definitions.ts) and the host protocol
 * (host/server.ts).
 */
import {
  listManagedAgents,
  listManagedPersonalities,
  listManagedSharedPrompts,
  listManagedSkills,
} from './manage';
import { getProjectMCPManager } from '../mcp/project-registry';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { getProjectTrustState } from '../project/trust';
import { toolRegistry } from '../tools';

/**
 * Namespaced MCP tool names (`mcp::server::tool`) for one bound project.
 *
 * The builtin-tool singleton never carries MCP tools (they are merged into
 * per-turn registries), so the allowed-tools picker must source them from the
 * project MCP manager. Untrusted projects hold a dormant manager with no
 * tools, so this stays trust-safe without an explicit gate. Any runtime or
 * manager failure must not break the listing.
 */
export function mcpToolNamesForProject(projectDir: string | null): string[] {
  if (projectDir == null) return [];
  try {
    const runtime = getProjectRuntimeRegistry().get(projectDir);
    return getProjectMCPManager(runtime)
      .getTools()
      .map(({ definition }) => definition.name);
  } catch (error) {
    console.warn(
      `Failed to enumerate MCP tools for '${projectDir}' (non-fatal):`,
      error,
    );
    return [];
  }
}

/** definitions.list — managed skills/agents/personalities/shared prompts. */
export function listDefinitions(projectDir: string | null) {
  // Untrusted projects list home-only definitions (no project overlay).
  const listProjectDir =
    projectDir != null && getProjectTrustState(projectDir) === 'trusted'
      ? projectDir
      : null;
  const skills = listManagedSkills(listProjectDir);
  const availableTools = toolRegistry
    .listAll()
    .map((t) => t.definition.name)
    .concat(mcpToolNamesForProject(projectDir))
    .sort((a, b) => a.localeCompare(b));
  // Unique skill names across scopes (prefer name as listed)
  const skillNames = new Set(skills.map((s) => s.name));
  return {
    projectDir,
    skills,
    agents: listManagedAgents(listProjectDir),
    personalities: listManagedPersonalities(listProjectDir),
    sharedPrompts: listManagedSharedPrompts(listProjectDir),
    availableTools,
    availableSkills: Array.from(skillNames).sort((a, b) => a.localeCompare(b)),
  };
}
