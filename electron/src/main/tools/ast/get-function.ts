/**
 * get_function tool — extract specific function(s) by name from a source file.
 *
 * Returns source with class context and imports. Uses FNV-1a change detection
 * to report "No changes" on repeat retrieval.
 *
 * Ported from Python `src/orchid/tools/ast.py` execute_get_function.
 */
import * as fs from 'node:fs';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import { resolveToolPath } from '../types';
import { langForExtension, loadQueryFile, parseFile, runQuery } from '../../ast/parser';
import { xmlAttr, fnv1a } from './utils';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const getFunctionSchema = z.object({
  file_path: z.string().describe('Path to the source file, relative to cwd'),
  function_name: z.string().describe('Function name to extract'),
});

export type GetFunctionInput = z.infer<typeof getFunctionSchema>;

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const getFunctionDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'get_function',
  description:
    'Extract a specific function by name from a source file, including ' +
    'relevant imports and parent class context. Use this instead of reading ' +
    'an entire file when you only need one function. Reports ' +
    '"no changes" if the function body has not changed since last retrieval.',
  inputSchema: getFunctionSchema,
  category: 'ast',
  noTimeout: true,
};

// ---------------------------------------------------------------------------
// Session-level hash tracking (FNV-1a change detection)
// ---------------------------------------------------------------------------

const sentHashes = new Map<string, string>();

/** Clear hash tracking (e.g., on session reset). */
export function clearFunctionHashes(): void {
  sentHashes.clear();
}

// ---------------------------------------------------------------------------
// Import queries per language
// ---------------------------------------------------------------------------

const IMPORT_QUERIES: Record<string, string> = {
  python: `
(import_statement) @import
(import_from_statement) @import
`,
  javascript: `
(import_statement) @import
`,
  typescript: `
(import_statement) @import
`,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const getFunctionHandler: ToolHandler = async (input: unknown, ctx) => {
  const { file_path: rawPath, function_name } = input as GetFunctionInput;
  const file_path = resolveToolPath(ctx.cwd, rawPath);

  try {
    if (!fs.existsSync(file_path)) {
      return genericBuiltInToolOutcome('get_function', `<ast_error tool="get_function" file="${xmlAttr(file_path)}">` +
          `File not found: ${file_path}</ast_error>`, 'error');
    }

    const names = [function_name.trim()].filter(Boolean);
    if (names.length === 0) {
      return genericBuiltInToolOutcome('get_function', '<ast_error tool="get_function">No valid function names provided.</ast_error>', 'error');
    }

    const content = fs.readFileSync(file_path, 'utf-8');
    const langName = langForExtension(file_path);
    const queryText = await loadQueryFile(langName);
    const tree = await parseFile(file_path, content);

    try {
      const captures = await runQuery(tree, langName, queryText, content);

      // Get imports
      const importQuery = IMPORT_QUERIES[langName];
      let importsText = '';
      if (importQuery) {
        const importCaptures = await runQuery(tree, langName, importQuery, content);
        const importResults = importCaptures['import'] ?? [];
        if (importResults.length > 0) {
          importsText = importResults.map((r) => r.text).join('\n');
        }
      }

      const nameCaps = captures['name.definition.function'] ?? [];
      const methodCaps = captures['name.definition.method'] ?? [];

      const foundFunctions: string[] = [];

      for (const targetName of names) {
        let matched = false;

        for (const r of [...nameCaps, ...methodCaps]) {
          if (r.text !== targetName) continue;

          // Find the function/method definition node
          const funcNode = findDefinitionNode(r.node);
          if (!funcNode) continue;

          // Get class context
          let classText = '';
          let p = funcNode.parent;
          while (p) {
            if (p.type === 'class_definition' || p.type === 'class_declaration') {
              const bodyNode = p.childForFieldName('body');
              const endByte = bodyNode ? bodyNode.startIndex : p.endIndex;
              classText = content.slice(p.startIndex, endByte);
              break;
            }
            p = p.parent;
          }

          const funcText = content.slice(funcNode.startIndex, funcNode.endIndex);
          const hashKey = `${file_path}:${targetName}:${classText}`;
          const currentHash = fnv1a(funcText);
          const lastHash = sentHashes.get(hashKey);

          const startLine = funcNode.startPosition.row + 1;
          const endLine = funcNode.endPosition.row + 1;

          if (lastHash !== undefined && lastHash === currentHash) {
            foundFunctions.push(
              `<function name="${xmlAttr(targetName)}" ` +
              `file="${xmlAttr(file_path)}" ` +
              `start_line="${startLine}" end_line="${endLine}">\n` +
              'No changes have been made since last retrieval.\n</function>',
            );
          } else {
            const parts: string[] = [];
            parts.push(
              `<function name="${xmlAttr(targetName)}" ` +
              `file="${xmlAttr(file_path)}" ` +
              `start_line="${startLine}" end_line="${endLine}">`,
            );
            if (importsText) {
              parts.push('<imports>');
              // Escape XML special chars in imports
              parts.push(escapeXml(importsText));
              parts.push('</imports>');
            }
            if (classText) {
              parts.push('<class_context>');
              parts.push(escapeXml(classText));
              parts.push('</class_context>');
            }
            parts.push('<body>');
            parts.push(escapeXml(funcText));
            parts.push('</body>');
            parts.push('</function>');
            foundFunctions.push(parts.join('\n'));
            sentHashes.set(hashKey, currentHash);
          }

          matched = true;
        }

        if (!matched) {
          foundFunctions.push(
            `<function name="${xmlAttr(targetName)}" ` +
            `file="${xmlAttr(file_path)}" status="not_found">\n` +
            `Function '${targetName}' not found.\n</function>`,
          );
        }
      }

      const contentXml =
        `<functions file="${xmlAttr(file_path)}" count="${foundFunctions.length}">\n` +
        foundFunctions.join('\n') +
        '\n</functions>';

      return genericBuiltInToolOutcome('get_function', contentXml, 'complete');
    } finally {
      tree.delete();
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unsupported file extension')) {
      return genericBuiltInToolOutcome('get_function', `<ast_error tool="get_function" file="${xmlAttr(file_path)}">` +
          `${err.message}</ast_error>`, 'error');
    }
    const msg = err instanceof Error ? err.message : String(err);
    return genericBuiltInToolOutcome('get_function', `<ast_error tool="get_function" file="${xmlAttr(file_path)}">` +
        `${msg}</ast_error>`, 'error');
  }
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFINITION_TYPES = new Set([
  'function_definition',
  'function_declaration',
  'method_definition',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findDefinitionNode(node: any): any {
  // Check if the node itself is a definition
  if (DEFINITION_TYPES.has(node.type)) return node;

  // Check parent
  if (node.parent && DEFINITION_TYPES.has(node.parent.type)) return node.parent;

  // Check grandparent
  if (node.parent?.parent && DEFINITION_TYPES.has(node.parent.parent.type)) {
    return node.parent.parent;
  }

  return null;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
