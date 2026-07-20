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
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import { resolveToolPath } from '../types';
import { langForExtension, loadQueryFile, parseFile, runQuery } from '../../ast/parser';

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
  ...genericToolResultMetadata,
  name: 'get_file_skeleton',
  description:
    'Get a structural outline of a source file showing only definition lines ' +
    '(functions, classes, methods) without reading the entire file. Use this ' +
    "to understand a file's structure before reading specific functions. " +
    'Returns definition names with line numbers and visual separators.',
  inputSchema: getFileSkeletonSchema,
  actionLabel: 'Getting skeleton...',
  category: 'ast',
  noTimeout: true,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const getFileSkeletonHandler: ToolHandler = async (input: unknown, ctx) => {
  const { file_path: rawPath } = input as GetFileSkeletonInput;
  const file_path = resolveToolPath(ctx.cwd, rawPath);

  try {
    if (!fs.existsSync(file_path)) {
      return genericBuiltInToolOutcome('get_file_skeleton',
        { error: 'File not found: ' + file_path, file: file_path },
        'error', 'tool_error', 'File not found: ' + file_path);
    }

    const langName = langForExtension(file_path);
    const content = fs.readFileSync(file_path, 'utf-8');
    const queryText = await loadQueryFile(langName);
    const tree = await parseFile(file_path, content);

    try {
      const captures = await runQuery(tree, langName, queryText, content);
      const definitionsWithParents = resolveParentNodes(tree, content, captures);
      const totalLines = content.split('\n').length;

      const structuredDefinitions = definitionsWithParents.map((def) => ({
        line: def.lineNum + 1,
        name: def.name,
        lineCount: def.parentEndLine === undefined ? 0 : def.parentEndLine - def.lineNum,
      }));

      return genericBuiltInToolOutcome('get_file_skeleton', {
        file: file_path,
        definitions: structuredDefinitions,
        totalLines,
      }, 'complete');
    } finally {
      tree.delete();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return genericBuiltInToolOutcome('get_file_skeleton',
      { error: msg, file: file_path }, 'error', 'tool_error', msg);
  }
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface DefinitionInfo {
  lineNum: number;
  name: string;
  parentNode: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  parentEndLine?: number;
}

function resolveParentNodes(
  tree: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  content: string,
  captures: Record<string, any[]>, // eslint-disable-line @typescript-eslint/no-explicit-any
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
