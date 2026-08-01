/**
 * Registry for handlers that are safe to execute inside a Node worker thread.
 *
 * Keep this module independent from the full built-in registry: that surface
 * owns Electron-only UI, credential, provider, session, and subagent services
 * that are unavailable in packaged worker threads.
 */
import { ToolRegistry } from './registry';
import { readDefinition, readHandler } from './filesystem/read';
import { globDefinition, globHandler } from './filesystem/glob';
import { grepToolDefinition, grepHandler } from './search/grep';
import { ragSearchDefinition, ragSearchHandler } from './rag/search';
import {
  getFileSkeletonDefinition,
  getFileSkeletonHandler,
} from './ast/get-file-skeleton';
import {
  replaceSymbolDefinition,
  replaceSymbolHandler,
} from './ast/replace-symbol';

/** Build the worker-local registry containing every and only offloaded tools. */
export function createToolWorkerRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readDefinition, readHandler);
  registry.register(globDefinition, globHandler);
  registry.register(grepToolDefinition, grepHandler);
  registry.register(ragSearchDefinition, ragSearchHandler);
  registry.register(getFileSkeletonDefinition, getFileSkeletonHandler);
  registry.register(replaceSymbolDefinition, replaceSymbolHandler);
  return registry;
}
