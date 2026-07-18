/**
 * ast_index tool — manage the AST index (status, index, clear).
 *
 * Mirrors rag_index: action status|index|clear using AST indexer APIs.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
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
  actionLabel: 'Managing AST index...',
  category: 'ast',
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
        const lines = [
          'AST Index Status:',
          `  Total files: ${status.totalFiles}`,
          `  Total symbols: ${status.totalSymbols}`,
          `  Last indexed: ${status.lastIndexed ?? 'never'}`,
          `  Last index duration: ${status.lastIndexDuration != null ? status.lastIndexDuration.toFixed(1) + 's' : 'N/A'}`,
        ];
        return genericBuiltInToolOutcome('ast_index', lines.join('\n'));
      } finally {
        store.dispose();
      }
    }

    case 'index': {
      const result = await indexProject({
        projectPath,
        force: force === true,
      });
      const lines = [
        'AST Index Complete:',
        `  Files scanned: ${result.filesScanned}`,
        `  Files indexed: ${result.filesIndexed}`,
        `  Files skipped: ${result.filesSkipped}`,
        `  Files deleted: ${result.filesDeleted}`,
        `  Symbols extracted: ${result.symbolsExtracted}`,
        `  Duration: ${result.durationSeconds.toFixed(1)}s`,
      ];
      if (result.errors.length > 0) {
        lines.push(`  Errors: ${result.errors.length}`);
        for (const err of result.errors.slice(0, 5)) {
          lines.push(`    - ${err}`);
        }
        if (result.errors.length > 5) {
          lines.push(`    ... and ${result.errors.length - 5} more`);
        }
      }
      return genericBuiltInToolOutcome('ast_index', lines.join('\n'));
    }

    case 'clear': {
      const store = new ASTStore(projectPath);
      try {
        store.clear();
      } finally {
        store.dispose();
      }
      return genericBuiltInToolOutcome('ast_index', 'AST index cleared.');
    }

    default:
      return genericBuiltInToolOutcome(
        'ast_index',
        `Unknown action: ${action}. Use "status", "index", or "clear".`,
        'error',
      );
  }
};
