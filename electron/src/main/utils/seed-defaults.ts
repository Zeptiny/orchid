/**
 * Shared seed helper for subdirectory-based definition trees (skills, agents).
 *
 * Each entry under `sourceDir` is a named subdirectory that must contain a
 * marker file (e.g. SKILL.md / AGENT.md). Missing targets are copied in full;
 * existing markers are preserved and only missing resource subtrees are filled.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SeedDefaultSubdirsOptions {
  /** Marker filename required in each source subdirectory (e.g. `SKILL.md`). */
  markerFilename: string;
  /** Resource subdirectory names to fill when the marker already exists. */
  resourceDirs: readonly string[];
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Copy default definition subdirectories from `sourceDir` into `targetDir`.
 *
 * - Missing marker at target: recursive copy of the entire source subtree.
 * - Existing marker: leave user content alone; only copy missing resource dirs.
 */
export function seedDefaultSubdirs(
  sourceDir: string,
  targetDir: string,
  options: SeedDefaultSubdirsOptions,
): void {
  if (!isDirectory(sourceDir)) {
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return;
  }

  const entries = dirents
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const entry of entries) {
    const sourceSubdir = path.join(sourceDir, entry);

    const sourceFile = path.join(sourceSubdir, options.markerFilename);
    if (!fs.existsSync(sourceFile)) continue;

    const targetSubdir = path.join(targetDir, entry);
    const targetFile = path.join(targetSubdir, options.markerFilename);

    if (!fs.existsSync(targetFile)) {
      fs.cpSync(sourceSubdir, targetSubdir, { recursive: true });
      continue;
    }

    for (const resource of options.resourceDirs) {
      const sourceResource = path.join(sourceSubdir, resource);
      const targetResource = path.join(targetSubdir, resource);
      if (isDirectory(sourceResource) && !fs.existsSync(targetResource)) {
        fs.cpSync(sourceResource, targetResource, { recursive: true });
      }
    }
  }
}
