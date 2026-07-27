/**
 * Worker-side implementation for get_function source extraction.
 *
 * This module deliberately owns the file read and tree-sitter work so the
 * Electron main process only validates paths, enforces limits, and formats
 * the result.
 */
import * as fs from 'node:fs';
import { langForExtension, loadQueryFile, parseFile, runQuery } from '../../ast/parser';

export interface GetFunctionExtractionRequest {
  filePath: string;
  functionName: string;
  maxFileSize?: number;
}

export interface ExtractedFunction {
  name: string;
  startLine: number;
  endLine: number;
  body: string;
  classContext: string;
}

export interface GetFunctionExtraction {
  importsText: string;
  functions: ExtractedFunction[];
}

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

const DEFINITION_TYPES = new Set([
  'function_definition',
  'function_declaration',
  'method_definition',
]);

/** Read, parse, and extract the requested function in an AST worker. */
export async function extractFunction(
  request: GetFunctionExtractionRequest,
): Promise<GetFunctionExtraction> {
  const stat = await fs.promises.stat(request.filePath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${request.filePath}`);
  }
  if (request.maxFileSize !== undefined && stat.size > request.maxFileSize) {
    throw new Error(
      `File exceeds AST size limit (${stat.size} bytes; maximum ${request.maxFileSize} bytes).`,
    );
  }
  const content = await fs.promises.readFile(request.filePath, 'utf-8');
  const langName = langForExtension(request.filePath);
  const queryText = await loadQueryFile(langName);
  const tree = await parseFile(request.filePath, content);

  try {
    const captures = await runQuery(tree, langName, queryText, content);
    const importQuery = IMPORT_QUERIES[langName];
    let importsText = '';
    if (importQuery) {
      const importCaptures = await runQuery(tree, langName, importQuery, content);
      const importResults = importCaptures.import ?? [];
      if (importResults.length > 0) {
        importsText = importResults.map((result) => result.text).join('\n');
      }
    }

    const definitions = [
      ...(captures['name.definition.function'] ?? []),
      ...(captures['name.definition.method'] ?? []),
    ];
    const functions: ExtractedFunction[] = [];

    for (const result of definitions) {
      if (result.text !== request.functionName) continue;
      const node = findDefinitionNode(result.node);
      if (!node) continue;

      let classContext = '';
      let parent = node.parent;
      while (parent) {
        if (parent.type === 'class_definition' || parent.type === 'class_declaration') {
          const bodyNode = parent.childForFieldName('body');
          const endByte = bodyNode ? bodyNode.startIndex : parent.endIndex;
          classContext = content.slice(parent.startIndex, endByte);
          break;
        }
        parent = parent.parent;
      }

      functions.push({
        name: request.functionName,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        body: content.slice(node.startIndex, node.endIndex),
        classContext,
      });
    }

    return { importsText, functions };
  } finally {
    tree.delete();
  }
}

// web-tree-sitter's SyntaxNode declarations do not model every parent field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findDefinitionNode(node: any): any {
  if (DEFINITION_TYPES.has(node.type)) return node;
  if (node.parent && DEFINITION_TYPES.has(node.parent.type)) return node.parent;
  if (node.parent?.parent && DEFINITION_TYPES.has(node.parent.parent.type)) {
    return node.parent.parent;
  }
  return null;
}
