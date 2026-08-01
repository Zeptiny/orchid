/**
 * Agent registry — loads, merges, and provides access to agent definitions.
 *
 * Agents are loaded from AGENT.md files in subdirectories of:
 *   1. `~/.orchid/agents/`  (home defaults)
 *   2. `.orchid/agents/`    (project overrides)
 *
 * Project agents overlay home agents (same name → project wins).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentType,
  AgentTier,
  type Agent,
} from '../../shared/types/agent';
import {
  parseFrontmatter,
  getString,
  getStringArray,
} from '../../shared/utils/frontmatter';
import {
  HOME_AGENTS_DIR,
} from '../config/loader';
import { RESERVED_INTERNAL_AGENT_NAMES } from '../defs/paths';
import { seedDefaultSubdirs } from '../utils/seed-defaults';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_FILENAME = 'AGENT.md';

/** Valid agent types (must match the AgentType const object) */
const VALID_TYPES = new Set<string>(Object.values(AgentType));

/** Valid agent tiers (must match the AgentTier const object) */
const VALID_TIERS = new Set<string>(Object.values(AgentTier));

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let agentRegistry: Map<string, Agent> = new Map();

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Load all agents from a single directory.
 * Each agent lives in a subdirectory containing an AGENT.md file.
 */
function loadAgentsFromDir(agentsDir: string): Map<string, Agent> {
  const agents = new Map<string, Agent>();

  if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    return agents;
  }

  const entries = fs.readdirSync(agentsDir).sort();

  for (const entry of entries) {
    const subDir = path.join(agentsDir, entry);
    if (!fs.statSync(subDir).isDirectory()) continue;

    const agentFile = path.join(subDir, AGENT_FILENAME);
    if (!fs.existsSync(agentFile)) continue;

    let content: string;
    try {
      content = fs.readFileSync(agentFile, 'utf-8');
    } catch {
      // Skip unreadable files
      continue;
    }

    const { metadata, body } = parseFrontmatter(content);

    const name = getString(metadata, 'name', entry);
    const rawType = getString(metadata, 'type', 'subagent').toLowerCase();
    const rawTier = getString(metadata, 'tier', AgentTier.BLOOM).toLowerCase();
    const description = getString(metadata, 'description', '');
    const allowedTools = getStringArray(metadata, 'allowed_tools');
    const allowedSkills = getStringArray(metadata, 'allowed_skills', ['*']);

    const rawEffort = metadata['reasoning_effort'];
    let reasoning_effort: string | number | undefined;
    if (typeof rawEffort === 'number') {
      reasoning_effort = Number.isFinite(rawEffort) ? rawEffort : undefined;
    } else if (typeof rawEffort === 'string' && rawEffort.trim() !== '') {
      const num = Number(rawEffort);
      reasoning_effort = Number.isFinite(num) ? num : rawEffort;
    }

    // Validate required fields
    if (!description) continue;
    if (!VALID_TYPES.has(rawType)) continue;
    if (!VALID_TIERS.has(rawTier)) continue;

    const agent: Agent = {
      name,
      type: rawType as AgentType,
      tier: rawTier as AgentTier,
      description,
      system_prompt: body.trim(),
      allowed_tools: Object.freeze(allowedTools),
      allowed_skills: Object.freeze(allowedSkills),
      ...(reasoning_effort !== undefined ? { reasoning_effort } : {}),
    };

    agents.set(agent.name, agent);
  }

  return agents;
}

/** Optional resource subtrees that may ship with default agents. */
const AGENT_RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReadAgentsOptions {
  /** Override home agents directory (default: `~/.orchid/agents/`). */
  homeDir?: string;
  /** Project agents directory (for example `<workspace>/.orchid/agents`). */
  projectDir?: string;
}

/**
 * Read and merge agent definitions without changing process-wide state.
 *
 * Each invocation returns a new map. Project agents overlay home agents,
 * except for reserved/internal home definitions which cannot be shadowed.
 */
export function readAgents(
  options?: ReadAgentsOptions,
): Map<string, Agent> {
  const homeDir = options?.homeDir ?? HOME_AGENTS_DIR;

  const homeAgents = loadAgentsFromDir(homeDir);
  const projectAgents = options?.projectDir
    ? loadAgentsFromDir(options.projectDir)
    : new Map<string, Agent>();

  const merged = new Map<string, Agent>(homeAgents);
  for (const [name, agent] of projectAgents) {
    const home = homeAgents.get(name);
    if (home?.type === AgentType.INTERNAL) continue;
    if (RESERVED_INTERNAL_AGENT_NAMES.has(name)) continue;
    merged.set(name, agent);
  }

  return merged;
}

/**
 * Load all agents by merging home and project agent directories.
 *
 * Merge semantics: home agents loaded first, then project agents overlay
 * (same name → project wins).
 *
 * @param options.homeDir  Override home agents directory (default: `~/.orchid/agents/`)
 * @param options.projectDir  Project agents directory (e.g. `<workspace>/.orchid/agents`).
 *   When omitted, only home agents load — never invents process.cwd().
 */
export function loadAgents(
  options?: ReadAgentsOptions,
): Map<string, Agent> {
  const merged = readAgents(options);
  agentRegistry = merged;

  return merged;
}

/**
 * Get a single agent by name.
 * Returns `undefined` if not found.
 */
export function getAgent(name: string): Agent | undefined {
  return agentRegistry.get(name);
}

/**
 * List all currently loaded agents.
 */
export function listAgents(): Agent[] {
  return Array.from(agentRegistry.values());
}

/**
 * Seed default agent trees into the given home directory.
 * Missing agents are copied recursively (AGENT.md + any resource subtrees).
 * Existing AGENT.md is preserved; missing resource subtrees are filled in.
 */
export function seedAgentsDir(homeDir: string): void {
  const defaultsDir = path.join(__dirname, 'defaults');
  seedDefaultSubdirs(defaultsDir, homeDir, {
    markerFilename: AGENT_FILENAME,
    resourceDirs: AGENT_RESOURCE_DIRS,
  });
}

/**
 * Reset the agent registry (clear all loaded agents).
 */
export function resetAgentRegistry(): void {
  agentRegistry = new Map();
}
