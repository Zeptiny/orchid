/**
 * Reload agent / skill / personality registries after disk mutations.
 *
 * When a project is bound, re-apply workspace layers (config + agents + skills)
 * and reload personalities with project overlay.
 */
import {
  HOME_AGENTS_DIR,
  HOME_PERSONALITIES_DIR,
  HOME_SKILLS_DIR,
} from '../config/loader';
import { loadAgents } from '../agents/registry';
import { loadSkills } from '../skills/registry';
import { loadPersonalities } from '../personality/registry';
import {
  applyWorkspaceProjectLayers,
  resetLastAppliedProjectDir,
} from '../project/layers';

/**
 * Force-reload definitions for the current workspace (or home-only when unbound).
 */
export function reloadDefinitionRegistries(projectDir: string | null): void {
  if (projectDir) {
    resetLastAppliedProjectDir();
    applyWorkspaceProjectLayers(projectDir, { force: true });
    loadPersonalities({
      homeDir: HOME_PERSONALITIES_DIR,
      projectDir,
    });
  } else {
    loadAgents({ homeDir: HOME_AGENTS_DIR });
    loadSkills({ homeDir: HOME_SKILLS_DIR });
    loadPersonalities({ homeDir: HOME_PERSONALITIES_DIR });
  }
}
