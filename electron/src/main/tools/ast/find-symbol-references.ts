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
import { xmlAttr } from './utils';

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
  actionLabel: 'Finding references...',
  category: 'ast',
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const findSymbolReferencesHandler: ToolHandler = async (input: unknown, ctx) => {
  const { symbol_name, file_path } = input as FindSymbolReferencesInput;

  try {
    if (!symbol_name || !symbol_name.trim()) {
      return genericBuiltInToolOutcome('find_symbol_references', '<ast_error tool="find_symbol_references">Symbol name is required.</ast_error>', 'error');
    }

    const projectPath = ctx.cwd;
    await ensureIndexed(projectPath);

    const store = new ASTStore(projectPath);
    const symbols = store.getSymbolsByName(symbol_name, 'both');

    // Filter by file if specified (resolve relative paths against session cwd)
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
      return genericBuiltInToolOutcome('find_symbol_references', `<symbol_references name="${xmlAttr(symbol_name)}" count="0" />`, 'complete');
    }

    const parts: string[] = [];
    for (const s of filtered) {
      parts.push(
        `  <symbol name="${xmlAttr(s.name)}" ` +
        `type="${s.type}" ` +
        `kind="${s.kind}" ` +
        `file="${xmlAttr(s.filePath)}" ` +
        `start_line="${s.startLine + 1}" ` +
        `start_column="${s.startColumn}" ` +
        `end_line="${s.endLine + 1}" ` +
        `end_column="${s.endColumn}" />`,
      );
    }

    const resultXml =
      `<symbol_references name="${xmlAttr(symbol_name)}" ` +
      `type_filter="both" count="${filtered.length}">\n` +
      parts.join('\n') +
      '\n</symbol_references>';

    return genericBuiltInToolOutcome('find_symbol_references', resultXml, 'complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return genericBuiltInToolOutcome('find_symbol_references', `<ast_error tool="find_symbol_references">${msg}</ast_error>`, 'error');
  }
};
