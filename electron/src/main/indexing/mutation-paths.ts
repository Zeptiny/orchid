/**
 * Canonical-result → mutated-path extraction for index auto-refresh.
 *
 * Derives the project-relative files a tool result actually mutated from
 * canonical result facts (never tool arguments), so tool dispatch can feed the
 * index refresh coordinator without per-tool parsing. Only the file-mutating
 * results carry mutated paths: `file-write`/`file-change` expose `data.path`,
 * and `apply_patch` (whose declared family is `generic`) exposes
 * `files[].path` with a per-file operation. Malformed data is skipped entry by
 * entry — extraction must never throw, because it runs inside tool
 * finalization where a failure could break the tool result.
 */
import * as path from 'node:path';
import type { CanonicalToolResult, JsonValue } from '../../shared/types/tool-result';
import type { IndexMutationEntry } from './refresh-coordinator';

/**
 * Extract the files a canonical tool result mutated, as workspace-relative
 * paths resolved against `cwd`. Every other family (and any path that escapes
 * the workspace) yields no entries.
 */
export function extractMutations(
  toolName: string,
  canonical: CanonicalToolResult,
  cwd: string,
): IndexMutationEntry[] {
  try {
    if (canonical.family === 'file-write' || canonical.family === 'file-change') {
      const rel = dataPathRel(canonical.data, cwd);
      return rel === null ? [] : [{ rel, op: 'upsert' }];
    }
    if (toolName === 'apply_patch') {
      return applyPatchEntries(canonical.data, cwd);
    }
    return [];
  } catch {
    return [];
  }
}

function toWorkspaceRel(cwd: string, mutated: string): string | null {
  const rel = path.relative(cwd, path.resolve(cwd, mutated));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

function dataPathRel(data: JsonValue, cwd: string): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const mutated = (data as Record<string, JsonValue>)['path'];
  if (typeof mutated !== 'string' || mutated === '') return null;
  return toWorkspaceRel(cwd, mutated);
}

function applyPatchEntries(data: JsonValue, cwd: string): IndexMutationEntry[] {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return [];
  const files = (data as Record<string, JsonValue>)['files'];
  if (!Array.isArray(files)) return [];
  const entries: IndexMutationEntry[] = [];
  for (const file of files) {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) continue;
    const record = file as Record<string, JsonValue>;
    if (record['status'] === 'error') continue;
    const rel = dataPathRel(file, cwd);
    if (rel === null) continue;
    entries.push({ rel, op: record['operation'] === 'delete' ? 'delete' : 'upsert' });
  }
  return entries;
}
