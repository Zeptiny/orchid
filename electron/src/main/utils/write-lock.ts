/**
 * Per-path write serialization for async store updates.
 */

// ── State ────────────────────────────────────────────────────────────────────

const writeChains = new Map<string, Promise<void>>();

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Serialize async/sync tasks per file path via a promise chain.
 * Ensures concurrent writes to the same path do not interleave.
 */
export function withSerializedWrite<T>(
  filePath: string,
  task: () => T | Promise<T>,
): Promise<T> {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const chain = run.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(filePath, chain);
  chain.then(
    () => {
      if (writeChains.get(filePath) === chain) writeChains.delete(filePath);
    },
    () => {
      if (writeChains.get(filePath) === chain) writeChains.delete(filePath);
    },
  );
  return run;
}

/**
 * @internal Test-only reset for isolated temporary stores.
 *
 * - With one or more paths: drop only those path entries.
 * - With no argument: clear every path (explicit full reset).
 */
export function _clearSerializedWriteChains(
  filePath?: string | readonly string[],
): void {
  if (filePath === undefined) {
    writeChains.clear();
    return;
  }
  if (typeof filePath === 'string') {
    writeChains.delete(filePath);
    return;
  }
  for (const path of filePath) {
    writeChains.delete(path);
  }
}
