/**
 * Main-owned workspace binding — draft cwd, sticky default, pure resolution.
 *
 * Resolution order (R2/R3):
 *   draft cwd (if set) → active session.cwd → valid default_project_dir → unbound
 *
 * Never uses process.cwd() as a product default.
 * Never calls process.chdir.
 *
 * Session-manager coupling lives in callers (session/chat IPC) so this module
 * stays free of circular imports with ipc/session.
 */
import * as fs from 'node:fs';
import { getConfig, atomicWriteJson, HOME_CONFIG_PATH } from '../config/loader';
import type { Config } from '../config/schema';
import {
  inspectProjectDirectory,
  type ProjectDirectoryStatus,
} from './path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where the resolved workspace path came from. */
export type WorkspaceSource = 'draft' | 'session' | 'default' | 'unbound';

/** Resolved workspace state for IPC / UI. */
export interface WorkspaceInfo {
  /** Canonical absolute path when bound; null when unbound. */
  readonly cwd: string | null;
  /** Source of the resolved path. */
  readonly source: WorkspaceSource;
  /** Coarse directory status (valid / missing / unbound). */
  readonly status: ProjectDirectoryStatus;
}

/** Inputs for pure workspace resolution (callers supply session/sticky). */
export interface WorkspaceResolveInput {
  /** Per-window draft cwd, if any. */
  draftCwd?: string | null;
  /** Active session.cwd, if any. */
  sessionCwd?: string | null;
  /** Home-config sticky default_project_dir. */
  stickyDefault?: string | null;
}

// ---------------------------------------------------------------------------
// Draft workspace (window-scoped)
// ---------------------------------------------------------------------------

/** Per-window draft project dir (before a session file exists). */
const draftCwdByWindow = new Map<string, string>();

/**
 * Set the draft workspace for a window (canonical absolute path).
 * Pass null to clear.
 */
export function setDraftCwd(windowId: string, cwd: string | null): void {
  if (cwd == null || cwd === '') {
    draftCwdByWindow.delete(windowId);
    return;
  }
  draftCwdByWindow.set(windowId, cwd);
}

/** Read the draft workspace for a window (raw stored path, may be stale). */
export function getDraftCwd(windowId: string): string | null {
  return draftCwdByWindow.get(windowId) ?? null;
}

/** Clear draft workspace for a window. */
export function clearDraftCwd(windowId: string): void {
  draftCwdByWindow.delete(windowId);
}

/** Clear all draft workspaces (tests / shutdown). */
export function clearAllDraftCwds(): void {
  draftCwdByWindow.clear();
}

// ---------------------------------------------------------------------------
// Sticky default_project_dir persistence
// ---------------------------------------------------------------------------

/**
 * Update the sticky home-config `default_project_dir` (intentional picks only).
 *
 * Mutates the in-memory ConfigManager cache and patches the home config file
 * for that field only — avoids dumping a full project-merged config into home.
 */
export function updateStickyDefaultProjectDir(dir: string | null): void {
  const cfg = getConfig() as Config & { default_project_dir: string | null };
  cfg.default_project_dir = dir;

  let home: Record<string, unknown> = {};
  try {
    if (fs.existsSync(HOME_CONFIG_PATH)) {
      const raw = fs.readFileSync(HOME_CONFIG_PATH, 'utf-8');
      home = JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
    home = {};
  }
  home.default_project_dir = dir;
  atomicWriteJson(HOME_CONFIG_PATH, home);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Pure workspace resolution from explicit inputs.
 *
 * Priority: draft → session.cwd → valid sticky default → unbound.
 * Never falls back to process.cwd().
 */
export function resolveWorkspaceFromParts(
  input: WorkspaceResolveInput,
): WorkspaceInfo {
  // 1. Draft cwd
  const draft = input.draftCwd;
  if (draft != null && draft !== '') {
    const inspection = inspectProjectDirectory(draft);
    return {
      cwd: inspection.path,
      source: 'draft',
      status: inspection.status,
    };
  }

  // 2. Active session cwd (when bound)
  const sessionCwd = input.sessionCwd;
  if (sessionCwd != null && sessionCwd !== '') {
    const inspection = inspectProjectDirectory(sessionCwd);
    return {
      cwd: inspection.path ?? sessionCwd,
      source: 'session',
      status: inspection.status,
    };
  }

  // 3. Sticky default_project_dir
  const sticky = input.stickyDefault;
  if (sticky != null && sticky !== '') {
    const inspection = inspectProjectDirectory(sticky);
    if (inspection.status === 'valid' && inspection.path != null) {
      return {
        cwd: inspection.path,
        source: 'default',
        status: 'valid',
      };
    }
    return {
      cwd: inspection.path,
      source: 'default',
      status: inspection.status === 'unbound' ? 'missing' : inspection.status,
    };
  }

  return { cwd: null, source: 'unbound', status: 'unbound' };
}

/**
 * Resolve workspace for a window using draft state + supplied session/sticky.
 *
 * Callers must pass active session cwd and sticky default (avoids circular
 * imports with SessionManager / config beyond getConfig for convenience).
 */
export function resolveWorkspace(
  windowId: string,
  options?: {
    sessionCwd?: string | null;
    stickyDefault?: string | null;
  },
): WorkspaceInfo {
  const sticky =
    options?.stickyDefault !== undefined
      ? options.stickyDefault
      : getConfig().default_project_dir;

  return resolveWorkspaceFromParts({
    draftCwd: getDraftCwd(windowId),
    sessionCwd: options?.sessionCwd ?? null,
    stickyDefault: sticky,
  });
}

/**
 * Whether the resolved workspace is usable for agent turns (send/create).
 */
export function isWorkspaceBound(info: WorkspaceInfo): boolean {
  return info.status === 'valid' && info.cwd != null && info.cwd !== '';
}

/**
 * Validate and canonicalize a project directory for binding.
 *
 * @returns Canonical absolute path
 * @throws Error if path is not a valid project directory
 */
export function requireValidProjectDirectory(dir: string): string {
  const inspection = inspectProjectDirectory(dir);
  if (inspection.status !== 'valid' || inspection.path == null) {
    const reason = inspection.reason ?? 'invalid project directory';
    throw new Error(`Cannot bind project directory: ${reason}`);
  }
  return inspection.path;
}
