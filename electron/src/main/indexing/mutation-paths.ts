/**
 * Canonical-result → mutated-path extraction for index auto-refresh.
 *
 * Derives the project-relative files a tool result actually mutated from
 * canonical result facts (never tool arguments), so tool dispatch can feed the
 * index refresh coordinator without per-tool parsing. Only the file-mutating
 * results carry mutated paths: `file-write`/`file-change` expose `data.path`,
 * and the file-rewriting tools whose declared family is `generic` report them
 * name-keyed — `apply_patch` exposes `files[].path` (plus `movePath` for
 * moves), `rename_symbol` exposes `value.edits[].path`, and `replace_symbol`
 * exposes `value.file`. Malformed data is skipped entry by entry — extraction
 * must never throw, because it runs inside tool finalization where a failure
 * could break the tool result.
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
    switch (toolName) {
      case 'apply_patch':
        return applyPatchEntries(canonical.data, cwd);
      case 'rename_symbol':
        return renameSymbolEntries(canonical.data, cwd);
      case 'replace_symbol':
        return replaceSymbolEntries(canonical.data, cwd);
    }
    return [];
  } catch {
    return [];
  }
}

function toWorkspaceRel(cwd: string, mutated: string): string | null {
  const rel = path.relative(cwd, path.resolve(cwd, mutated));
  if (rel === '' || path.isAbsolute(rel)) return null;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../')) return null;
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
    // A move unlinks the source `path` and writes the patched content to
    // `movePath`: the source is a delete and the destination an upsert.
    // Treating it as a source upsert would leave ghost chunks for the removed
    // path and never index the destination. A destination that escapes the
    // workspace is dropped; the source delete is kept either way.
    const movePath = record['movePath'];
    if (typeof movePath === 'string' && movePath !== '') {
      entries.push({ rel, op: 'delete' });
      const destRel = toWorkspaceRel(cwd, movePath);
      if (destRel !== null) {
        entries.push({ rel: destRel, op: 'upsert' });
      }
      continue;
    }
    entries.push({ rel, op: record['operation'] === 'delete' ? 'delete' : 'upsert' });
  }
  return entries;
}

/**
 * Read a field of a generic-family result's `value` payload. Built-in generic
 * tools nest their result facts under `data.value` (see
 * `genericBuiltInToolOutcome`).
 */
function genericValueField(data: JsonValue, field: string): JsonValue | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const value = (data as Record<string, JsonValue>)['value'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, JsonValue>)[field];
}

/**
 * rename_symbol reports one entry per rewritten file under `value.edits[]`,
 * each carrying the mutated file `path` (project-relative). Entries with
 * `success: false` are failed writes — the file was not modified — and are
 * skipped like apply_patch's errored files.
 */
function renameSymbolEntries(data: JsonValue, cwd: string): IndexMutationEntry[] {
  const edits = genericValueField(data, 'edits');
  if (!Array.isArray(edits)) return [];
  const entries: IndexMutationEntry[] = [];
  for (const edit of edits) {
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) continue;
    const record = edit as Record<string, JsonValue>;
    if (record['success'] === false) continue;
    const rel = dataPathRel(edit, cwd);
    if (rel === null) continue;
    entries.push({ rel, op: 'upsert' });
  }
  return entries;
}

/**
 * replace_symbol rewrites a single file reported under `value.file`
 * (absolute, already workspace-resolved by the tool).
 */
function replaceSymbolEntries(data: JsonValue, cwd: string): IndexMutationEntry[] {
  const file = genericValueField(data, 'file');
  if (typeof file !== 'string' || file === '') return [];
  const rel = toWorkspaceRel(cwd, file);
  return rel === null ? [] : [{ rel, op: 'upsert' }];
}
