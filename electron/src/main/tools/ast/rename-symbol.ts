/**
 * rename_symbol tool — rename a symbol across all files.
 *
 * Two-phase: compute all changes in memory, then write atomically per file.
 * Word boundary guard. Byte-to-char column conversion.
 *
 * Ported from Python `src/orchid/tools/ast.py` execute_rename_symbol.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import { ensureIndexed } from '../../ast/indexer';
import { ASTStore, type SymbolRow } from '../../ast/store';
import { atomicWrite } from './utils';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const renameSymbolSchema = z.object({
  file_path: z.string().describe('File containing the symbol (optional — searches entire project if omitted)'),
  old_name: z.string().describe('The current symbol name'),
  new_name: z.string().describe('The new symbol name'),
});

export type RenameSymbolInput = z.infer<typeof renameSymbolSchema>;

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const renameSymbolDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'rename_symbol',
  description:
    'Rename a symbol across all files in one call. Updates all definitions ' +
    'and references atomically per file. Use this instead of multiple edit ' +
    'calls for cross-file renames.',
  inputSchema: renameSymbolSchema,
  category: 'ast',
  noTimeout: true,
};

// ---------------------------------------------------------------------------
// Identifier characters for word boundary check
// ---------------------------------------------------------------------------

const IDENT_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_');

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const renameSymbolHandler: ToolHandler = async (input: unknown, ctx) => {
  const { old_name, new_name } = input as RenameSymbolInput;

  try {
    if (!old_name || !old_name.trim()) {
      return genericBuiltInToolOutcome('rename_symbol', { error: 'Symbol name is required.' }, 'error', 'tool_error', 'Symbol name is required.');
    }

    if (!new_name || !new_name.trim()) {
      return genericBuiltInToolOutcome('rename_symbol', { error: 'New name is required.' }, 'error', 'tool_error', 'New name is required.');
    }

    const projectPath = ctx.cwd;
    await ensureIndexed(projectPath);

    const store = new ASTStore(projectPath);
    const symbols = store.getSymbolsByName(old_name, 'both');

    if (symbols.length === 0) {
      return genericBuiltInToolOutcome('rename_symbol', { error: `No references found for '${old_name}'. No files modified.` }, 'error', 'tool_error', `No references found for '${old_name}'. No files modified.`);
    }

    const byFile = new Map<string, SymbolRow[]>();
    for (const s of symbols) {
      const list = byFile.get(s.filePath) ?? [];
      list.push(s);
      byFile.set(s.filePath, list);
    }

    interface PlannedChange {
      relPath: string;
      absPath: string;
      oldContent: string;
      newContent: string;
      replacements: number;
    }

    const planned: PlannedChange[] = [];
    const failedFiles: string[] = [];

    for (const [relPath, fileSymbols] of byFile) {
      const absPath = path.join(projectPath, relPath);
      if (!fs.existsSync(absPath)) {
        failedFiles.push(relPath);
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        failedFiles.push(relPath);
        continue;
      }

      const lines = content.split('\n');

      const sortedSyms = [...fileSymbols].sort((a, b) => {
        if (a.startLine !== b.startLine) return b.startLine - a.startLine;
        return b.startColumn - a.startColumn;
      });

      let fileReplacements = 0;

      for (const s of sortedSyms) {
        const lineIdx = s.startLine;
        const byteCol = s.startColumn;

        if (lineIdx >= lines.length) continue;

        const line = lines[lineIdx];

        const lineBytes = Buffer.from(line, 'utf-8');
        if (byteCol > lineBytes.length) continue;

        const charCol = Buffer.from(lineBytes.slice(0, byteCol)).toString('utf-8').length;
        const charEnd = charCol + old_name.length;

        if (line.slice(charCol, charEnd) !== old_name) continue;

        if (charCol > 0 && IDENT_CHARS.has(line[charCol - 1])) continue;
        if (charEnd < line.length && IDENT_CHARS.has(line[charEnd])) continue;

        lines[lineIdx] = line.slice(0, charCol) + new_name + line.slice(charEnd);
        fileReplacements++;
      }

      const newContent = lines.join('\n');

      if (newContent === content) continue;

      planned.push({
        relPath,
        absPath,
        oldContent: content,
        newContent,
        replacements: fileReplacements,
      });
    }

    if (planned.length === 0) {
      return genericBuiltInToolOutcome('rename_symbol', { error: `No changes made for '${old_name}'.` }, 'error', 'tool_error', `No changes made for '${old_name}'.`);
    }

    const edits: Array<Record<string, string | number | boolean>> = [];

    for (const change of planned) {
      try {
        atomicWrite(change.absPath, change.newContent);
      } catch (writeErr) {
        failedFiles.push(change.relPath);
        edits.push({
          path: change.relPath,
          success: false,
          replacements: 0,
          replaceAll: false,
          added: 0,
          removed: 0,
          error: String(writeErr),
        });
        continue;
      }

      edits.push({
        path: change.relPath,
        replacements: change.replacements,
      });
    }

    if (edits.length === 0) {
      return genericBuiltInToolOutcome('rename_symbol', { error: `No changes made for '${old_name}'.` }, 'error', 'tool_error', `No changes made for '${old_name}'.`);
    }

    const overallSuccess = failedFiles.length === 0;

    return genericBuiltInToolOutcome('rename_symbol', {
      oldName: old_name,
      newName: new_name,
      files: edits.length,
      success: overallSuccess,
      edits,
    }, 'complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return genericBuiltInToolOutcome('rename_symbol', { error: msg }, 'error', 'tool_error', msg);
  }
};
