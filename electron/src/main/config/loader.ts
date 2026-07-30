/**
 * Config loader — loads, merges, validates, and persists configuration.
 *
 * Merge order:  defaults → ~/.orchid/config.json → .orchid.json → env overrides
 *
 * Atomic writes:  temp file + fsync + rename + chmod 600 + fsync parent dir.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ModelSelection } from '../../shared/types/provider';
import { configSchema, defaults, type Config } from './schema';
import { mergeLayers, applyEnvOverrides, isPlainObject } from './merge';
import { validateConfig } from './validation';
import { safeFsync } from '../utils/safe-fsync';

// ---------------------------------------------------------------------------
// Paths
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
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Atomic write with fsync + rename + chmod 600 + fsync parent dir.
 */
export function atomicWriteJson(
  filePath: string,
  data: unknown,
  options: { hardenDirectory?: boolean } = {},
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (options.hardenDirectory !== false) fs.chmodSync(dir, 0o700);

  const openExclusiveTemp = (): { fd: number; path: string } => {
    const baseFlags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const tmpPath = path.join(
        dir,
        `.${path.basename(filePath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
      );
      try {
        return { fd: fs.openSync(tmpPath, baseFlags | noFollow, 0o600), path: tmpPath };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue;
        if (noFollow !== 0 && (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP')) {
          try {
            return { fd: fs.openSync(tmpPath, baseFlags, 0o600), path: tmpPath };
          } catch (fallbackError) {
            if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw fallbackError;
          }
        }
        throw error;
      }
    }
    throw new Error(`Could not create an exclusive temporary file for ${filePath}`);
  };

  let tmp: string | null = null;
  try {
    const opened = openExclusiveTemp();
    const fd = opened.fd;
    tmp = opened.path;
    try {
      if (!fs.fstatSync(fd).isFile()) {
        throw new Error(`Temporary configuration target is not a regular file: ${tmp}`);
      }
      const json = JSON.stringify(data, null, 2);
      fs.writeSync(fd, json, undefined, 'utf-8');
      safeFsync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    tmp = null;
    fs.chmodSync(filePath, 0o600);

    // fsync parent dir to persist the rename
    const dirFd = fs.openSync(dir, 'r');
    try {
      safeFsync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (err) {
    if (tmp != null) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore cleanup error
      }
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

  const home = loadJson(homePath);

  const projectPath = path.join(projectDir, PROJECT_CONFIG_NAME);
  const project = loadJson(projectPath);

  const merged = mergeLayers(mergedDict, home, project);

  applyEnvOverrides(merged);

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
 */
export function ensureHomeConfig(): void {
  fs.mkdirSync(HOME_CONFIG_DIR, { recursive: true });
  fs.chmodSync(HOME_CONFIG_DIR, 0o700);

  if (!fs.existsSync(HOME_CONFIG_PATH)) {
    const defaultCfg = defaults();
    atomicWriteJson(HOME_CONFIG_PATH, defaultCfg);
  }

  // Seed directory structure (agents/skills/personalities content seeded at startup)
  fs.mkdirSync(HOME_AGENTS_DIR, { recursive: true });
  fs.mkdirSync(HOME_SKILLS_DIR, { recursive: true });
  fs.mkdirSync(HOME_PERSONALITIES_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// ConfigManager singleton
// ---------------------------------------------------------------------------

/**
 * Singleton config manager.
 *
 * Usage:
 * ```ts
 * const cfg = ConfigManager.load();
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

    const loaded = loadConfig(options);
    ConfigManager._errors = validateConfig(loaded);
    ConfigManager._instance = loaded;
    return loaded;
  }

  /** Clear cached config so the next `load()` re-reads from disk. */
  static reset(): void {
    ConfigManager._instance = null;
    ConfigManager._errors = [];
  }

}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Get the current config (loads if needed). */
export function getConfig(): Config {
  return ConfigManager.load();
}

/**
 * Read a typed selection from one already-frozen config snapshot.
 *
 * This deliberately chooses only among connection-scoped selections that are
 * already present in the supplied config. It does not parse legacy aliases,
 * discover providers, or construct a transport.
 */
export function getTierModelSelection(
  config: Pick<Config, 'tier_models' | 'default_model'>,
  tier: string,
): ModelSelection | null {
  return config.tier_models[tier] ?? config.default_model;
}
