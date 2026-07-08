/**
 * Config loader — loads, merges, validates, and persists configuration.
 *
 * Merge order:  defaults → ~/.orchid/config.json → .orchid.json → env overrides
 *
 * Atomic writes:  temp file + fsync + rename + chmod 600 + fsync parent dir.
 * Matches Python `config.py` ConfigManager exactly.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configSchema, defaults, type Config } from './schema';
import { mergeLayers, applyEnvOverrides } from './merge';
import { validateConfig } from './validation';

// ---------------------------------------------------------------------------
// Paths — matches Python config.py:15-27
// ---------------------------------------------------------------------------

export const HOME_CONFIG_DIR = path.join(os.homedir(), '.orchid');
export const HOME_CONFIG_PATH = path.join(HOME_CONFIG_DIR, 'config.json');
export const HOME_AGENTS_DIR = path.join(HOME_CONFIG_DIR, 'agents');
export const HOME_SKILLS_DIR = path.join(HOME_CONFIG_DIR, 'skills');
export const HOME_PERSONALITIES_DIR = path.join(HOME_CONFIG_DIR, 'personalities');
export const PROJECT_CONFIG_NAME = '.orchid.json';

// ---------------------------------------------------------------------------
// Options for loadConfig (testable without touching real home dir)
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** Directory to search for `.orchid.json`. Defaults to `process.cwd()`. */
  projectDir?: string;
  /** Override path to home config file. Defaults to `~/.orchid/config.json`. */
  homeConfigPath?: string;
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function loadJson(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Strip `null` values from a dict so they don't shadow dataclass defaults.
 * Matches Python `config.py:154-170`.
 */
function convertFromDict(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null) {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Atomic write with fsync + rename + chmod 600 + fsync parent dir.
 * Matches Python `config.py:475-497`.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);

  const tmp = filePath + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      const json = JSON.stringify(data, null, 2);
      fs.writeSync(fd, json, undefined, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);

    // fsync parent dir to persist the rename
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core loading
// ---------------------------------------------------------------------------

/**
 * Load and merge all config layers, apply env overrides, validate.
 *
 * Merge order: defaults → home config → project config → env overrides.
 *
 * @param options.projectDir  Directory to search for `.orchid.json`. Defaults to cwd.
 * @param options.homeConfigPath  Override path to home config file (for testing).
 */
export function loadConfig(options?: LoadConfigOptions | string): Config {
  const opts: LoadConfigOptions = typeof options === 'string'
    ? { projectDir: options }
    : options ?? {};

  const homePath = opts.homeConfigPath ?? HOME_CONFIG_PATH;
  const projectDir = opts.projectDir ?? process.cwd();

  const defaultCfg = defaults();
  const mergedDict = defaultCfg as unknown as Record<string, unknown>;

  // Layer 1: home config
  const homeRaw = loadJson(homePath);
  const home = convertFromDict(homeRaw);

  // Layer 2: project config
  const projectPath = path.join(projectDir, PROJECT_CONFIG_NAME);
  const projectRaw = loadJson(projectPath);
  const project = convertFromDict(projectRaw);

  // Merge all layers
  const merged = mergeLayers(mergedDict, home, project);

  // Layer 3: env overrides
  applyEnvOverrides(merged);

  // Validate with zod (type checking + basic constraints)
  return configSchema.parse(merged);
}

/**
 * Ensure `~/.orchid/` directory structure exists and seed default config.
 *
 * Creates:
 * - `~/.orchid/config.json` (if missing)
 * - `~/.orchid/agents/` (if missing)
 * - `~/.orchid/skills/` (if missing)
 * - `~/.orchid/personalities/` (if missing)
 *
 * Matches Python `config.py:449-467`.
 */
export function ensureHomeConfig(): void {
  fs.mkdirSync(HOME_CONFIG_DIR, { recursive: true });
  fs.chmodSync(HOME_CONFIG_DIR, 0o700);

  if (!fs.existsSync(HOME_CONFIG_PATH)) {
    const defaultCfg = defaults();
    atomicWriteJson(HOME_CONFIG_PATH, defaultCfg);
  }

  // Seed directories (agents/skills/personalities loading is deferred to U6)
  fs.mkdirSync(HOME_AGENTS_DIR, { recursive: true });
  fs.mkdirSync(HOME_SKILLS_DIR, { recursive: true });
  fs.mkdirSync(HOME_PERSONALITIES_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// ConfigManager singleton
// ---------------------------------------------------------------------------

/**
 * Singleton config manager — mirrors Python `ConfigManager`.
 *
 * Usage:
 * ```ts
 * const cfg = ConfigManager.load();
 * ConfigManager.save();
 * ConfigManager.reset();
 * ```
 */
export class ConfigManager {
  private static _instance: Config | null = null;
  private static _errors: string[] = [];

  /** Return validation errors from the last load. */
  static errors(): string[] {
    return [...ConfigManager._errors];
  }

  /** Load config (cached after first call). Use `reset()` to reload. */
  static load(options?: LoadConfigOptions | string): Config {
    if (ConfigManager._instance !== null) {
      return ConfigManager._instance;
    }

    const cfg = loadConfig(options);
    ConfigManager._errors = validateConfig(cfg);
    ConfigManager._instance = cfg;
    return cfg;
  }

  /** Clear cached config so the next `load()` re-reads from disk. */
  static reset(): void {
    ConfigManager._instance = null;
    ConfigManager._errors = [];
  }

  /**
   * Persist current config to `~/.orchid/config.json` (atomic write).
   * No-op if no config has been loaded.
   */
  static save(): void {
    if (ConfigManager._instance === null) return;
    atomicWriteJson(HOME_CONFIG_PATH, ConfigManager._instance);
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers (match Python module-level functions)
// ---------------------------------------------------------------------------

/** Get the current config (loads if needed). */
export function getConfig(): Config {
  return ConfigManager.load();
}

/** Get the model for a specific tier, falling back to default_model. */
export function getModelForTier(tier: string): string {
  const cfg = getConfig();
  return cfg.tier_models[tier] ?? cfg.default_model;
}
