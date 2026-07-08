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
import { ensureIndexed } from '../../ast/indexer';
import { ASTStore, type SymbolRow } from '../../ast/store';
import { triggerPostWriteCallbacks } from '../filesystem/callbacks';
import { xmlAttr, generateDiff, countDiffChanges, atomicWrite, cdataText } from './utils';

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
  name: 'rename_symbol',
  description:
    'Rename a symbol across all files in one call. Updates all definitions ' +
    'and references atomically per file. Use this instead of multiple edit ' +
    'calls for cross-file renames.',
  inputSchema: renameSymbolSchema,
  actionLabel: 'Renaming symbol...',
  category: 'ast',
};

// ---------------------------------------------------------------------------
// Identifier characters for word boundary check
// ---------------------------------------------------------------------------

const IDENT_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_');

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const renameSymbolHandler: ToolHandler = async (input: unknown) => {
  const { file_path, old_name, new_name } = input as RenameSymbolInput;

  try {
    if (!old_name || !old_name.trim()) {
      return {
        display: 'Empty symbol name',
        content: '<ast_error tool="rename_symbol">Symbol name is required.</ast_error>',
      };
    }

    if (!new_name || !new_name.trim()) {
      return {
        display: 'Empty new name',
        content: '<ast_error tool="rename_symbol">New name is required.</ast_error>',
      };
    }

    await ensureIndexed();

    const projectPath = process.cwd();
    const store = new ASTStore(projectPath);
    const symbols = store.getSymbolsByName(old_name, 'both');

    if (symbols.length === 0) {
      return {
        display: `No references for '${old_name}'`,
        content:
          `<ast_error tool="rename_symbol">` +
          `No references found for '${old_name}'. No files modified.</ast_error>`,
      };
    }

    // Group symbols by file
    const byFile = new Map<string, SymbolRow[]>();
    for (const s of symbols) {
      const list = byFile.get(s.filePath) ?? [];
      list.push(s);
      byFile.set(s.filePath, list);
    }

    // Phase 1: compute all new contents without writing
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

      // Sort symbols in reverse order (by line, then column) so replacements
      // don't shift offsets
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

        // Convert byte-based column to character-based column
        const lineBytes = Buffer.from(line, 'utf-8');
        if (byteCol > lineBytes.length) continue;

        const charCol = Buffer.from(lineBytes.slice(0, byteCol)).toString('utf-8').length;
        const charEnd = charCol + old_name.length;

        if (line.slice(charCol, charEnd) !== old_name) continue;

        // Word boundary check
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
      return {
        display: `No changes for '${old_name}'`,
        content:
          `<ast_error tool="rename_symbol">` +
          `No changes made for '${old_name}'.</ast_error>`,
      };
    }

    // Phase 2: write all files
    let totalAdded = 0;
    let totalRemoved = 0;
    const editResults: string[] = [];

    for (const change of planned) {
      try {
        atomicWrite(change.absPath, change.newContent);
      } catch (writeErr) {
        failedFiles.push(change.relPath);
        editResults.push(
          `<edit_result path="${xmlAttr(change.relPath)}" success="false" ` +
          `replacements="0" replace_all="false" ` +
          `added="0" removed="0" ` +
          `error="${xmlAttr(String(writeErr))}" />`,
        );
        continue;
      }

      const diffText = generateDiff(change.oldContent, change.newContent, change.relPath);
      const { added, removed } = countDiffChanges(diffText);
      totalAdded += added;
      totalRemoved += removed;

      const cbFailures = await triggerPostWriteCallbacks(change.relPath);
      if (cbFailures.length > 0) {
        failedFiles.push(change.relPath);
      }

      editResults.push(
        `<edit_result path="${xmlAttr(change.relPath)}" success="true" ` +
        `replacements="${change.replacements}" replace_all="false" ` +
        `added="${added}" removed="${removed}">\n` +
        `<diff format="unified"><![CDATA[${cdataText(diffText)}]]></diff>\n` +
        `</edit_result>`,
      );
    }

    if (editResults.length === 0) {
      return {
        display: `No changes for '${old_name}'`,
        content:
          `<ast_error tool="rename_symbol">` +
          `No changes made for '${old_name}'.</ast_error>`,
      };
    }

    const overallSuccess = failedFiles.length === 0;
    const resultXml =
      `<rename_result name="${xmlAttr(old_name)}" ` +
      `new_name="${xmlAttr(new_name)}" ` +
      `files="${editResults.length}" ` +
      `total_added="${totalAdded}" total_removed="${totalRemoved}" ` +
      `success="${overallSuccess}">\n` +
      editResults.join('\n') +
      '\n</rename_result>';

    let display: string;
    if (failedFiles.length > 0) {
      display =
        `Renamed '${old_name}' -> '${new_name}' with errors: ` +
        `${planned.length - failedFiles.length} succeeded, ` +
        `${failedFiles.length} failed (${failedFiles.join(', ')})`;
    } else {
      display =
        `Renamed '${old_name}' -> '${new_name}' in ` +
        `${editResults.length} file(s) (+${totalAdded} -${totalRemoved})`;
    }

    return { display, content: resultXml };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      display: `Error renaming '${old_name}'`,
      content: `<ast_error tool="rename_symbol">${msg}</ast_error>`,
    };
  }
};
