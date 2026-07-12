/**
 * Project-scoped runtime snapshots.
 *
 * Unlike the legacy workspace-layer application path, reading a runtime does
 * not replace process-wide config or definition registries. Multiple project
 * snapshots can therefore coexist safely in the Electron main process.
 */
import * as path from 'node:path';
import type { Agent } from '../../shared/types/agent';
import type { Skill } from '../../shared/types/skill';
import { readAgents } from '../agents/registry';
import { loadConfig } from '../config/loader';
import { injectKeychainKeys } from '../config/keychain';
import type { Config } from '../config/schema';
import { readPersonalities } from '../personality/registry';
import { readSkills } from '../skills/registry';
import { canonicalizeProjectDirectory } from './path';

export interface ProjectRuntime {
  /** Canonical absolute project root used as this runtime's identity. */
  readonly projectDir: string;
  /** Defaults + home + this project's `.orchid.json` + environment. */
  readonly config: Config;
  /** Home agents overlaid by this project's agents. */
  readonly agents: ReadonlyMap<string, Agent>;
  /** Home skills overlaid by this project's skills. */
  readonly skills: ReadonlyMap<string, Skill>;
  /** Home personalities overlaid by this project's personalities. */
  readonly personalities: ReadonlyMap<string, string>;
}

export interface ProjectRuntimeRegistryOptions {
  /** Override the home config path (primarily for tests). */
  readonly homeConfigPath?: string;
  /** Override the home agents directory. */
  readonly homeAgentsDir?: string;
  /** Override the home skills directory. */
  readonly homeSkillsDir?: string;
  /** Override the home personalities directory. */
  readonly homePersonalitiesDir?: string;
}

function requireCanonicalProjectDirectory(projectDir: string): string {
  if (!path.isAbsolute(projectDir)) {
    throw new TypeError('Project directory must be an absolute path.');
  }

  const canonical = canonicalizeProjectDirectory(projectDir);
  if (canonical == null) {
    throw new Error(
      `Project directory must exist and be accessible: ${projectDir}`,
    );
  }
  return canonical;
}

/**
 * Cache of independently loaded project runtimes, keyed by canonical path.
 */
export class ProjectRuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private readonly options: ProjectRuntimeRegistryOptions;

  constructor(options: ProjectRuntimeRegistryOptions = {}) {
    this.options = { ...options };
  }

  /** Number of canonical project runtimes currently cached. */
  get size(): number {
    return this.runtimes.size;
  }

  /**
   * Return the cached runtime for a project, loading a snapshot on first use.
   */
  get(projectDir: string): ProjectRuntime {
    const canonicalProjectDir = requireCanonicalProjectDirectory(projectDir);
    const cached = this.runtimes.get(canonicalProjectDir);
    if (cached) return cached;

    const runtime: ProjectRuntime = Object.freeze({
      projectDir: canonicalProjectDir,
      config: loadConfig({
        projectDir: canonicalProjectDir,
        homeConfigPath: this.options.homeConfigPath,
      }),
      agents: readAgents({
        homeDir: this.options.homeAgentsDir,
        projectDir: path.join(canonicalProjectDir, '.orchid', 'agents'),
      }),
      skills: readSkills({
        homeDir: this.options.homeSkillsDir,
        projectDir: path.join(canonicalProjectDir, '.orchid', 'skills'),
      }),
      personalities: readPersonalities({
        homeDir: this.options.homePersonalitiesDir,
        projectDir: canonicalProjectDir,
      }),
    });

    this.runtimes.set(canonicalProjectDir, runtime);
    return runtime;
  }

  /**
   * Remove one cached project runtime. The next `get` reloads it from disk.
   */
  invalidate(projectDir: string): boolean {
    const canonicalProjectDir = requireCanonicalProjectDirectory(projectDir);
    return this.runtimes.delete(canonicalProjectDir);
  }

  /** Remove every cached project runtime. */
  clear(): void {
    this.runtimes.clear();
  }
}

/**
 * Process catalog of immutable project snapshots. A turn captures one entry at
 * start and never reads mutable workspace globals again.
 */
const projectRuntimeRegistry = new ProjectRuntimeRegistry();

export function getProjectRuntimeRegistry(): ProjectRuntimeRegistry {
  return projectRuntimeRegistry;
}

/** @internal — tests and coordinated definition reloads. */
export function clearProjectRuntimeRegistry(): void {
  projectRuntimeRegistry.clear();
}

/**
 * Restore secret provider credentials into a one-turn copy of a project
 * runtime. Disk-backed project snapshots deliberately omit keychain values;
 * using one of those snapshots directly would send an empty API key to the
 * provider. The cached runtime itself remains secret-free and reusable.
 */
export async function hydrateProjectRuntime(
  runtime: ProjectRuntime,
): Promise<ProjectRuntime> {
  const config = await injectKeychainKeys(runtime.config);
  return Object.freeze({
    ...runtime,
    config,
  });
}
