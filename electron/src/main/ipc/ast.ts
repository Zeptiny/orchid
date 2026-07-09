/**
 * AST IPC handlers — ast:status, ast:index.
 *
 * Wraps AST indexer from U17 with zod-validated payloads.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import {
  indexProject,
  isIndexing,
} from '../ast/indexer';
import { ASTStore } from '../ast/store';

// ── Zod validation schemas ───────────────────────────────────────────────────

const astIndexSchema = z.object({
  force: z.boolean().optional().default(false),
});

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerASTIPC(): void {
  // ast:status — return AST store status
  ipcMain.handle(IPC_CHANNELS.AST_STATUS, async () => {
    const store = new ASTStore(process.cwd());
    return store.status();
  });

  // ast:index — trigger AST indexing
  ipcMain.handle(IPC_CHANNELS.AST_INDEX, async (_event, payload: unknown) => {
    // Validate input with zod (payload is optional)
    const parsed = astIndexSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid ast:index payload: ${parsed.error.message}`);
    }

    const { force } = parsed.data;

    if (isIndexing()) {
      return {
        filesScanned: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        filesDeleted: 0,
        symbolsExtracted: 0,
        errors: ['Indexing already in progress'],
        durationSeconds: 0,
      };
    }

    return indexProject({ force });
  });
}

/**
 * Unregister AST IPC handlers (for cleanup/testing).
 */
export function unregisterASTIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.AST_STATUS);
  ipcMain.removeHandler(IPC_CHANNELS.AST_INDEX);
}
