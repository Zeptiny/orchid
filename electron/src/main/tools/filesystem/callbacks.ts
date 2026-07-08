/**
 * Post-write callbacks — shared registry for hooks that fire after file writes.
 *
 * Edit and write tools invoke these callbacks after a successful write.
 * RAG (U16) and AST (U17) modules register their update functions here
 * so the filesystem tools stay decoupled from indexing concerns.
 *
 * Ported from Python `src/orchid/tools/ast.py` lines 28-34, 233-242.
 */

export type PostWriteCallback = (filePath: string) => Promise<void>;

const callbacks: PostWriteCallback[] = [];

/**
 * Register a callback that fires after every successful file write.
 * Idempotent — registering the same function twice has no effect.
 */
export function registerPostWriteCallback(cb: PostWriteCallback): void {
  if (!callbacks.includes(cb)) {
    callbacks.push(cb);
  }
}

/**
 * Unregister a previously registered callback.
 */
export function unregisterPostWriteCallback(cb: PostWriteCallback): void {
  const idx = callbacks.indexOf(cb);
  if (idx >= 0) {
    callbacks.splice(idx, 1);
  }
}

/**
 * Run all registered post-write callbacks.
 * Returns a list of failure messages (empty if all succeeded).
 */
export async function triggerPostWriteCallbacks(filePath: string): Promise<string[]> {
  const failures: string[] = [];
  for (const cb of callbacks) {
    try {
      await cb(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(msg);
    }
  }
  return failures;
}

/**
 * Clear all registered callbacks. Useful in tests.
 */
export function clearPostWriteCallbacks(): void {
  callbacks.length = 0;
}

/**
 * Return the number of registered callbacks (for testing).
 */
export function callbackCount(): number {
  return callbacks.length;
}
