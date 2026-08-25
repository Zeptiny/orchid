/**
 * Project-config target authorization.
 *
 * Sidebar project settings can be opened for any project that has sessions,
 * regardless of which session is currently selected in the window. Project
 * config IPC targets are therefore authorized when the canonical requested
 * directory is either the window's resolved workspace (draft → active
 * session → sticky default) or the cwd of any saved session. Everything
 * else fails closed.
 *
 * Electron-free domain policy (relocated from ipc/project-target.ts so the
 * host core no longer reaches into the IPC shell layer).
 */
import { getSessionManager, resolveWindowWorkspace } from '../session/singleton';
import { canonicalizeProjectDirectory } from './path';

/**
 * Resolve a renderer-supplied project directory to its canonical path when
 * the sender is authorized to read/write that project's config.
 *
 * `senderId` is the opaque client identity (Electron window id or host
 * connection id).
 *
 * @throws When the directory is invalid or is neither the selected workspace nor a session project.
 */
export function resolveAuthorizedProjectDir(senderId: string | number, projectDir: string): string {
  const canonical = canonicalizeProjectDirectory(projectDir);
  if (canonical == null) {
    throw new Error(`Project config target is not a valid project directory: ${projectDir}`);
  }

  const workspace = resolveWindowWorkspace(String(senderId));
  if (workspace.status === 'valid' && workspace.cwd != null && workspace.cwd === canonical) {
    return canonical;
  }

  if (isSessionProject(canonical)) {
    return canonical;
  }

  throw new Error(
    'Project config target does not match the selected workspace or any project with sessions.',
  );
}

function isSessionProject(canonical: string): boolean {
  let summaries;
  try {
    summaries = getSessionManager().listSaved();
  } catch {
    return false;
  }
  return summaries.some((summary) => {
    const cwd = summary.cwd;
    if (cwd == null || cwd === '') return false;
    return cwd === canonical || canonicalizeProjectDirectory(cwd) === canonical;
  });
}
