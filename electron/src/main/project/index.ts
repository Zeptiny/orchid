/**
 * Project workspace helpers — public API.
 */
export {
  inspectProjectDirectory,
  canonicalizeProjectDirectory,
  getProjectDirectoryStatus,
  type ProjectDirectoryStatus,
  type ProjectDirectoryInspection,
} from './path';

export {
  resolveWorkspace,
  resolveWorkspaceFromParts,
  isWorkspaceBound,
  requireValidProjectDirectory,
  setDraftCwd,
  getDraftCwd,
  clearDraftCwd,
  clearAllDraftCwds,
  updateStickyDefaultProjectDir,
  type WorkspaceSource,
  type WorkspaceInfo,
  type WorkspaceResolveInput,
} from './workspace';
