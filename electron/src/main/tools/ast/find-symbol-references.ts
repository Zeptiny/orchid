/**
 * find_symbol_references tool — find all definitions and references of a symbol.
 *
 * Queries the AST symbol store (requires project index). Returns file paths
 * with line/column ranges.
 *
 * Ported from Python `src/orchid/tools/ast.py` execute_find_symbol_references.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import { resolveToolPath } from '../types';
import { ensureIndexed } from '../../ast/indexer';
import { ASTStore } from '../../ast/store';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const findSymbolReferencesSchema = z.object({
  symbol_name: z.string().describe('The symbol name to search for'),
  file_path: z
    .string()
    .optional()
    .describe('Optional: limit search to a specific file'),
});

export type FindSymbolReferencesInput = z.infer<typeof findSymbolReferencesSchema>;

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const findSymbolReferencesDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'find_symbol_references',
  description:
    'Find all definitions and references of a symbol by name across the project. ' +
    'Use this to understand where a symbol is defined and used before renaming ' +
    'or refactoring. Returns file paths with line/column ranges.',
  inputSchema: findSymbolReferencesSchema,
  category: 'ast',
  noTimeout: true,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const findSymbolReferencesHandler: ToolHandler = async (input: unknown, ctx) => {
  const { symbol_name, file_path } = input as FindSymbolReferencesInput;

  try {
    if (!symbol_name || !symbol_name.trim()) {
      return genericBuiltInToolOutcome('find_symbol_references', { error: 'Symbol name is required.' }, 'error', 'tool_error', 'Symbol name is required.');
    }

    const projectPath = ctx.cwd;
    await ensureIndexed(projectPath);

    const store = new ASTStore(projectPath);
    const symbols = store.getSymbolsByName(symbol_name, 'both');

    const filterPath = file_path ? resolveToolPath(ctx.cwd, file_path) : undefined;
    const filtered = filterPath
      ? symbols.filter(
          (s) =>
            s.filePath === filterPath ||
            s.filePath === file_path ||
            resolveToolPath(projectPath, s.filePath) === filterPath,
        )
      : symbols;

    if (filtered.length === 0) {
      return genericBuiltInToolOutcome(
        'find_symbol_references',
        { name: symbol_name, count: 0, references: [] },
        'complete',
      );
    }

    const references = filtered.map((s) => ({
      kind: s.kind,
      file: s.filePath,
      startLine: s.startLine + 1,
      endLine: s.endLine + 1,
    }));

    return genericBuiltInToolOutcome('find_symbol_references', {
      name: symbol_name,
      count: filtered.length,
      references,
    }, 'complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return genericBuiltInToolOutcome('find_symbol_references', { error: msg }, 'error', 'tool_error', msg);
  }
};
