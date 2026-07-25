/**
 * Personality registry — loads, seeds, and provides access to personality prompts.
 *
 * Personalities are plain markdown files in `~/.orchid/personalities/*.md`.
 * Bundled defaults are seeded into that directory on first run (files not
 * overwritten if they already exist).
 *
 * Ported from Python `src/orchid/personality/__init__.py`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOME_PERSONALITIES_DIR } from '../config/loader';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** name → markdown body */
let personalityRegistry: Map<string, string> = new Map();

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Copy default personality `.md` files into the home personalities directory.
 * Existing files are left untouched (matches Python `_seed_personalities_dir`).
 */
function seedDefaults(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const entries = fs.readdirSync(sourceDir).sort();
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    const sourceFile = path.join(sourceDir, entry);
    if (!fs.statSync(sourceFile).isFile()) continue;

    const targetFile = path.join(targetDir, entry);
    if (!fs.existsSync(targetFile)) {
      fs.copyFileSync(sourceFile, targetFile);
    }
  }
}

/**
 * Load all `*.md` personalities from a directory into a map.
 */
function loadFromDir(dir: string): Map<string, string> {
  const result = new Map<string, string>();

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return result;
  }

  const entries = fs.readdirSync(dir).sort();
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    const fullPath = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf-8').trim();
      if (content) {
        result.set(path.basename(entry, '.md'), content);
      }
    } catch (err) {
      console.warn(`Skipping personality ${fullPath}:`, err);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReadPersonalitiesOptions {
  /** Override home personalities directory. */
  homeDir?: string;
  /** Project root whose `.orchid/personalities/` directory is overlaid. */
  projectDir?: string;
}

/**
 * Read and merge personalities without seeding files or changing globals.
 *
 * Each invocation returns a new map. Project personalities overlay home
 * personalities with the same name.
 */
export function readPersonalities(
  options?: ReadPersonalitiesOptions,
): Map<string, string> {
  const homeDir = options?.homeDir ?? HOME_PERSONALITIES_DIR;
  const home = loadFromDir(homeDir);
  if (!options?.projectDir) {
    return home;
  }

  const project = loadFromDir(
    path.join(options.projectDir, '.orchid', 'personalities'),
  );
  return new Map([...home, ...project]);
}

/**
 * Seed default personality files into the given home directory.
 * Copies bundled defaults if the target file doesn't already exist.
 */
export function seedPersonalitiesDir(homeDir: string = HOME_PERSONALITIES_DIR): void {
  const defaultsDir = path.join(__dirname, 'defaults');
  seedDefaults(defaultsDir, homeDir);
}

/**
 * Load personalities from `~/.orchid/personalities/` (or override).
 * Seeds defaults first so a fresh install always has the built-in set.
 *
 * When `projectDir` is set, also loads `<projectDir>/.orchid/personalities/`
 * and overlays project files on top of home (same name → project wins).
 *
 * @param options.homeDir  Override personalities directory
 * @param options.projectDir  Project root (not the personalities subdir)
 */
export function loadPersonalities(
  options?: ReadPersonalitiesOptions,
): Map<string, string> {
  const homeDir = options?.homeDir ?? HOME_PERSONALITIES_DIR;

  // Ensure defaults are present before loading
  if (homeDir === HOME_PERSONALITIES_DIR) {
    seedPersonalitiesDir(homeDir);
  }

  personalityRegistry = readPersonalities({ homeDir, projectDir: options?.projectDir });
  return personalityRegistry;
}

/**
 * List all currently loaded personality names (sorted).
 */
export function listPersonalityNames(): string[] {
  return Array.from(personalityRegistry.keys()).sort();
}
