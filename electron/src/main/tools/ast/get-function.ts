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
import { getToolConfig, type ToolDefinition, type ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import { resolveToolPath } from '../types';
import { xmlAttr, fnv1a } from './utils';
import {
  GetFunctionCapacityError,
  runGetFunctionInWorker,
} from './get-function-worker-runner';

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
  riskClass: RiskClass.READ_ONLY,
};

// ---------------------------------------------------------------------------
// Session-level hash tracking (FNV-1a change detection)
// ---------------------------------------------------------------------------

const sentHashes = new Map<string, string>();
const MAX_SENT_HASHES = 256;

/** Clear hash tracking (e.g., on session reset). */
export function clearFunctionHashes(): void {
  sentHashes.clear();
}

/** Drop change-detection entries owned by a deleted session. */
export function clearFunctionHashesForSession(sessionId: string): void {
  clearFunctionHashesWithPrefix(`session:${sessionId}:`);
}

/** Drop draft-workspace entries when the workspace is replaced or released. */
export function clearFunctionHashesForWorkspace(cwd: string): void {
  clearFunctionHashesWithPrefix(`workspace:${cwd}:`);
}

/** Visible only to focused retention tests. */
export function getFunctionHashCountForTests(): number {
  return sentHashes.size;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const getFunctionHandler: ToolHandler = async (input: unknown, ctx) => {
  const { file_path: rawPath, function_name } = input as GetFunctionInput;
  const file_path = resolveToolPath(ctx.cwd, rawPath);

  try {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file_path);
    } catch {
      return genericBuiltInToolOutcome('get_function', `File not found: ${file_path}`, 'error');
    }

    const names = [function_name.trim()].filter(Boolean);
    if (names.length === 0) {
      return genericBuiltInToolOutcome('get_function', 'No valid function names provided.', 'error');
    }

    const maxFileSize = getToolConfig(ctx).ast_max_file_size;
    if (!stat.isFile()) {
      return genericBuiltInToolOutcome('get_function', `Path is not a regular file: ${file_path}`, 'error');
    }
    if (stat.size > maxFileSize) {
      return genericBuiltInToolOutcome(
        'get_function',
        `File exceeds AST size limit (${stat.size} bytes; maximum ${maxFileSize} bytes).`,
        'error',
      );
    }

    const extraction = await runGetFunctionInWorker({
      filePath: file_path,
      functionName: names[0],
      maxFileSize,
    }, ctx.abortSignal);
    const foundFunctions: string[] = [];
    const scope = ctx.sessionId ? `session:${ctx.sessionId}` : `workspace:${ctx.cwd}`;

    for (const targetName of names) {
      const matches = extraction.functions.filter((item) => item.name === targetName);
      if (matches.length === 0) {
        foundFunctions.push(
          `<function name="${xmlAttr(targetName)}" status="not_found">\n` +
          `Function '${targetName}' not found.\n</function>`,
        );
        continue;
      }

      for (const match of matches) {
        const hashKey = `${scope}:${file_path}:${targetName}:${fnv1a(match.classContext)}`;
        const currentHash = fnv1a(match.body);
        const lastHash = readFunctionHash(hashKey);
        if (lastHash === currentHash) {
          foundFunctions.push(
            `<function name="${xmlAttr(targetName)}" ` +
            `start_line="${match.startLine}" end_line="${match.endLine}">\n` +
            'No changes have been made since last retrieval.\n</function>',
          );
        } else {
          const parts: string[] = [];
          parts.push(
            `<function name="${xmlAttr(targetName)}" ` +
            `start_line="${match.startLine}" end_line="${match.endLine}">`,
          );
          if (extraction.importsText) {
            parts.push('<imports>');
            parts.push(extraction.importsText);
            parts.push('</imports>');
          }
          if (match.classContext) {
            parts.push('<class_context>');
            parts.push(match.classContext);
            parts.push('</class_context>');
          }
          parts.push('<body>');
          parts.push(match.body);
          parts.push('</body>');
          parts.push('</function>');
          foundFunctions.push(parts.join('\n'));
          storeFunctionHash(hashKey, currentHash);
        }
      }
    }
    const contentXml =
      `<functions file="${xmlAttr(file_path)}" count="${foundFunctions.length}">\n` +
      foundFunctions.join('\n') +
      '\n</functions>';
    return genericBuiltInToolOutcome('get_function', contentXml, 'complete');
  } catch (err) {
    if (err instanceof GetFunctionCapacityError) {
      return genericBuiltInToolOutcome('get_function',
        'AST extraction is at capacity; retry shortly.', 'error');
    }
    if (err instanceof Error && err.message.includes('Unsupported file extension')) {
      return genericBuiltInToolOutcome('get_function', err.message, 'error');
    }
    const msg = err instanceof Error ? err.message : String(err);
    return genericBuiltInToolOutcome('get_function', msg, 'error');
  }
};

function clearFunctionHashesWithPrefix(prefix: string): void {
  for (const key of sentHashes.keys()) {
    if (key.startsWith(prefix)) sentHashes.delete(key);
  }
}

function readFunctionHash(key: string): string | undefined {
  const hash = sentHashes.get(key);
  if (hash === undefined) return undefined;
  // Map insertion order forms a compact LRU policy.
  sentHashes.delete(key);
  sentHashes.set(key, hash);
  return hash;
}

function storeFunctionHash(key: string, hash: string): void {
  sentHashes.delete(key);
  sentHashes.set(key, hash);
  while (sentHashes.size > MAX_SENT_HASHES) {
    const oldestKey = sentHashes.keys().next().value;
    if (oldestKey === undefined) return;
    sentHashes.delete(oldestKey);
  }
}

