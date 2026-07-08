/**
 * Skill types for the Orchid domain.
 *
 * Ported from src/orchid/domain/skill.py.
 */

import { z } from 'zod';

// ── SkillResource ───────────────────────────────────────────────────────────

export interface SkillResource {
  readonly path: string;
  readonly description: string;
}

export const skillResourceSchema = z.object({
  path: z.string(),
  description: z.string().default(''),
});

// ── Skill ───────────────────────────────────────────────────────────────────

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly requires: readonly string[];
  readonly resources: readonly SkillResource[];
}

export const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  requires: z.array(z.string()).default([]),
  resources: z.array(skillResourceSchema).default([]),
});

// ── Storage dict ────────────────────────────────────────────────────────────

export interface SkillStorageDict {
  name: string;
  description: string;
  requires?: string[];
  resources?: Array<{ path: string; description?: string }>;
  [key: string]: unknown;
}

// ── Serialization ───────────────────────────────────────────────────────────

export function skillToStorageDict(skill: Skill): SkillStorageDict {
  const d: SkillStorageDict = {
    name: skill.name,
    description: skill.description,
  };
  if (skill.requires.length) {
    d.requires = [...skill.requires];
  }
  if (skill.resources.length) {
    d.resources = skill.resources.map((r) => ({
      path: r.path,
      description: r.description,
    }));
  }
  return d;
}

export function skillFromStorageDict(data: unknown): Skill {
  const raw = data as Record<string, unknown>;

  const resources: SkillResource[] = [];
  if (Array.isArray(raw.resources)) {
    for (const r of raw.resources) {
      if (r && typeof r === 'object' && 'path' in r) {
        resources.push({
          path: (r as Record<string, unknown>).path as string,
          description:
            typeof (r as Record<string, unknown>).description === 'string'
              ? (r as Record<string, unknown>).description as string
              : '',
        });
      }
    }
  }

  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    requires: Array.isArray(raw.requires)
      ? (raw.requires as unknown[]).filter((r): r is string => typeof r === 'string')
      : [],
    resources,
  };
}
