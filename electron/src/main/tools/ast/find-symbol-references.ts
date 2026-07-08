/**
 * find_symbol_references tool — find all definitions and references of a symbol.
 *
 * Queries the AST symbol store (requires project index). Returns file paths
 * with line/column ranges.
 *
 * Ported from Python `src/orchid/tools/ast.py` execute_find_symbol_references.
 */
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
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

export const findSymbolReferencesHandler: ToolHandler = async (input: unknown) => {
  const { symbol_name, file_path } = input as FindSymbolReferencesInput;

  try {
    if (!symbol_name || !symbol_name.trim()) {
      return {
        display: 'Empty symbol name',
        content: '<ast_error tool="find_symbol_references">Symbol name is required.</ast_error>',
      };
    }

    await ensureIndexed();

    const projectPath = process.cwd();
    const store = new ASTStore(projectPath);
    const symbols = store.getSymbolsByName(symbol_name, 'both');

    // Filter by file if specified
    const filtered = file_path
      ? symbols.filter((s) => s.filePath === file_path)
      : symbols;

    if (filtered.length === 0) {
      return {
        display: `No references for '${symbol_name}'`,
        content: `<symbol_references name="${xmlAttr(symbol_name)}" count="0" />`,
      };
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

    const defs = filtered.filter((s) => s.type === 'definition').length;
    const refs = filtered.filter((s) => s.type === 'reference').length;

    const resultXml =
      `<symbol_references name="${xmlAttr(symbol_name)}" ` +
      `type_filter="both" count="${filtered.length}">\n` +
      parts.join('\n') +
      '\n</symbol_references>';

    return {
      display: `Found ${defs} definition(s), ${refs} reference(s) for '${symbol_name}'`,
      content: resultXml,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      display: `Error finding '${symbol_name}'`,
      content: `<ast_error tool="find_symbol_references">${msg}</ast_error>`,
    };
  }
};
