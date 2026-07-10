/**
 * Apply project-scoped config / agents / skills when the workspace changes.
 *
 * R5: On bind or session cwd change, reset ConfigManager and re-merge
 * `.orchid.json`, then reload project agents/skills under
 * `.orchid/agents` and `.orchid/skills`. Home dirs are unchanged.
 *
 * Does NOT terminate background commands (spawn cwd stays sticky).
 * Does NOT call process.chdir.
 */
import * as path from 'node:path';
import {
  ConfigManager,
  getConfig,
  type LoadConfigOptions,
} from '../config/loader';
import type { Config } from '../config/schema';
import { loadAgents } from '../agents/registry';
import { loadSkills } from '../skills/registry';
import { loadPersonalities } from '../personality/registry';
import type { Agent } from '../../shared/types/agent';
import type { Skill } from '../../shared/types/skill';
import { canonicalizeProjectDirectory } from './path';

// ---------------------------------------------------------------------------
// State — skip redundant reloads for the same project dir
// ---------------------------------------------------------------------------

/** Canonical absolute path of the last applied project layers (or null). */
let lastAppliedProjectDir: string | null = null;

/** Last applied project dir (for tests / diagnostics). */
export function getLastAppliedProjectDir(): string | null {
  return lastAppliedProjectDir;
}

/** Clear tracked project dir so the next apply always reloads (tests). */
export function resetLastAppliedProjectDir(): void {
  lastAppliedProjectDir = null;
}

// ---------------------------------------------------------------------------
// Options / result
// ---------------------------------------------------------------------------

export interface ApplyWorkspaceProjectLayersOptions {
  /**
   * Force reload even when `projectDir` matches `lastAppliedProjectDir`.
   * Useful for tests or after external config mutation.
   */
  force?: boolean;
  /** Override home config path (tests). */
  homeConfigPath?: string;
  /** Override home agents directory (tests). */
  homeAgentsDir?: string;
  /** Override home skills directory (tests). */
  homeSkillsDir?: string;
}

export interface ApplyWorkspaceProjectLayersResult {
  /** Whether layers were reloaded (false when skipped as redundant). */
  readonly applied: boolean;
  /** Canonical absolute project directory used for layers. */
  readonly projectDir: string;
  /** Config after load (cached ConfigManager instance). */
  readonly config: Config;
  /** Agent registry after reload (empty maps when skipped — use getAgent etc.). */
  readonly agents: Map<string, Agent> | null;
  /** Skill registry after reload. */
  readonly skills: Map<string, Skill> | null;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Normalize a project directory for last-applied comparison.
 * Prefer realpath canonical form when the path is a valid project dir.
 */
function normalizeProjectDir(projectDir: string): string {
  const canonical = canonicalizeProjectDirectory(projectDir);
  if (canonical != null) return canonical;
  // Still allow apply for missing dirs (home+defaults load; project overlay empty).
  return path.resolve(projectDir);
}

/**
 * Reset config cache, re-merge with `projectDir` as the project root, and
 * reload agents/skills so project overlays under `.orchid/{agents,skills}` apply.
 *
 * No-op (returns `applied: false`) when `projectDir` equals the last applied
 * path unless `force` is set.
 *
 * @param projectDir Absolute project root (session cwd / sticky default).
 */
export function applyWorkspaceProjectLayers(
  projectDir: string,
  options?: ApplyWorkspaceProjectLayersOptions,
): ApplyWorkspaceProjectLayersResult {
  const normalized = normalizeProjectDir(projectDir);

  if (!options?.force && lastAppliedProjectDir === normalized) {
    return {
      applied: false,
      projectDir: normalized,
      config: getConfig(),
      agents: null,
      skills: null,
    };
  }

  const loadOpts: LoadConfigOptions = { projectDir: normalized };
  if (options?.homeConfigPath !== undefined) {
    loadOpts.homeConfigPath = options.homeConfigPath;
  }

  // 1. Config: must reset before re-merge or project overrides stick forever.
  ConfigManager.reset();
  const config = ConfigManager.load(loadOpts);

  // 2. Agents / skills: projectDir option is the *registry* directory
  //    (`.orchid/agents` / `.orchid/skills`), not the project root.
  const agents = loadAgents({
    homeDir: options?.homeAgentsDir,
    projectDir: path.join(normalized, '.orchid', 'agents'),
  });
  const skills = loadSkills({
    homeDir: options?.homeSkillsDir,
    projectDir: path.join(normalized, '.orchid', 'skills'),
  });
  // Project personalities overlay home (same merge semantics as agents/skills).
  loadPersonalities({ projectDir: normalized });

  lastAppliedProjectDir = normalized;

  return {
    applied: true,
    projectDir: normalized,
    config,
    agents,
    skills,
  };
}
