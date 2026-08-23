/**
 * Canonical directory names skipped by every indexing walk (full scans and
 * the workspace watcher). The indexers historically carried private copies
 * of this set; it lives here so the three consumers cannot drift.
 *
 * `.orchid` is included because both index stores live under it; the watcher
 * additionally re-asserts it as a hard (config-independent) skip (R9).
 */
export const INDEX_SKIP_DIR_NAMES: readonly string[] = [
  'node_modules', '.git', '__pycache__',
  '.venv', 'venv', 'env',
  '.orchid', 'dist', 'build',
  '.next', '.cache', 'target',
];
