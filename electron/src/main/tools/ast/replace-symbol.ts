/**
 * replace_symbol tool — replace an entire symbol definition.
 *
 * Handles the full range (including decorators/comments), ambiguity guard,
 * reverse-byte replacements, atomic write, and post-write callbacks.
 *
 * Ported from Python `src/orchid/tools/ast.py` execute_replace_symbol.
 */
import * as fs from 'node:fs';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { resolveToolPath } from '../types';
import { langForExtension, loadQueryFile, parseFile, runQuery } from '../../ast/parser';
import { triggerPostWriteCallbacks } from '../filesystem/callbacks';
import {
  generateDiff,
  countDiffChanges,
  atomicWrite,
  formatEditResult,
  findExtendedRange,
} from './utils';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const replaceSymbolSchema = z.object({
  file_path: z.string().describe('Path to the source file'),
  symbol_name: z.string().describe('The symbol name to replace'),
  new_source: z.string().describe('The complete replacement text for the symbol definition'),
});

export type ReplaceSymbolInput = z.infer<typeof replaceSymbolSchema>;

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const replaceSymbolDefinition: ToolDefinition = {
  name: 'replace_symbol',
  description:
    'Replace an entire symbol definition (function, class, method) including ' +
    'its docstring, decorators, and comments. Use this instead of the edit tool ' +
    'for replacing whole functions — it handles the full range automatically ' +
    'and supports multiple replacements in one call with correct offsets.',
  inputSchema: replaceSymbolSchema,
  actionLabel: 'Replacing symbol...',
  category: 'ast',
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const replaceSymbolHandler: ToolHandler = async (input: unknown, ctx) => {
  const { file_path: rawPath, symbol_name, new_source } = input as ReplaceSymbolInput;
  const file_path = resolveToolPath(ctx.cwd, rawPath);

  try {
    if (!fs.existsSync(file_path)) {
      return {
        display: `File not found: ${file_path}`,
        content: formatEditResult({
          filePath: file_path,
          success: false,
          replacements: 0,
          added: 0,
          removed: 0,
          error: 'file_not_found',
          message: `File not found: ${file_path}`,
        }),
      isError: true
    };
    }

    const content = fs.readFileSync(file_path, 'utf-8');
    const langName = langForExtension(file_path);
    const queryText = await loadQueryFile(langName);
    const tree = await parseFile(file_path, content);

    try {
      const captures = await runQuery(tree, langName, queryText, content);

      const nameCaps = captures['name.definition.function'] ?? [];
      const methodCaps = captures['name.definition.method'] ?? [];
      const classCaps = captures['name.definition.class'] ?? [];

      const targetCaps = [...nameCaps, ...methodCaps, ...classCaps].filter(
        (r) => r.text === symbol_name,
      );

      if (targetCaps.length === 0) {
        return {
          display: `Symbol '${symbol_name}' not found in ${file_path}`,
          content: formatEditResult({
            filePath: file_path,
            success: false,
            replacements: 0,
            added: 0,
            removed: 0,
            error: 'symbol_not_found',
            message: `Symbol '${symbol_name}' not found in ${file_path}`,
          }),
      isError: true
    };
      }

      // Find definition nodes and their extended ranges
      const replacements: Array<{ start: number; end: number; context: string }> = [];

      for (const r of targetCaps) {
        const defNode = findDefinitionNode(r.node);
        if (!defNode) continue;

        // Determine parent class context for disambiguation
        let ctxName = '<module>';
        let p = defNode.parent;
        while (p) {
          if (p.type === 'class_definition' || p.type === 'class_declaration') {
            const nameNode = p.childForFieldName('name');
            if (nameNode) {
              ctxName = content.slice(nameNode.startIndex, nameNode.endIndex);
            }
            break;
          }
          p = p.parent;
        }

        const { startByte, endByte } = findExtendedRange(content, defNode);
        replacements.push({ start: startByte, end: endByte, context: ctxName });
      }

      if (replacements.length === 0) {
        return {
          display: `Symbol '${symbol_name}' not found in ${file_path}`,
          content: formatEditResult({
            filePath: file_path,
            success: false,
            replacements: 0,
            added: 0,
            removed: 0,
            error: 'symbol_not_found',
            message: `Symbol '${symbol_name}' not found in ${file_path}`,
          }),
      isError: true
    };
      }

      // Ambiguity guard: if multiple definitions in different parent contexts,
      // ask the user to disambiguate
      const uniqueContexts = new Set(replacements.map((r) => r.context));
      if (replacements.length > 1 && uniqueContexts.size > 1) {
        const locations = replacements
          .map((r) => {
            const lineNum = content.slice(0, r.end).split('\n').length;
            return `  - ${r.context} (line ${lineNum})`;
          })
          .join('\n');

        return {
          display: `Multiple '${symbol_name}' definitions found — disambiguate`,
          content: formatEditResult({
            filePath: file_path,
            success: false,
            replacements: 0,
            added: 0,
            removed: 0,
            error: 'ambiguous_symbol',
            message:
              `Multiple definitions of '${symbol_name}' found in ${file_path}:\n` +
              `${locations}\n` +
              `Please specify which definition to replace (e.g. by providing ` +
              `the class name or line number).`,
          }),
      isError: true
    };
      }

      // Sort replacements in reverse byte order (so offsets don't shift)
      replacements.sort((a, b) => b.start - a.start);

      // Apply replacements
      const newSourceBytes = new TextEncoder().encode(new_source);
      let newContentBytes = new TextEncoder().encode(content);

      for (const { start, end } of replacements) {
        const before = newContentBytes.slice(0, start);
        const after = newContentBytes.slice(end);
        const combined = new Uint8Array(before.length + newSourceBytes.length + after.length);
        combined.set(before, 0);
        combined.set(newSourceBytes, before.length);
        combined.set(after, before.length + newSourceBytes.length);
        newContentBytes = combined;
      }

      const newContent = new TextDecoder().decode(newContentBytes);

      if (newContent === content) {
        return {
          display: `No changes for '${symbol_name}' in ${file_path}`,
          content: formatEditResult({
            filePath: file_path,
            success: true,
            replacements: 0,
            added: 0,
            removed: 0,
            message: `No changes needed for '${symbol_name}' in ${file_path}`,
          }),
        };
      }

      // Atomic write
      atomicWrite(file_path, newContent);

      // Generate diff
      const diffText = generateDiff(content, newContent, file_path);
      const { added, removed } = countDiffChanges(diffText);

      // Post-write callbacks
      const cbFailures = await triggerPostWriteCallbacks(file_path);

      let msg = `Replaced '${symbol_name}' in ${file_path} (+${added} -${removed})`;
      if (cbFailures.length > 0) {
        msg += ` [warnings: ${cbFailures.length} callback(s) failed]`;
      }

      return {
        display: msg,
        content: formatEditResult({
          filePath: file_path,
          success: true,
          replacements: replacements.length,
          added,
          removed,
          diffText,
          message: cbFailures.length > 0 ? cbFailures.join('; ') : undefined,
        }),
      };
    } finally {
      tree.delete();
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unsupported file extension')) {
      return {
        display: `Unsupported file type: ${file_path}`,
        content: formatEditResult({
          filePath: file_path,
          success: false,
          replacements: 0,
          added: 0,
          removed: 0,
          error: 'unsupported_file',
          message: err.message,
        }),
      isError: true
    };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      display: `Error replacing '${symbol_name}'`,
      content: formatEditResult({
        filePath: file_path,
        success: false,
        replacements: 0,
        added: 0,
        removed: 0,
        error: 'replace_error',
        message: `Error replacing '${symbol_name}' in ${file_path}: ${msg}`,
      }),
      isError: true
    };
  }
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFINITION_TYPES = new Set([
  'function_definition',
  'function_declaration',
  'method_definition',
  'class_definition',
  'class_declaration',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findDefinitionNode(node: any): any {
  if (DEFINITION_TYPES.has(node.type)) return node;
  if (node.parent && DEFINITION_TYPES.has(node.parent.type)) return node.parent;
  if (node.parent?.parent && DEFINITION_TYPES.has(node.parent.parent.type)) {
    return node.parent.parent;
  }
  return null;
}
