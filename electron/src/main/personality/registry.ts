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
import { HOME_PERSONALITIES_DIR, getConfig } from '../config/loader';

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
 * @param options.homeDir  Override personalities directory
 */
export function loadPersonalities(options?: {
  homeDir?: string;
}): Map<string, string> {
  const homeDir = options?.homeDir ?? HOME_PERSONALITIES_DIR;

  // Ensure defaults are present before loading
  if (homeDir === HOME_PERSONALITIES_DIR) {
    seedPersonalitiesDir(homeDir);
  }

  personalityRegistry = loadFromDir(homeDir);
  return personalityRegistry;
}

/**
 * Get the markdown body for a personality by name.
 * Returns `undefined` if not found.
 */
export function getPersonality(name: string): string | undefined {
  return personalityRegistry.get(name);
}

/**
 * List all currently loaded personality names (sorted).
 */
export function listPersonalityNames(): string[] {
  return Array.from(personalityRegistry.keys()).sort();
}

/**
 * List all currently loaded personalities as `{ name, content }` pairs.
 */
export function listPersonalities(): Array<{ name: string; content: string }> {
  return listPersonalityNames().map((name) => ({
    name,
    content: personalityRegistry.get(name) ?? '',
  }));
}

/**
 * Append the selected personality to the end of an agent system prompt.
 * Matches Python `append_personality`.
 *
 * If the configured personality is unknown, returns the prompt unchanged.
 * Lazy-reloads from disk once if the name is missing (covers files added after startup).
 */
export function appendPersonality(agentSystemPrompt: string, personalityName?: string): string {
  const name = personalityName ?? getConfig().personality;
  let personalityText = personalityRegistry.get(name);
  if (!personalityText) {
    loadPersonalities();
    personalityText = personalityRegistry.get(name);
  }
  if (!personalityText) {
    return agentSystemPrompt;
  }
  return `${agentSystemPrompt}\n\n## Personality\n\n${personalityText}\n`;
}

/**
 * Reset the personality registry (clear all loaded personalities).
 */
export function resetPersonalityRegistry(): void {
  personalityRegistry = new Map();
}
