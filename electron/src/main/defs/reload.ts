/**
 * Reload agent / skill / personality registries after disk mutations.
 *
 * Project definitions invalidate only that project's immutable runtime. Global
 * definitions also refresh the legacy home-only compatibility registries.
 */
import {
  HOME_AGENTS_DIR,
  HOME_PERSONALITIES_DIR,
  HOME_SKILLS_DIR,
} from '../config/loader';
import { loadAgents } from '../agents/registry';
import { loadSkills } from '../skills/registry';
import { loadPersonalities } from '../personality/registry';
import { getProjectRuntimeRegistry } from '../project/runtime';

/**
 * Force-reload definitions for the current workspace (or home-only when unbound).
 */
export function reloadDefinitionRegistries(projectDir: string | null): void {
  if (projectDir) {
    // A project definition only changes this project's next-turn snapshot.
    // Existing turns intentionally retain their captured runtime.
    getProjectRuntimeRegistry().invalidate(projectDir);
  } else {
    // Global definitions are inherited by every project runtime.
    getProjectRuntimeRegistry().clear();
    loadAgents({ homeDir: HOME_AGENTS_DIR });
    loadSkills({ homeDir: HOME_SKILLS_DIR });
    loadPersonalities({ homeDir: HOME_PERSONALITIES_DIR });
  }
}
