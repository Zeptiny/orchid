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
import { randomBytes } from 'node:crypto';
import type { ModelSelection } from '../../shared/types/provider';
import type { ConfigDiagnostic } from '../../shared/types/ipc-boundary';
import { configSchema, defaults, type Config } from './schema';
import { mergeLayers, applyEnvOverrides, isPlainObject } from './merge';
import { validateConfig } from './validation';
import { safeFsync } from '../utils/safe-fsync';

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

const LEGACY_PROVIDER_CONFIG_RESET_DIAGNOSTIC: ConfigDiagnostic = {
  code: 'legacy-provider-config-reset',
  message: 'Legacy provider configuration was ignored. Choose a provider connection and model to enable LLM features.',
};

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
 * Remove development-era provider state before it can reach the executable
 * config. String alias/model values are not transformed into a connection:
 * they are discarded, while unrelated preferences remain intact.
 */
function sanitizeConfigLayer(data: Record<string, unknown>): {
  config: Record<string, unknown>;
  resetLegacyProviderState: boolean;
} {
  const result: Record<string, unknown> = {};
  let resetLegacyProviderState = false;

  for (const [k, v] of Object.entries(data)) {
    if (k === 'providers') {
      // An empty map is the new IPC compatibility shape, not legacy state.
      if (v !== null && (!isPlainObject(v) || Object.keys(v).length > 0)) {
        resetLegacyProviderState = true;
      }
      continue;
    }

    if (k === 'default_model' && typeof v === 'string') {
      resetLegacyProviderState = true;
      continue;
    }

    if (k === 'tier_models') {
      if (typeof v === 'string') {
        resetLegacyProviderState = true;
        continue;
      }
      if (isPlainObject(v)) {
        const tiers: Record<string, unknown> = {};
        for (const [tier, selection] of Object.entries(v)) {
          if (typeof selection === 'string') {
            resetLegacyProviderState = true;
            continue;
          }
          tiers[tier] = selection;
        }
        result[k] = tiers;
        continue;
      }
    }

    if (k === 'rag' && isPlainObject(v)) {
      const rag = { ...v };
      // Legacy API embedding aliases relied on the retired provider alias
      // resolver. Typed connection-scoped selections are retained for U4;
      // string aliases are reset to local ONNX rather than inferred.
      if (typeof rag.embedding_api_model === 'string') {
        delete rag.embedding_api_model;
        resetLegacyProviderState = true;
      }
      result[k] = rag;
      continue;
    }

    // Preserve an explicit nullable default selection; retain the prior
    // behavior for nulls in unrelated config fields.
    if (v === null && k !== 'default_model') {
      continue;
    }
    result[k] = v;
  }

  return { config: result, resetLegacyProviderState };
}

/**
 * Atomic write with fsync + rename + chmod 600 + fsync parent dir.
 * Matches Python `config.py:475-497`.
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
function loadConfigWithDiagnostics(options?: LoadConfigOptions | string): {
  config: Config;
  diagnostics: ConfigDiagnostic[];
} {
  const opts: LoadConfigOptions = typeof options === 'string'
    ? { projectDir: options }
    : options ?? {};

  const homePath = opts.homeConfigPath ?? HOME_CONFIG_PATH;
  const projectDir = opts.projectDir ?? process.cwd();

  const defaultCfg = defaults();
  const mergedDict = defaultCfg as unknown as Record<string, unknown>;

  // Layer 1: home config
  const homeExists = fs.existsSync(homePath);
  const homeRaw = loadJson(homePath);
  const home = sanitizeConfigLayer(homeRaw);
  // Upgrade: existing installs without the flag are treated as completed so
  // multi-step onboarding does not re-open after schema introduction.
  if (homeExists && !Object.prototype.hasOwnProperty.call(homeRaw, 'has_completed_onboarding')) {
    home.config.has_completed_onboarding = true;
  }

  // Layer 2: project config
  const projectPath = path.join(projectDir, PROJECT_CONFIG_NAME);
  const project = sanitizeConfigLayer(loadJson(projectPath));

  // Merge all layers
  const merged = mergeLayers(mergedDict, home.config, project.config);

  // Layer 3: env overrides
  applyEnvOverrides(merged);

  // Validate with zod (type checking + basic constraints)
  return {
    config: configSchema.parse(merged),
    diagnostics: home.resetLegacyProviderState || project.resetLegacyProviderState
      ? [{ ...LEGACY_PROVIDER_CONFIG_RESET_DIAGNOSTIC }]
      : [],
  };
}

export function loadConfig(options?: LoadConfigOptions | string): Config {
  return loadConfigWithDiagnostics(options).config;
}

/** Read non-secret legacy-reset notices for a specific config layer set. */
export function getConfigDiagnostics(
  options?: LoadConfigOptions | string,
): ConfigDiagnostic[] {
  return loadConfigWithDiagnostics(options).diagnostics;
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

  // Seed directory structure (agents/skills/personalities content seeded at startup)
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
 * ConfigManager.reset();
 * ```
 */
export class ConfigManager {
  private static _instance: Config | null = null;
  private static _errors: string[] = [];
  private static _diagnostics: ConfigDiagnostic[] = [];

  /** Return validation errors from the last load. */
  static errors(): string[] {
    return [...ConfigManager._errors];
  }

  /** Return non-secret load/reset notices from the current config lifecycle. */
  static diagnostics(): ConfigDiagnostic[] {
    return ConfigManager._diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  /** Load config (cached after first call). Use `reset()` to reload. */
  static load(options?: LoadConfigOptions | string): Config {
    if (ConfigManager._instance !== null) {
      return ConfigManager._instance;
    }

    const loaded = loadConfigWithDiagnostics(options);
    ConfigManager._errors = validateConfig(loaded.config);
    ConfigManager._diagnostics = loaded.diagnostics;
    ConfigManager._instance = loaded.config;
    return loaded.config;
  }

  /** Clear cached config so the next `load()` re-reads from disk. */
  static reset(): void {
    ConfigManager._instance = null;
    ConfigManager._errors = [];
    ConfigManager._diagnostics = [];
  }

}

// ---------------------------------------------------------------------------
// Convenience helpers (match Python module-level functions)
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
