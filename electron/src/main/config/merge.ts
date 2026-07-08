/**
 * Config merge — 3-layer deep merge + environment variable overrides.
 *
 * Merge order: defaults → home (~/.orchid/config.json) → project (.orchid.json)
 * Then: ORCHID_ env overrides (cast to correct types).
 *
 * Deep-merge applies to ALL nested dicts (rag, mcp_servers, providers,
 * tier_models) so partial nested configs merge correctly instead of replacing.
 * Scalars and arrays: project overrides home overrides defaults.
 */
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

/**
 * Recursively merge `source` into `target`.
 *
 * - Nested dicts: recursive merge (source keys override matching target keys;
 *   target-only keys are preserved).
 * - Arrays, scalars: source replaces target.
 * - `undefined` values in source are skipped.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined) continue;
    const tgtVal = result[key];
    if (isPlainObject(tgtVal) && isPlainObject(srcVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Deep-merge two provider/server dicts (mcp_servers, providers).
 *
 * For each alias present in either side:
 * - only in home → keep home entry
 * - only in project → take project entry
 * - both are dicts → shallow-merge `{...home, ...project}`, with recursive
 *   merge of a nested `models` sub-dict when both carry one
 * - non-dict on either side → project wins
 *
 * Matches Python `config.py:354-387`.
 */
export function deepMergeProviderDict(
  home: Record<string, unknown>,
  project: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const alias of new Set([...Object.keys(home), ...Object.keys(project)])) {
    if (!(alias in project)) {
      result[alias] = home[alias];
      continue;
    }
    if (!(alias in home)) {
      result[alias] = project[alias];
      continue;
    }
    const homeEntry = home[alias];
    const projectEntry = project[alias];
    if (!isPlainObject(homeEntry) || !isPlainObject(projectEntry)) {
      result[alias] = projectEntry;
      continue;
    }
    const merged: Record<string, unknown> = { ...homeEntry, ...projectEntry };
    const homeModels = homeEntry['models'];
    const projectModels = projectEntry['models'];
    if (isPlainObject(homeModels) && isPlainObject(projectModels)) {
      merged['models'] = { ...homeModels, ...projectModels };
    }
    result[alias] = merged;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 3-layer merge
// ---------------------------------------------------------------------------

/** Keys that use recursive per-alias merge instead of wholesale replacement. */
const DEEP_MERGE_KEYS = new Set(['mcp_servers', 'providers']);

/**
 * Merge defaults, home config, and project config into a single flat dict.
 *
 * For nested dicts (rag, tier_models, etc.) the merge is recursive so that
 * a project config specifying only `rag.top_k` doesn't wipe out the other
 * rag fields from home/defaults.
 *
 * For `mcp_servers` and `providers` the merge uses the specialised
 * `deepMergeProviderDict` which handles per-alias entry merging including
 * a nested `models` sub-dict.
 */
export function mergeLayers(
  defaults: Record<string, unknown>,
  home: Record<string, unknown>,
  project: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...defaults };

  // Apply home overrides
  for (const key of Object.keys(home)) {
    if (!(key in merged)) continue;
    const homeVal = home[key];
    const mergedVal = merged[key];

    if (DEEP_MERGE_KEYS.has(key) && isPlainObject(homeVal) && isPlainObject(mergedVal)) {
      merged[key] = deepMergeProviderDict(
        mergedVal as Record<string, unknown>,
        homeVal as Record<string, unknown>,
      );
    } else if (isPlainObject(homeVal) && isPlainObject(mergedVal)) {
      // Deep-merge nested dicts (rag, tier_models, etc.) so partial nested
      // configs merge correctly instead of replacing wholesale.
      merged[key] = deepMerge(
        mergedVal as Record<string, unknown>,
        homeVal as Record<string, unknown>,
      );
    } else {
      merged[key] = homeVal;
    }
  }

  // Apply project overrides (same logic)
  for (const key of Object.keys(project)) {
    if (!(key in merged)) continue;
    const projVal = project[key];
    const mergedVal = merged[key];

    if (DEEP_MERGE_KEYS.has(key) && isPlainObject(projVal) && isPlainObject(mergedVal)) {
      merged[key] = deepMergeProviderDict(
        mergedVal as Record<string, unknown>,
        projVal as Record<string, unknown>,
      );
    } else if (isPlainObject(projVal) && isPlainObject(mergedVal)) {
      merged[key] = deepMerge(
        mergedVal as Record<string, unknown>,
        projVal as Record<string, unknown>,
      );
    } else {
      merged[key] = projVal;
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Environment variable overrides
// ---------------------------------------------------------------------------

interface EnvMapping {
  envKey: string;
  configPath: string[];
  type: 'string' | 'int' | 'float' | 'list';
}

/** Top-level env mappings — matches Python `config.py:119-134`. */
const ENV_MAP: EnvMapping[] = [
  { envKey: 'ORCHID_DEFAULT_MODEL', configPath: ['default_model'], type: 'string' },
  { envKey: 'ORCHID_IGNORED_DIRS', configPath: ['ignored_dirs'], type: 'list' },
  { envKey: 'ORCHID_COMMAND_TIMEOUT', configPath: ['command_timeout'], type: 'int' },
  { envKey: 'ORCHID_READ_LINE_LIMIT', configPath: ['read_line_limit'], type: 'int' },
  { envKey: 'ORCHID_GREP_MAX_RESULTS', configPath: ['grep_max_results'], type: 'int' },
  { envKey: 'ORCHID_DIRECTORY_TREE_DEPTH', configPath: ['directory_tree_depth'], type: 'int' },
  { envKey: 'ORCHID_THEME', configPath: ['theme'], type: 'string' },
  { envKey: 'ORCHID_PERSONALITY', configPath: ['personality'], type: 'string' },
  { envKey: 'ORCHID_AST_MAX_FILE_SIZE', configPath: ['ast_max_file_size'], type: 'int' },
  { envKey: 'ORCHID_LLM_STREAM_IDLE_TIMEOUT', configPath: ['llm_stream_idle_timeout'], type: 'float' },
  { envKey: 'ORCHID_LLM_STREAM_RETRIES', configPath: ['llm_stream_retries'], type: 'int' },
  { envKey: 'ORCHID_MCP_STARTUP_TIMEOUT', configPath: ['mcp_startup_timeout'], type: 'float' },
  { envKey: 'ORCHID_MCP_PER_SERVER_TIMEOUT', configPath: ['mcp_per_server_timeout'], type: 'float' },
  { envKey: 'ORCHID_BG_CMD_IDLE_TIMEOUT', configPath: ['background_command_idle_timeout'], type: 'float' },
];

/** Nested RAG env mappings — matches Python `config.py:136-142`. */
const RAG_ENV_MAP: EnvMapping[] = [
  { envKey: 'ORCHID_RAG_CHUNK_SIZE', configPath: ['rag', 'chunk_size'], type: 'int' },
  { envKey: 'ORCHID_RAG_CHUNK_OVERLAP', configPath: ['rag', 'chunk_overlap'], type: 'int' },
  { envKey: 'ORCHID_RAG_TOP_K', configPath: ['rag', 'top_k'], type: 'int' },
  { envKey: 'ORCHID_RAG_MAX_FILE_SIZE', configPath: ['rag', 'max_file_size'], type: 'int' },
  { envKey: 'ORCHID_RAG_EMBEDDING_MODEL', configPath: ['rag', 'embedding_model'], type: 'string' },
];

/** Cast a string env value to the target type. */
function castValue(value: string, type: EnvMapping['type']): unknown {
  switch (type) {
    case 'int':
      return parseInt(value, 10);
    case 'float':
      return parseFloat(value);
    case 'list':
      return value.split(',').map((s) => s.trim());
    case 'string':
    default:
      return value;
  }
}

/** Set a value at a nested path in an object (mutates `obj`). */
function setAtPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    if (!isPlainObject(current[segment])) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}

/**
 * Apply `ORCHID_`-prefixed environment variable overrides to a merged config.
 *
 * Mutates and returns the same object.
 */
export function applyEnvOverrides(cfg: Record<string, unknown>): Record<string, unknown> {
  for (const mapping of [...ENV_MAP, ...RAG_ENV_MAP]) {
    const raw = process.env[mapping.envKey];
    if (raw !== undefined && raw !== '') {
      setAtPath(cfg, mapping.configPath, castValue(raw, mapping.type));
    }
  }
  return cfg;
}
