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
import type { ToolDefinition, ToolHandler } from './types';
import type { Agent } from '../../shared/types/agent';
import type { Skill } from '../../shared/types/skill';
import type { MCPManager } from '../mcp/manager';
import { readDefinition, readHandler } from './filesystem/read';
import { editDefinition, editHandler } from './filesystem/edit';
import { writeDefinition, writeHandler } from './filesystem/write';
import { readDirectoryDefinition, readDirectoryHandler } from './filesystem/read-directory';
import { globDefinition, globHandler } from './filesystem/glob';
import { grepToolDefinition, grepHandler } from './search/grep';
import { ragSearchDefinition, ragSearchHandler } from './rag/search';
import { ragIndexDefinition, ragIndexHandler } from './rag';
import {
  executeCommandToolDefinition,
  executeCommandHandler,
} from './process/execute-command';
import { readOutputToolDefinition, readOutputHandler } from './process/read-output';
import { sendInputToolDefinition, sendInputHandler } from './process/send-input';
import {
  terminateCommandToolDefinition,
  terminateCommandHandler,
} from './process/terminate-command';
import { registerAstTools } from './ast';
import { TodoStore } from './todo/store';
import { buildCreateTool } from './todo/create';
import { buildUpdateTool } from './todo/update';
import { buildListTool } from './todo/list';
import { buildDeleteTool } from './todo/delete';
import { buildWebFetchTool } from './web/fetch';
import { buildSkillTool } from './skill/skill';
import { buildMcpResourceTool } from './mcp/resource';
import { buildDelegateTool } from './subagent/delegate';
import { buildWaitTool } from './subagent/wait';
import { buildInterruptTool } from './subagent/interrupt';
import { SubagentManager } from '../agents/manager';

/** Singleton registry instance for the main process */
export const toolRegistry = new ToolRegistry();

interface BuiltinToolContext {
  agents: Map<string, Agent>;
  skills: Map<string, Skill>;
  todoStore: TodoStore;
  subagentManager: SubagentManager;
  mcpManager: MCPManager | null;
}

export type BuiltinToolOptions = Partial<BuiltinToolContext>;

const fallbackMcpManager = {
  getResourceServer: () => undefined,
  readResource: async () => {
    throw new Error('MCP manager is not available.');
  },
} as unknown as MCPManager;

const builtinContext: BuiltinToolContext = {
  agents: new Map(),
  skills: new Map(),
  todoStore: new TodoStore(),
  subagentManager: new SubagentManager(),
  mcpManager: null,
};

function registerBuiltTool(
  definition: ToolDefinition,
  handler: ToolHandler,
): void {
  toolRegistry.register(definition, handler);
}

/**
 * Register all built-in tools in the singleton registry.
 *
 * This function is intentionally idempotent: it clears the registry, merges any
 * new dynamic context, and then re-registers the full built-in tool surface.
 */
export function registerBuiltinTools(options: BuiltinToolOptions = {}): void {
  Object.assign(builtinContext, options);
  toolRegistry.reset();

  registerBuiltTool(readDefinition, readHandler);
  registerBuiltTool(editDefinition, editHandler);
  registerBuiltTool(writeDefinition, writeHandler);
  registerBuiltTool(readDirectoryDefinition, readDirectoryHandler);
  registerBuiltTool(globDefinition, globHandler);
  registerBuiltTool(grepToolDefinition, grepHandler);
  registerBuiltTool(ragSearchDefinition, ragSearchHandler);
  registerBuiltTool(ragIndexDefinition, ragIndexHandler);
  registerBuiltTool(executeCommandToolDefinition, executeCommandHandler);
  registerBuiltTool(readOutputToolDefinition, readOutputHandler);
  registerBuiltTool(sendInputToolDefinition, sendInputHandler);
  registerBuiltTool(terminateCommandToolDefinition, terminateCommandHandler);
  registerAstTools(toolRegistry);

  const todoCreate = buildCreateTool(builtinContext.todoStore);
  registerBuiltTool(todoCreate.definition, todoCreate.handler);
  const todoUpdate = buildUpdateTool(builtinContext.todoStore);
  registerBuiltTool(todoUpdate.definition, todoUpdate.handler);
  const todoList = buildListTool(builtinContext.todoStore);
  registerBuiltTool(todoList.definition, todoList.handler);
  const todoDelete = buildDeleteTool(builtinContext.todoStore);
  registerBuiltTool(todoDelete.definition, todoDelete.handler);

  const webFetch = buildWebFetchTool();
  registerBuiltTool(webFetch.definition, webFetch.handler);

  const delegate = buildDelegateTool(
    builtinContext.agents,
    builtinContext.subagentManager,
  );
  registerBuiltTool(delegate.definition, delegate.handler);
  const wait = buildWaitTool(builtinContext.subagentManager);
  registerBuiltTool(wait.definition, wait.handler);
  const interrupt = buildInterruptTool(builtinContext.subagentManager);
  registerBuiltTool(interrupt.definition, interrupt.handler);

  const skill = buildSkillTool(builtinContext.skills);
  registerBuiltTool(skill.definition, skill.handler);

  const mcpResource = buildMcpResourceTool(
    builtinContext.mcpManager ?? fallbackMcpManager,
  );
  registerBuiltTool(mcpResource.definition, mcpResource.handler);
}

export { ToolRegistry } from './registry';
export type { ToolDefinition, ToolHandler, RegisteredTool } from './types';
