/**
 * Skill types for the Orchid domain.
 *
 * Ported from src/orchid/domain/skill.py.
 */

// ── SkillResource ───────────────────────────────────────────────────────────

export interface SkillResource {
  readonly path: string;
  readonly description: string;
}

// ── Skill ───────────────────────────────────────────────────────────────────

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly requires: readonly string[];
  readonly resources: readonly SkillResource[];
  /** Absolute path to the SKILL.md file (set during loading, not serialized) */
  readonly location?: string;
  /** Body content of the SKILL.md file (set during loading, not serialized) */
  readonly content?: string;
}
