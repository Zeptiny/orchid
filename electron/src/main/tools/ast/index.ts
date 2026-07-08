/**
 * AST tools — exports and registration.
 *
 * All 5 AST tools: get_file_skeleton, get_function, find_symbol_references,
 * replace_symbol, rename_symbol.
 *
 * Usage:
 *   import { registerAstTools } from './tools/ast';
 *   registerAstTools(toolRegistry);
 */
import type { ToolRegistry } from '../registry';
import {
  getFileSkeletonDefinition,
  getFileSkeletonHandler,
} from './get-file-skeleton';
import {
  getFunctionDefinition,
  getFunctionHandler,
} from './get-function';
import {
  findSymbolReferencesDefinition,
  findSymbolReferencesHandler,
} from './find-symbol-references';
import {
  replaceSymbolDefinition,
  replaceSymbolHandler,
} from './replace-symbol';
import {
  renameSymbolDefinition,
  renameSymbolHandler,
} from './rename-symbol';

/**
 * Register all AST tools with the given registry.
 */
export function registerAstTools(registry: ToolRegistry): void {
  registry.register(getFileSkeletonDefinition, getFileSkeletonHandler);
  registry.register(getFunctionDefinition, getFunctionHandler);
  registry.register(findSymbolReferencesDefinition, findSymbolReferencesHandler);
  registry.register(replaceSymbolDefinition, replaceSymbolHandler);
  registry.register(renameSymbolDefinition, renameSymbolHandler);
}

// Re-export definitions and handlers for direct use
export {
  getFileSkeletonDefinition,
  getFileSkeletonHandler,
  getFileSkeletonSchema,
} from './get-file-skeleton';

export {
  getFunctionDefinition,
  getFunctionHandler,
  getFunctionSchema,
  clearFunctionHashes,
} from './get-function';

export {
  findSymbolReferencesDefinition,
  findSymbolReferencesHandler,
  findSymbolReferencesSchema,
} from './find-symbol-references';

export {
  replaceSymbolDefinition,
  replaceSymbolHandler,
  replaceSymbolSchema,
} from './replace-symbol';

export {
  renameSymbolDefinition,
  renameSymbolHandler,
  renameSymbolSchema,
} from './rename-symbol';
