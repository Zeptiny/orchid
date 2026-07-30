import type { Config } from '../../shared/types/ipc-boundary';
import type { ConfigPatch } from '../../shared/types/ipc';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

/**
 * When the draft replaces a whole record map (mcp_servers),
 * mark aliases present in the original but missing from the draft with
 * `null` so config:save deep-merge treats them as deletions.
 *
 * Safe against:
 *  - `original` being null (returns draft unchanged — no tombstones possible)
 *  - `original[key]` being undefined or a non-object (skips that key)
 *  - prototype pollution via __proto__/constructor/prototype aliases
 */
export function withMapDeletionTombstones(
  draft: ConfigPatch,
  original: Config | null,
): ConfigPatch {
  if (!original) return draft;
  const updates: ConfigPatch = { ...draft };

  for (const key of ['mcp_servers'] as const) {
    if (!(key in draft)) continue;
    const next = draft[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) continue;
    const prev = original[key] as Record<string, unknown> | undefined;
    if (!prev || typeof prev !== 'object') continue;
    const withTombstones: { [alias: string]: Record<string, unknown> | null } = {};
    for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
      if (isUnsafeKey(k)) continue;
      withTombstones[k] = v as Record<string, unknown> | null;
    }
    for (const alias of Object.keys(prev)) {
      if (isUnsafeKey(alias)) continue;
      if (!(alias in withTombstones)) {
        withTombstones[alias] = null;
      }
    }
    updates[key] = withTombstones;
  }

  return updates;
}
