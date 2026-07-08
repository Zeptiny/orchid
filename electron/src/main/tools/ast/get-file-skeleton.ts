/**
 * get_file_skeleton tool — structural outline of a source file.
 *
 * Returns definition names with line numbers, call extraction, and visual separators.
 * Does NOT require the project index — parses the file directly.
 *
 * Ported from Python `src/orchid/tools/ast.py` execute_get_file_skeleton.
 */
import * as fs from 'node:fs';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { langForExtension, loadQueryFile, parseFile, runQuery } from '../../ast/parser';
import { xmlAttr, extractCallNames } from './utils';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const getFileSkeletonSchema = z.object({
  file_path: z.string().describe('Path to the source file, relative to cwd'),
});

export type GetFileSkeletonInput = z.infer<typeof getFileSkeletonSchema>;

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const getFileSkeletonDefinition: ToolDefinition = {
  name: 'get_file_skeleton',
  description:
    'Get a structural outline of a source file showing only definition lines ' +
    '(functions, classes, methods) without reading the entire file. Use this ' +
    "to understand a file's structure before reading specific functions. " +
    'Returns definition names with line numbers and visual separators.',
  inputSchema: getFileSkeletonSchema,
  actionLabel: 'Getting skeleton...',
  category: 'ast',
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const getFileSkeletonHandler: ToolHandler = async (input: unknown) => {
  const { file_path } = input as GetFileSkeletonInput;

  try {
    if (!fs.existsSync(file_path)) {
      return {
        display: `File not found: ${file_path}`,
        content:
          `<ast_error tool="get_file_skeleton" file="${xmlAttr(file_path)}">` +
          `File not found: ${file_path}</ast_error>`,
      };
    }

    const langName = langForExtension(file_path);
    const content = fs.readFileSync(file_path, 'utf-8');
    const queryText = await loadQueryFile(langName);
    const tree = await parseFile(file_path, content);

    try {
      const captures = await runQuery(tree, langName, queryText, content);

      const contentBytes = content;
      const definitions: Array<{ lineNum: number; name: string; parentNode: any }> = [];

      for (const [capName, results] of Object.entries(captures)) {
        if (capName.startsWith('name.definition.')) {
          for (const r of results) {
            // Get parent node for line range and call extraction
            // We need to traverse the tree to find the parent
            definitions.push({
              lineNum: r.startLine,
              name: r.text,
              parentNode: null, // Will be resolved below
            });
          }
        }
      }

      if (definitions.length === 0) {
        return {
          display: `No definitions in ${file_path}`,
          content:
            `<file_skeleton file="${xmlAttr(file_path)}" definitions="0">\n` +
            'No definitions found.\n</file_skeleton>',
        };
      }

      // Sort by line number
      definitions.sort((a, b) => a.lineNum - b.lineNum);

      // For call extraction, we need to walk the tree
      // Re-run with parent node resolution
      const definitionsWithParents = resolveParentNodes(tree, content, captures);

      const lines: string[] = [];
      lines.push(
        `<file_skeleton file="${xmlAttr(file_path)}" definitions="${definitionsWithParents.length}">`,
      );

      let prevLine: number | null = null;
      for (const def of definitionsWithParents) {
        if (prevLine !== null && def.lineNum > prevLine + 1) {
          lines.push('  |----');
        }

        let callsStr = '';
        let lineCountStr = '';

        if (def.parentEndLine !== undefined) {
          const lineCount = def.parentEndLine - (def.lineNum + 1);
          lineCountStr = `  # Lines: ${lineCount}`;
          const calls = extractCallNames(def.parentNode, content);
          const filteredCalls = calls.filter((c) => c !== def.name);
          if (filteredCalls.length > 0) {
            callsStr = `  # Calls: [${filteredCalls.join(', ')}]`;
          }
        }

        lines.push(
          `  ${String(def.lineNum + 1).padStart(4)} | ${def.name}${callsStr}${lineCountStr}`,
        );

        prevLine = def.lineNum;
      }

      lines.push('</file_skeleton>');

      return {
        display: `Skeleton of ${file_path}: ${definitionsWithParents.length} definitions`,
        content: lines.join('\n'),
      };
    } finally {
      tree.delete();
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unsupported file extension')) {
      return {
        display: `Unsupported file type: ${file_path}`,
        content:
          `<ast_error tool="get_file_skeleton" file="${xmlAttr(file_path)}">` +
          `${err.message}</ast_error>`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      display: `Error: ${file_path}`,
      content:
        `<ast_error tool="get_file_skeleton" file="${xmlAttr(file_path)}">` +
        `${msg}</ast_error>`,
    };
  }
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface DefinitionInfo {
  lineNum: number;
  name: string;
  parentNode: any;
  parentEndLine?: number;
}

function resolveParentNodes(
  tree: any,
  content: string,
  captures: Record<string, any[]>,
): DefinitionInfo[] {
  const definitions: DefinitionInfo[] = [];

  for (const [capName, results] of Object.entries(captures)) {
    if (capName.startsWith('name.definition.')) {
      for (const r of results) {
        // Find the parent definition node by walking up from the name node
        const parentNode = findDefinitionParent(r.node);
        definitions.push({
          lineNum: r.startLine,
          name: r.text,
          parentNode,
          parentEndLine: parentNode ? parentNode.endPosition.row : undefined,
        });
      }
    }
  }

  definitions.sort((a, b) => a.lineNum - b.lineNum);
  return definitions;
}

function findDefinitionParent(node: any): any {
  const DEFINITION_TYPES = new Set([
    'function_definition',
    'function_declaration',
    'method_definition',
    'class_definition',
    'class_declaration',
  ]);

  let current = node.parent;
  while (current) {
    if (DEFINITION_TYPES.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}
