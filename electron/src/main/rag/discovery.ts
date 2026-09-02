/**
 * RAG file discovery — the indexable file set behind an index run: the
 * extension filter, the workspace walk (whole tree or scoped paths), the
 * scope math a run prunes inside, and the read + hash step every candidate
 * goes through.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INDEX_SKIP_DIR_NAMES } from '../indexing/skip-dirs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INCLUDE_EXTS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.md', '.txt',
  '.yaml', '.yml', '.toml', '.json', '.sql', '.sh',
  '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.css', '.html', '.rb', '.php', '.swift', '.kt',
]);

const SKIP_EXTS = new Set(['.pyc', '.pyo', '.pyd', '.so', '.dll', '.exe']);

const DEFAULT_IGNORED_DIRS = new Set(INDEX_SKIP_DIR_NAMES);

// ---------------------------------------------------------------------------
// Include filtering
// ---------------------------------------------------------------------------

export function shouldInclude(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase();
  if (SKIP_EXTS.has(ext)) return false;
  return INCLUDE_EXTS.has(ext);
}

/** Dedupe, absolutize, extension-filter, and sort incremental upsert targets. */
export function normalizeUpsertTargets(projectPath: string, rels: string[]): string[] {
  return [...new Set(rels)]
    .map((rel) => (path.isAbsolute(rel) ? rel : path.join(projectPath, rel)))
    .filter((abs) => shouldInclude(abs))
    .sort();
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoverFilesOptions {
  /** Restrict discovery to these project-relative or absolute paths. */
  paths?: string[];
  /** Config-supplied directory names skipped on top of the built-in set. */
  ignoredDirs?: string[];
}

export async function discoverFiles(
  root: string,
  opts: DiscoverFilesOptions = {},
): Promise<string[]> {
  const skip = new Set([...(opts.ignoredDirs ?? []), ...DEFAULT_IGNORED_DIRS]);
  const { paths } = opts;
  if (paths && paths.length > 0) {
    return dedupeSorted(await collectScoped(root, paths, skip));
  }
  return (await walkDir(root, skip)).sort();
}

async function collectScoped(
  root: string,
  paths: string[],
  skip: Set<string>,
): Promise<string[]> {
  const result: string[] = [];
  for (const target of paths) {
    result.push(...(await collectTarget(root, target, skip)));
  }
  return result;
}

async function collectTarget(
  root: string,
  target: string,
  skip: Set<string>,
): Promise<string[]> {
  const abs = path.isAbsolute(target) ? target : path.join(root, target);
  const stat = await safeStat(abs);
  if (!stat) return [];
  if (stat.isFile()) return shouldInclude(abs) ? [abs] : [];
  if (stat.isDirectory()) return await walkDir(abs, skip);
  return [];
}

async function walkDir(directory: string, skip: Set<string>): Promise<string[]> {
  const entries = await readEntries(directory);
  if (!entries) return [];

  const files: string[] = [];
  const subDirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) subDirs.push(path.join(directory, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    const filepath = path.join(directory, entry.name);
    if (shouldInclude(filepath)) files.push(filepath);
  }

  const nested = await Promise.all(subDirs.map((sub) => walkDir(sub, skip)));
  for (const group of nested) {
    files.push(...group);
  }
  return files;
}

async function readEntries(directory: string): Promise<fs.Dirent[] | null> {
  try {
    return await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
}

function dedupeSorted(filepaths: string[]): string[] {
  return [...new Set(filepaths)].sort();
}

async function safeStat(filepath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filepath);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scope math
// ---------------------------------------------------------------------------

export function resolveScopeRoots(root: string, paths: string[] | undefined): string[] {
  if (paths && paths.length > 0) {
    return paths.map((p) => (
      path.resolve(path.isAbsolute(p) ? p : path.join(root, p))
    ));
  }
  return [path.resolve(root)];
}

export function isInsideAnyScope(absPath: string, scopeRoots: string[]): boolean {
  return scopeRoots.some(
    (scopeRoot) => absPath === scopeRoot || absPath.startsWith(scopeRoot + path.sep),
  );
}

/** Project-relative path, or null when it cannot be computed. */
export function relativeToRoot(root: string, filepath: string): string | null {
  try {
    return path.relative(root, filepath);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read + hash
// ---------------------------------------------------------------------------

export interface FileContent {
  content: string;
  hash: string;
}

export async function readAndHash(
  filepath: string,
  maxFileSize: number,
): Promise<FileContent | null> {
  try {
    const stat = await fs.promises.stat(filepath);
    if (stat.size > maxFileSize) return null;
    if (stat.size === 0) return null;

    const content = await fs.promises.readFile(filepath, 'utf-8');
    if (content.includes('\0')) return null; // binary

    const hash = crypto.createHash('md5').update(content).digest('hex');
    return { content, hash };
  } catch {
    return null;
  }
}
