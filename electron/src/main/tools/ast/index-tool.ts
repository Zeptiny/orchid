/**
 * ast_index tool — manage the AST index (status, index, clear).
 *
 * Mirrors rag_index: action status|index|clear using AST indexer APIs.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';
import { indexProject } from '../../ast/indexer';
import { ASTStore } from '../../ast/store';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const astIndexSchema = z.object({
  action: z
    .enum(['status', 'index', 'clear'])
    .describe(
      'Action: "status" returns index stats, "index" triggers full re-index, "clear" drops the index',
    ),
  force: z
    .boolean()
    .optional()
    .describe('When action is "index", force re-index even if files appear unchanged'),
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const astIndexDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'ast_index',
  description:
    'Manage the AST (Abstract Syntax Tree) symbol index. ' +
    'Use "status" to check index stats, "index" to build/rebuild the index, "clear" to drop it. ' +
    'Symbol tools (find_symbol_references, rename_symbol) auto-index on first use; use this for explicit control.',
  inputSchema: astIndexSchema,
  category: 'ast',
  riskClass: RiskClass.MUTATION,
  noTimeout: true,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const astIndexHandler: ToolHandler = async (
  input: unknown,
  ctx,
): Promise<GenericBuiltInToolOutcome> => {
  const { action, force } = input as {
    action: 'status' | 'index' | 'clear';
    force?: boolean;
  };
  const projectPath = ctx.cwd;

  switch (action) {
    case 'status': {
      const store = new ASTStore(projectPath);
      try {
        const status = store.status();
        return genericBuiltInToolOutcome('ast_index', {
          action: 'status',
          totalFiles: status.totalFiles,
          totalSymbols: status.totalSymbols,
          lastIndexed: status.lastIndexed ?? 'never',
          lastDuration: status.lastIndexDuration != null
            ? status.lastIndexDuration.toFixed(1) + 's'
            : 'N/A',
        });
      } finally {
        store.dispose();
      }
    }

    case 'index': {
      const result = await indexProject({
        projectPath,
        force: force === true,
      });
      return genericBuiltInToolOutcome('ast_index', {
        action: 'index',
        filesScanned: result.filesScanned,
        filesIndexed: result.filesIndexed,
        filesSkipped: result.filesSkipped,
        filesDeleted: result.filesDeleted,
        symbolsExtracted: result.symbolsExtracted,
        duration: result.durationSeconds.toFixed(1) + 's',
        errors: result.errors.length,
      });
    }

    case 'clear': {
      const store = new ASTStore(projectPath);
      try {
        store.clear();
      } finally {
        store.dispose();
      }
      return genericBuiltInToolOutcome('ast_index', { action: 'clear' });
    }

    default:
      return genericBuiltInToolOutcome(
        'ast_index',
        `Unknown action: ${action}. Use "status", "index", or "clear".`,
        'error',
      );
  }
};
