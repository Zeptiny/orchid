/**
 * Skill registry — loads, merges, and provides access to skill definitions.
 *
 * Skills are loaded from SKILL.md files in subdirectories of:
 *   1. `~/.orchid/skills/`  (home defaults)
 *   2. `.orchid/skills/`    (project overrides)
 *
 * Project skills overlay home skills (same name → project wins).
 *
 * Each skill directory may contain `scripts/`, `references/`, and `assets/`
 * subdirectories whose files are discovered as skill resources.
 *
 * Ported from Python `src/orchid/skills/__init__.py`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Skill, SkillResource } from '../../shared/types/skill';
import {
  parseFrontmatter,
  getString,
} from '../../shared/utils/frontmatter';
import { registerBuiltinTools } from '../tools';
import { HOME_SKILLS_DIR } from '../config/loader';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_FILENAME = 'SKILL.md';

/** File extensions whose content can be parsed for frontmatter descriptions */
const PARSEABLE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.sh',
  '.py',
  '.rb',
  '.js',
  '.ts',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.cfg',
  '.ini',
  '.bash',
  '.zsh',
  '.fish',
]);

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let skillRegistry: Map<string, Skill> = new Map();

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Scan a resource subdirectory (scripts/, references/, assets/) for files
 * and extract frontmatter descriptions from parseable files.
 */
function scanResourceDir(
  skillDir: string,
  dirname: string,
): SkillResource[] {
  const dirPath = path.join(skillDir, dirname);
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return [];
  }

  const resources: SkillResource[] = [];

  function walkDir(currentDir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(currentDir).sort();
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walkDir(fullPath);
        continue;
      }

      if (!stat.isFile()) continue;

      const relPath = `${dirname}/${path.relative(dirPath, fullPath)}`;
      let description = '';

      const ext = path.extname(entry).toLowerCase();
      if (PARSEABLE_EXTENSIONS.has(ext)) {
        try {
          const text = fs.readFileSync(fullPath, 'utf-8');
          const { metadata } = parseFrontmatter(text);
          description = getString(metadata, 'description', '');
        } catch {
          // Skip unreadable or unparseable files
        }
      }

      resources.push({ path: relPath, description });
    }
  }

  walkDir(dirPath);
  return resources;
}

/**
 * Load all skills from a single directory.
 * Each skill lives in a subdirectory containing a SKILL.md file.
 */
function loadSkillsFromDir(skillsDir: string): Map<string, Skill> {
  const skills = new Map<string, Skill>();

  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    return skills;
  }

  const entries = fs.readdirSync(skillsDir).sort();

  for (const entry of entries) {
    const subDir = path.join(skillsDir, entry);
    if (!fs.statSync(subDir).isDirectory()) continue;

    const skillFile = path.join(subDir, SKILL_FILENAME);
    if (!fs.existsSync(skillFile)) continue;

    let content: string;
    try {
      content = fs.readFileSync(skillFile, 'utf-8');
    } catch {
      continue;
    }

    const { metadata, body } = parseFrontmatter(content);

    const name = getString(metadata, 'name', entry);
    const description = getString(metadata, 'description', '');

    // Description is required
    if (!description) continue;

    // Parse requires (list of dependency skill names)
    const requiresRaw = metadata['requires'];
    let requires: string[] = [];
    if (Array.isArray(requiresRaw)) {
      requires = requiresRaw.filter(
        (r): r is string => typeof r === 'string',
      );
    }

    // Scan resource subdirectories
    const scripts = scanResourceDir(subDir, 'scripts');
    const references = scanResourceDir(subDir, 'references');
    const assets = scanResourceDir(subDir, 'assets');

    const skill: Skill = {
      name,
      description,
      requires: Object.freeze(requires),
      resources: Object.freeze([...scripts, ...references, ...assets]),
      location: skillFile,
      content: body,
    };

    skills.set(skill.name, skill);
  }

  return skills;
}

/**
 * Copy default skill directories from the source (bundled defaults) to a
 * target directory, only if the target subdirectory doesn't already exist.
 */
function seedDefaults(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const entries = fs.readdirSync(sourceDir).sort();
  for (const entry of entries) {
    const sourceSubdir = path.join(sourceDir, entry);
    if (!fs.statSync(sourceSubdir).isDirectory()) continue;

    const sourceFile = path.join(sourceSubdir, SKILL_FILENAME);
    if (!fs.existsSync(sourceFile)) continue;

    const targetSubdir = path.join(targetDir, entry);
    const targetFile = path.join(targetSubdir, SKILL_FILENAME);

    if (!fs.existsSync(targetFile)) {
      fs.mkdirSync(targetSubdir, { recursive: true });
      fs.copyFileSync(sourceFile, targetFile);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReadSkillsOptions {
  /** Override home skills directory (default: `~/.orchid/skills/`). */
  homeDir?: string;
  /** Project skills directory (for example `<workspace>/.orchid/skills`). */
  projectDir?: string;
}

/**
 * Read and merge skill definitions without changing process-wide state.
 *
 * Each invocation returns a new map. Project skills overlay home skills.
 */
export function readSkills(
  options?: ReadSkillsOptions,
): Map<string, Skill> {
  const homeDir = options?.homeDir ?? HOME_SKILLS_DIR;

  const homeSkills = loadSkillsFromDir(homeDir);
  const projectSkills = options?.projectDir
    ? loadSkillsFromDir(options.projectDir)
    : new Map<string, Skill>();

  return new Map<string, Skill>([...homeSkills, ...projectSkills]);
}

/**
 * Load all skills by merging home and project skill directories.
 *
 * Merge semantics: home skills loaded first, then project skills overlay
 * (same name → project wins).  After loading, triggers a tool registry
 * reset so tool filtering can be rebuilt with the new skill context.
 *
 * @param options.homeDir  Override home skills directory (default: `~/.orchid/skills/`)
 * @param options.projectDir  Project skills directory (e.g. `<workspace>/.orchid/skills`).
 *   When omitted, only home skills load — never invents process.cwd().
 */
export function loadSkills(
  options?: ReadSkillsOptions,
): Map<string, Skill> {
  const merged = readSkills(options);
  skillRegistry = merged;

  // Rebuild dynamic tool descriptions with the latest skill registry.
  registerBuiltinTools({ skills: merged });

  return merged;
}

/**
 * Get a single skill by name.
 * Returns `undefined` if not found.
 */
export function getSkill(name: string): Skill | undefined {
  return skillRegistry.get(name);
}

/**
 * List all currently loaded skills.
 */
export function listSkills(): Skill[] {
  return Array.from(skillRegistry.values());
}

/**
 * Seed default skill files into the given home directory.
 * Copies bundled defaults if the target skill subdirectory doesn't exist.
 */
export function seedSkillsDir(homeDir: string): void {
  const defaultsDir = path.join(__dirname, 'defaults');
  seedDefaults(defaultsDir, homeDir);
}

/**
 * Reset the skill registry (clear all loaded skills).
 */
export function resetSkillRegistry(): void {
  skillRegistry = new Map();
}
