/**
 * Config merge — 3-layer deep merge + environment variable overrides.
 *
 * Merge order: defaults → home (~/.orchid/config.json) → project (.orchid.json)
 * Then: ORCHID_ env overrides (cast to correct types).
 *
 * Deep-merge applies to nested preference dictionaries (rag, mcp_servers,
 * tier_models) so partial nested configs merge correctly instead of replacing.
 * Provider connections are intentionally not part of layered config.
 * Scalars and arrays: project overrides home overrides defaults.
 */
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Keys that can pollute Object.prototype if used as property names. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Return true if the key is a prototype-pollution vector. */
export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
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
 * - `null` values in source delete the key (tombstone for PATCH-style removes).
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (isUnsafeKey(key)) continue;
    const srcVal = source[key];
    if (srcVal === undefined) continue;
    if (srcVal === null) {
      delete result[key];
      continue;
    }
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
 * Deep-merge two named-entry dictionaries (currently MCP servers).
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
    if (isUnsafeKey(alias)) continue;
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
const DEEP_MERGE_KEYS = new Set(['mcp_servers']);

/** Legacy provider config is not a source of executable connection state. */
const IGNORED_LEGACY_CONFIG_KEYS = new Set(['providers']);

/**
 * Top-level keys whose values are required objects (maps or nested configs).
 * Null tombstones are blocked for these keys so a partial update cannot remove
 * an entire required preference map.
 */
const TOP_LEVEL_OBJECT_KEYS = new Set([
  'mcp_servers',
  'rag',
  'tier_models',
]);

/**
 * Merge tier selections by tier while keeping each selection atomic. A
 * selection's connectionId and modelId must never be composed from different
 * config layers, and `null` is a meaningful "use default / no selection"
 * value rather than a deletion tombstone.
 */
function mergeTierSelections(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...current };
  for (const tier of Object.keys(updates)) {
    if (isUnsafeKey(tier)) continue;
    const value = updates[tier];
    if (value !== undefined) {
      result[tier] = value;
    }
  }
  return result;
}

/**
 * Merge partial `updates` into a full config for `config:save`.
 *
 * Same nested semantics as {@link mergeLayers}:
 * - `mcp_servers`: per-alias merge via {@link deepMergeProviderDict}
 * - `tier_models`: per-tier merge with atomic typed selections
 * - other nested plain objects (`rag`, …): {@link deepMerge}
 * - scalars / arrays: source replaces target
 * - `null` values act as tombstones (delete the key) so clients can remove
 *   provider/MCP aliases under PATCH-style deep merge
 *
 * This avoids the shallow `{ ...current, ...updates }` bug where a partial
 * `rag` object replaced the entire nested map and zod defaults
 * wiped sibling fields.
 */
export function mergeConfigUpdates(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...current, providers: {} };

  for (const key of Object.keys(updates)) {
    if (isUnsafeKey(key)) continue;
    if (IGNORED_LEGACY_CONFIG_KEYS.has(key)) continue;
    const srcVal = updates[key];
    if (srcVal === undefined) continue;

    // A nullable typed selection is not a PATCH tombstone. It must replace
    // the selection atomically so fields cannot mix across connections.
    if (key === 'default_model') {
      result[key] = srcVal;
      continue;
    }

    // Tombstone: explicit null removes a top-level key.
    // Block deletion for required object keys (mcp_servers, rag, tier_models)
    // to prevent wiping the entire map — alias-level nulls inside MCP maps are
    // handled separately below.
    if (srcVal === null) {
      if (TOP_LEVEL_OBJECT_KEYS.has(key)) continue;
      delete result[key];
      continue;
    }

    const tgtVal = result[key];

    if (DEEP_MERGE_KEYS.has(key) && isPlainObject(tgtVal) && isPlainObject(srcVal)) {
      // Per-alias merge, then apply null tombstones for deleted aliases.
      const merged = deepMergeProviderDict(
        tgtVal as Record<string, unknown>,
        // Strip nulls before provider merge (non-dict values would replace)
        stripNullEntries(srcVal as Record<string, unknown>),
      );
      for (const [alias, val] of Object.entries(srcVal as Record<string, unknown>)) {
        if (val === null) {
          delete merged[alias];
        }
      }
      result[key] = merged;
    } else if (key === 'tier_models' && isPlainObject(tgtVal) && isPlainObject(srcVal)) {
      result[key] = mergeTierSelections(tgtVal, srcVal);
    } else if (isPlainObject(tgtVal) && isPlainObject(srcVal)) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key] = srcVal;
    }
  }

  return result;
}

/** Drop null-valued entries so they are not treated as provider dicts. */
function stripNullEntries(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isUnsafeKey(k)) continue;
    if (v !== null) out[k] = v;
  }
  return out;
}

/**
 * Merge defaults, home config, and project config into a single flat dict.
 *
 * For nested dicts (rag, tier_models, etc.) the merge is recursive so that
 * a project config specifying only `rag.top_k` doesn't wipe out the other
 * rag fields from home/defaults.
 *
 * `mcp_servers` uses the specialised `deepMergeProviderDict`; typed model
 * selections stay atomic while `tier_models` still merges by tier.
 */
export function mergeLayers(
  defaults: Record<string, unknown>,
  home: Record<string, unknown>,
  project: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...defaults };
  if ('providers' in merged) {
    merged['providers'] = {};
  }

  applyLayerOverrides(merged, home);
  applyLayerOverrides(merged, project);

  return merged;
}

function applyLayerOverrides(
  merged: Record<string, unknown>,
  layer: Record<string, unknown>,
): void {
  for (const key of Object.keys(layer)) {
    if (isUnsafeKey(key)) continue;
    if (IGNORED_LEGACY_CONFIG_KEYS.has(key)) continue;
    if (!(key in merged)) continue;
    const layerVal = layer[key];
    const mergedVal = merged[key];

    if (key === 'default_model') {
      merged[key] = layerVal;
    } else if (DEEP_MERGE_KEYS.has(key) && isPlainObject(layerVal) && isPlainObject(mergedVal)) {
      merged[key] = deepMergeProviderDict(
        mergedVal as Record<string, unknown>,
        layerVal as Record<string, unknown>,
      );
    } else if (key === 'tier_models' && isPlainObject(layerVal) && isPlainObject(mergedVal)) {
      merged[key] = mergeTierSelections(mergedVal as Record<string, unknown>, layerVal);
    } else if (isPlainObject(layerVal) && isPlainObject(mergedVal)) {
      // Deep-merge nested dicts (rag, tier_models, etc.) so partial nested
      // configs merge correctly instead of replacing wholesale.
      merged[key] = deepMerge(
        mergedVal as Record<string, unknown>,
        layerVal as Record<string, unknown>,
      );
    } else {
      merged[key] = layerVal;
    }
  }
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
  // ORCHID_DEFAULT_MODEL was an alias/model string. It deliberately has no
  // replacement: environment variables cannot construct a connection-scoped
  // executable selection.
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
  { envKey: 'ORCHID_MAX_TOOL_STEPS', configPath: ['max_tool_steps'], type: 'int' },
];

/** Nested RAG env mappings — matches Python `config.py:136-142`. */
const RAG_ENV_MAP: EnvMapping[] = [
  { envKey: 'ORCHID_RAG_CHUNK_SIZE', configPath: ['rag', 'chunk_size'], type: 'int' },
  { envKey: 'ORCHID_RAG_CHUNK_OVERLAP', configPath: ['rag', 'chunk_overlap'], type: 'int' },
  { envKey: 'ORCHID_RAG_TOP_K', configPath: ['rag', 'top_k'], type: 'int' },
  { envKey: 'ORCHID_RAG_MAX_FILE_SIZE', configPath: ['rag', 'max_file_size'], type: 'int' },
  { envKey: 'ORCHID_RAG_EMBEDDING_MODEL', configPath: ['rag', 'embedding_model'], type: 'string' },
  { envKey: 'ORCHID_RAG_EMBEDDING_THREADS', configPath: ['rag', 'embedding_threads'], type: 'int' },
  { envKey: 'ORCHID_RAG_EMBEDDING_BATCH_SIZE', configPath: ['rag', 'embedding_batch_size'], type: 'int' },
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
