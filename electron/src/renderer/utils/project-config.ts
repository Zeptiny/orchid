/**
 * Pure helpers for the project-scoped configuration editor
 * (ProjectConfigView). Extracted so the override read/coerce/tombstone logic
 * is unit-testable without mounting the component.
 */
import type { Config, RAGConfig } from '../../shared/types/ipc-boundary';
import { deepEqual } from './config-save';

/** Type guard for a non-null, non-array plain object. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export { deepEqual };

/** Read a stored project override by field key, resolving `rag.*`, `agents_md.*` and `compaction.*` into nested maps. */
export function readStoredOverride(overrides: Record<string, unknown>, key: string): unknown {
  if (key === 'compaction') {
    return overrides['compaction'];
  }
  if (key.startsWith('compaction.')) {
    const parts = key.slice('compaction.'.length).split('.');
    let cur: unknown = overrides['compaction'];
    for (const part of parts) {
      if (!isPlainRecord(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }
  if (key.startsWith('rag.')) {
    const rag = overrides['rag'];
    return isPlainRecord(rag) ? rag[key.slice(4)] : undefined;
  }
  if (key.startsWith('agents_md.')) {
    const agentsMd = overrides['agents_md'];
    return isPlainRecord(agentsMd) ? agentsMd[key.slice('agents_md.'.length)] : undefined;
  }
  return overrides[key];
}

/** Read a value from the global (home) config by field key, resolving `rag.*`, `agents_md.*` and `compaction.*` into nested maps. */
export function readGlobalValue(config: Config | null, key: string): unknown {
  if (!config) return undefined;
  if (key === 'compaction') {
    return (config as unknown as Record<string, unknown>)['compaction'];
  }
  if (key.startsWith('compaction.')) {
    const parts = key.slice('compaction.'.length).split('.');
    let cur: unknown = (config as unknown as Record<string, unknown>)['compaction'];
    for (const part of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }
  if (key.startsWith('rag.')) {
    return config.rag[key.slice(4) as keyof RAGConfig];
  }
  if (key.startsWith('agents_md.')) {
    const agentsMd = (config as unknown as Record<string, unknown>)['agents_md'];
    return isPlainRecord(agentsMd)
      ? agentsMd[key.slice('agents_md.'.length)]
      : undefined;
  }
  return config[key as keyof Config];
}

/** Coerce a config value into an editable form input value (arrays become comma-separated). */
export function toInputValue(value: unknown): string | number {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

/** Derive a stable, DOM-safe input element id from a config field key. */
export function fieldInputId(key: string): string {
  return `project-config-${key.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

/** Coerce a raw config value into a `Record<string, Record<string, unknown>>`. */
export function toServerMap(value: unknown): Record<string, Record<string, unknown>> {
  if (!isPlainRecord(value)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [alias, entry] of Object.entries(value)) {
    if (isPlainRecord(entry)) out[alias] = entry;
  }
  return out;
}

/**
 * Build a project `mcp_servers` update from a desired override map: removed
 * aliases become `null` tombstones so the per-alias merge deletes them from
 * the project file (a home alias then resurfaces).
 */
export function withMcpTombstones(
  desired: Record<string, Record<string, unknown>>,
  stored: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown> | null> {
  const updates: Record<string, Record<string, unknown> | null> = { ...desired };
  for (const alias of Object.keys(stored)) {
    if (!(alias in updates)) updates[alias] = null;
  }
  return updates;
}
