/**
 * Tool registry — exports and singleton access.
 *
 * Usage:
 *   import { toolRegistry } from './tools';
 *   toolRegistry.register(myToolDefinition, myHandler);
 *
 * Each tool module exports a ToolDefinition and async handler.
 * The registry is a singleton (one instance in the main process).
 */
import { ToolRegistry } from './registry';
import type { ToolDefinition, ToolHandler, RegisteredTool } from './types';

/** Singleton registry instance for the main process */
export const toolRegistry = new ToolRegistry();

export { ToolRegistry } from './registry';
export type { ToolDefinition, ToolHandler, RegisteredTool } from './types';
