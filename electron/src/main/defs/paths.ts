/**
 * Path helpers for skills / agents / personalities on disk.
 *
 * Global:  ~/.orchid/{skills,agents,personalities}/
 * Project: <workspace>/.orchid/{skills,agents,personalities}/
 *
 * All write/delete/reveal operations re-check paths under realpath'd roots
 * so symlinks cannot escape definition directories.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeFsync } from '../utils/safe-fsync';
import {
  HOME_AGENTS_DIR,
  HOME_PERSONALITIES_DIR,
  HOME_SKILLS_DIR,
} from '../config/loader';
import {
  DEFINITION_NAME_PATTERN,
  type DefinitionScope,
} from '../../shared/types/definitions';

export type DefinitionKind = 'skills' | 'agents' | 'personalities';

/** Built-in internal agents that must never be project-overlaid or IPC-deleted. */
export const RESERVED_INTERNAL_AGENT_NAMES = new Set([
  'general',
  'session-namer',
  'web-fetch',
]);

export function validateDefinitionName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!DEFINITION_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid name "${name}". Use lowercase letters, digits, hyphens, or underscores ` +
        `(must start with a letter), e.g. my-skill.`,
    );
  }
  return trimmed;
}

export function resolveScopeRoot(
  kind: DefinitionKind,
  scope: DefinitionScope,
  projectDir: string | null,
): string {
  if (scope === 'global') {
    switch (kind) {
      case 'skills':
        return HOME_SKILLS_DIR;
      case 'agents':
        return HOME_AGENTS_DIR;
      case 'personalities':
        return HOME_PERSONALITIES_DIR;
    }
  }

  if (!projectDir) {
    throw new Error(
      'Project scope requires a bound workspace. Pick a project folder first.',
    );
  }

  return path.join(projectDir, '.orchid', kind);
}

/** Directory containing SKILL.md / AGENT.md for named definitions. */
export function definitionEntryDir(
  kind: 'skills' | 'agents',
  scope: DefinitionScope,
  name: string,
  projectDir: string | null,
): string {
  const safe = validateDefinitionName(name);
  return path.join(resolveScopeRoot(kind, scope, projectDir), safe);
}

export function skillMdPath(
  scope: DefinitionScope,
  name: string,
  projectDir: string | null,
): string {
  return path.join(definitionEntryDir('skills', scope, name, projectDir), 'SKILL.md');
}

export function agentMdPath(
  scope: DefinitionScope,
  name: string,
  projectDir: string | null,
): string {
  return path.join(definitionEntryDir('agents', scope, name, projectDir), 'AGENT.md');
}

export function personalityMdPath(
  scope: DefinitionScope,
  name: string,
  projectDir: string | null,
): string {
  const safe = validateDefinitionName(name);
  return path.join(resolveScopeRoot('personalities', scope, projectDir), `${safe}.md`);
}

// ── Path containment ─────────────────────────────────────────────────────────

function isUnderRoot(candidate: string, root: string): boolean {
  const c = path.resolve(candidate);
  const r = path.resolve(root);
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Resolve a path for read/write under a scope root.
 * Ensures the parent directory (and final path when it exists) stay under
 * the realpath of the scope root — blocks symlink write-through.
 */
export function assertPathInScopeRoot(
  fileOrDirPath: string,
  scopeRoot: string,
): string {
  fs.mkdirSync(scopeRoot, { recursive: true });
  const logicalRoot = path.resolve(scopeRoot);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(scopeRoot);
  } catch {
    realRoot = logicalRoot;
  }

  const resolved = path.resolve(fileOrDirPath);
  const rel = path.relative(logicalRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside definition root: ${fileOrDirPath}`);
  }

  // The scope root itself
  if (rel === '') {
    return realRoot;
  }

  // Ensure intermediate dirs exist under the logical root
  const absLogical = path.join(logicalRoot, rel);
  const parentLogical = path.dirname(absLogical);
  if (!fs.existsSync(parentLogical)) {
    fs.mkdirSync(parentLogical, { recursive: true });
  }

  let realParent: string;
  try {
    realParent = fs.realpathSync(parentLogical);
  } catch {
    throw new Error(`Cannot resolve parent path: ${parentLogical}`);
  }
  if (!isUnderRoot(realParent, realRoot) && realParent !== realRoot) {
    throw new Error(`Path escapes definition root via symlink: ${fileOrDirPath}`);
  }

  const finalPath = path.join(realParent, path.basename(absLogical));
  if (fs.existsSync(finalPath) || fs.existsSync(absLogical)) {
    const leaf = fs.existsSync(finalPath) ? finalPath : absLogical;
    let realLeaf: string;
    try {
      realLeaf = fs.realpathSync(leaf);
    } catch {
      throw new Error(`Cannot resolve path: ${fileOrDirPath}`);
    }
    if (!isUnderRoot(realLeaf, realRoot) && realLeaf !== realRoot) {
      throw new Error(`Path escapes definition root via symlink: ${fileOrDirPath}`);
    }
    return realLeaf;
  }

  return finalPath;
}

/**
 * Atomic text write with containment check + fsync.
 */
export function atomicWriteText(filePath: string, content: string, scopeRoot: string): void {
  const safePath = assertPathInScopeRoot(filePath, scopeRoot);
  const dir = path.dirname(safePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${safePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, content, 'utf-8');
      safeFsync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, safePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup
    }
    throw err;
  }
}

/** Remove a file if present (must be under scope root). */
export function removeFileInScope(filePath: string, scopeRoot: string): void {
  if (!fs.existsSync(filePath)) return;
  const safePath = assertPathInScopeRoot(filePath, scopeRoot);
  if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    fs.unlinkSync(safePath);
  }
}

/**
 * Remove a skill/agent directory tree under a scope root.
 */
export function removeDefinitionDir(dirPath: string, scopeRoot: string): void {
  if (!fs.existsSync(dirPath)) return;
  const safePath = assertPathInScopeRoot(dirPath, scopeRoot);
  // Refuse to delete the root itself
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(scopeRoot);
  } catch {
    realRoot = path.resolve(scopeRoot);
  }
  if (path.resolve(safePath) === path.resolve(realRoot)) {
    throw new Error('Refusing to delete definition scope root');
  }
  fs.rmSync(safePath, { recursive: true, force: true });
}

/**
 * Rename a definition directory under scope root (preserves resources).
 * Fails if target exists or paths escape the root.
 */
export function renameDefinitionDir(
  fromDir: string,
  toDir: string,
  scopeRoot: string,
): void {
  if (!fs.existsSync(fromDir)) {
    throw new Error(`Source definition directory not found: ${fromDir}`);
  }
  if (fs.existsSync(toDir)) {
    throw new Error(
      `Cannot rename: target already exists (${path.basename(toDir)})`,
    );
  }
  const safeFrom = assertPathInScopeRoot(fromDir, scopeRoot);
  // Target parent must be under root; leaf must not exist
  assertPathInScopeRoot(path.dirname(toDir), scopeRoot);
  const safeTo = path.join(
    fs.realpathSync(path.dirname(toDir)),
    path.basename(toDir),
  );
  if (!isUnderRoot(safeTo, fs.realpathSync(scopeRoot))) {
    throw new Error(`Rename target escapes definition root: ${toDir}`);
  }
  fs.renameSync(safeFrom, safeTo);
}

/**
 * Ensure a reveal/open path is under home definition dirs or project .orchid,
 * after realpath (blocks symlink escape).
 */
export function assertPathUnderOrchidRoots(
  targetPath: string,
  projectDir: string | null,
): string {
  const resolved = path.resolve(targetPath);

  const rootsLogical: string[] = [
    path.resolve(HOME_SKILLS_DIR),
    path.resolve(HOME_AGENTS_DIR),
    path.resolve(HOME_PERSONALITIES_DIR),
  ];
  if (projectDir) {
    rootsLogical.push(path.resolve(path.join(projectDir, '.orchid')));
  }

  // Reject outside paths even when missing (before exists check)
  const underLogical = rootsLogical.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  if (!underLogical) {
    throw new Error('Path is outside Orchid definition directories');
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(resolved);
  } catch {
    throw new Error(`Cannot resolve path: ${targetPath}`);
  }

  const rootsReal = rootsLogical.map((r) => {
    try {
      return fs.existsSync(r) ? fs.realpathSync(r) : r;
    } catch {
      return r;
    }
  });

  const ok = rootsReal.some((root) => isUnderRoot(realTarget, root));
  if (!ok) {
    throw new Error('Path is outside Orchid definition directories');
  }
  return realTarget;
}

/**
 * Assert rename target does not already exist (file or dir).
 */
export function assertTargetDoesNotExist(targetPath: string): void {
  if (fs.existsSync(targetPath)) {
    throw new Error(
      `A definition already exists at "${path.basename(targetPath)}". Choose a different name.`,
    );
  }
}
