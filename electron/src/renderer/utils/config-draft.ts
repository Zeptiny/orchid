import type { Config, RAGConfig } from '../../shared/types/ipc-boundary';
import type { ConfigPatch, ConfigPatchMap } from '../../shared/types/ipc';
import type { ModelSelection } from '../../shared/types/provider';

/** Nested ConfigPatch keys that need specialized merge (not scalar assign). */
type NestedPatchKey = 'rag' | 'tier_models' | 'tier_reasoning_effort' | 'mcp_servers' | 'providers' | 'permissions';

/** Scalar / nullable top-level patch keys applied with simple defined-assign. */
type ScalarPatchKey = Exclude<keyof ConfigPatch, NestedPatchKey>;

/** Merge incremental form updates without dropping earlier nested-map edits. */
export function mergeConfigDraft(
  current: ConfigPatch,
  updates: ConfigPatch,
): ConfigPatch {
  const next: ConfigPatch = { ...current, ...updates };
  if (updates.tier_models !== undefined) {
    next.tier_models = { ...(current.tier_models ?? {}), ...updates.tier_models };
  }
  if (updates.tier_reasoning_effort !== undefined) {
    next.tier_reasoning_effort = { ...(current.tier_reasoning_effort ?? {}), ...updates.tier_reasoning_effort };
  }
  if (updates.mcp_servers !== undefined) {
    next.mcp_servers = updates.mcp_servers;
  }
  if (updates.providers !== undefined) {
    next.providers = updates.providers;
  }
  if (updates.permissions !== undefined) {
    next.permissions = { ...(current.permissions ?? {}), ...updates.permissions };
  }
  if (updates.rag !== undefined) {
    next.rag = { ...(current.rag ?? {}), ...updates.rag };
  }
  return next;
}

/**
 * Compile-time: Config and ConfigPatch must expose the same key set so draft
 * merge cannot silently drop newly added config fields.
 */
type AssertSameKeys<A, B> = Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A> extends never
  ? true
  : never;
const _configPatchKeysAlign: AssertSameKeys<Config, ConfigPatch> = true;
void _configPatchKeysAlign;

/** ConfigPatch keys whose non-null values are numbers (preference form fields). */
export type NumericConfigKey = {
  [K in keyof ConfigPatch]-?: NonNullable<ConfigPatch[K]> extends number ? K : never;
}[keyof ConfigPatch];

/** RAG numeric fields for preference form handlers. */
export type NumericRAGConfigKey = {
  [K in keyof RAGConfig]-?: RAGConfig[K] extends number ? K : never;
}[keyof RAGConfig];

/**
 * Build a single-field numeric ConfigPatch without `as ConfigPatch` at call sites.
 * Computed-key Pick construction requires a localized assertion (TS limitation).
 */
export function configNumberPatch<K extends NumericConfigKey>(
  field: K,
  value: number,
): Pick<ConfigPatch, K> {
  return { [field]: value } as Pick<ConfigPatch, K>;
}

/**
 * Apply a ConfigPatch onto a loaded Config for the settings draft boundary.
 * Scalars assign when defined (including 0 / false / null); nested maps honor
 * null tombstones; rag deep-merges. Key coverage is tied to Config/ConfigPatch.
 */
export function applyConfigDraft(base: Config, draft: ConfigPatch): Config {
  const next: Config = { ...base };

  for (const key of Object.keys(draft) as Array<keyof ConfigPatch>) {
    if (isNestedPatchKey(key)) continue;
    const value = draft[key];
    if (value !== undefined) {
      assignScalar(next, key, value);
    }
  }

  if (draft.rag !== undefined) {
    next.rag = {
      ...base.rag,
      ...draft.rag,
      embedding_api_model:
        draft.rag.embedding_api_model !== undefined
          ? draft.rag.embedding_api_model
          : base.rag.embedding_api_model,
    };
  }

  if (draft.tier_models !== undefined) {
    next.tier_models = applySelectionMap(base.tier_models, draft.tier_models);
  }

  if (draft.tier_reasoning_effort !== undefined) {
    next.tier_reasoning_effort = applyEffortMap(base.tier_reasoning_effort, draft.tier_reasoning_effort);
  }

  if (draft.mcp_servers !== undefined) {
    next.mcp_servers = applyRecordMap(base.mcp_servers, draft.mcp_servers);
  }

  if (draft.providers !== undefined) {
    next.providers = applyRecordMap(base.providers, draft.providers);
  }

  if (draft.permissions !== undefined) {
    next.permissions = applyRecordMap(base.permissions, draft.permissions);
  }

  return next;
}

function isNestedPatchKey(key: keyof ConfigPatch): key is NestedPatchKey {
  return (
    key === 'rag' ||
    key === 'tier_models' ||
    key === 'tier_reasoning_effort' ||
    key === 'mcp_servers' ||
    key === 'providers' ||
    key === 'permissions'
  );
}

function assignScalar<K extends ScalarPatchKey>(
  config: Config,
  key: K,
  // Exclude only undefined (absent patch); null is a real value for nullable fields.
  value: Exclude<ConfigPatch[K], undefined>,
): void {
  // Scalar ConfigPatch fields match Config once optionality is stripped.
  config[key] = value as Config[K];
}

function applySelectionMap(
  base: Record<string, ModelSelection | null>,
  patch: ConfigPatchMap<ModelSelection | null>,
): Record<string, ModelSelection | null> {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      next[key] = null;
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

function applyEffortMap(
  base: Record<string, string | number | null>,
  patch: ConfigPatchMap<string | number | null>,
): Record<string, string | number | null> {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      next[key] = null;
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

function applyRecordMap<V>(
  base: Record<string, V>,
  patch: ConfigPatchMap<V>,
): Record<string, V> {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Parse a number input for config forms.
 * Accepts valid zero when `min` is 0 (e.g. llm_stream_retries, chunk_overlap).
 */
export function parseConfigNumber(
  value: string,
  min: number,
  options?: { integer?: boolean },
): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (options?.integer) {
    // Reject non-integer tokens (e.g. "12.5") even though parseInt would truncate.
    if (!/^-?\d+$/.test(trimmed)) return null;
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num < min) return null;
    return num;
  }
  const num = Number.parseFloat(trimmed);
  if (Number.isNaN(num) || num < min) return null;
  return num;
}
