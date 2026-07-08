/**
 * Tool Parity Tests — U28.
 *
 * Verifies that all 27 tools from the Python TUI are ported to the TS/Electron app.
 * Tests STRUCTURE only (definitions exist, schemas valid, handlers present), not behavior.
 *
 * Tool categories:
 * - Static tools: exported with definition + handler from their module
 * - Dynamic tools: built via builder functions (todo_*, subagent_*, web_fetch, skill, mcp_resource)
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ── Static tool imports ─────────────────────────────────────────────────────

import { readDefinition, readHandler } from '../../src/main/tools/filesystem/read';
import { editDefinition, editHandler } from '../../src/main/tools/filesystem/edit';
import { writeDefinition, writeHandler } from '../../src/main/tools/filesystem/write';
import { readDirectoryDefinition, readDirectoryHandler } from '../../src/main/tools/filesystem/read-directory';
import { globDefinition, globHandler } from '../../src/main/tools/filesystem/glob';
import { grepToolDefinition, grepHandler } from '../../src/main/tools/search/grep';
import { ragSearchDefinition, ragSearchHandler } from '../../src/main/tools/rag/search';
import { ragIndexDefinition, ragIndexHandler } from '../../src/main/tools/rag/index';
import { executeCommandToolDefinition, executeCommandHandler } from '../../src/main/tools/process/execute-command';
import { readOutputToolDefinition, readOutputHandler } from '../../src/main/tools/process/read-output';
import { sendInputToolDefinition, sendInputHandler } from '../../src/main/tools/process/send-input';
import { terminateCommandToolDefinition, terminateCommandHandler } from '../../src/main/tools/process/terminate-command';
import {
  getFileSkeletonDefinition,
  getFileSkeletonHandler,
} from '../../src/main/tools/ast/get-file-skeleton';
import {
  getFunctionDefinition,
  getFunctionHandler,
} from '../../src/main/tools/ast/get-function';
import {
  findSymbolReferencesDefinition,
  findSymbolReferencesHandler,
} from '../../src/main/tools/ast/find-symbol-references';
import {
  replaceSymbolDefinition,
  replaceSymbolHandler,
} from '../../src/main/tools/ast/replace-symbol';
import {
  renameSymbolDefinition,
  renameSymbolHandler,
} from '../../src/main/tools/ast/rename-symbol';

// ── Dynamic tool builders ───────────────────────────────────────────────────

import { buildCreateTool } from '../../src/main/tools/todo/create';
import { buildUpdateTool } from '../../src/main/tools/todo/update';
import { buildListTool } from '../../src/main/tools/todo/list';
import { buildDeleteTool } from '../../src/main/tools/todo/delete';
import { buildWebFetchTool } from '../../src/main/tools/web/fetch';
import { buildSkillTool } from '../../src/main/tools/skill/skill';
import { buildMcpResourceTool } from '../../src/main/tools/mcp/resource';
import { buildDelegateTool } from '../../src/main/tools/subagent/delegate';
import { buildWaitTool } from '../../src/main/tools/subagent/wait';
import { buildInterruptTool } from '../../src/main/tools/subagent/interrupt';

// ── Expected tool names (27 total) ─────────────────────────────────────────

const EXPECTED_TOOL_NAMES = [
  // Filesystem (5)
  'read',
  'edit',
  'write',
  'read_directory',
  'glob',
  // Search (1)
  'grep',
  // RAG (2)
  'rag_search',
  'rag_index',
  // Todo (4)
  'todo_create',
  'todo_update',
  'todo_list',
  'todo_delete',
  // Process (4)
  'execute_command',
  'read_output',
  'send_input',
  'terminate_command',
  // Web (1)
  'web_fetch',
  // Subagent (3)
  'delegate_to_subagent',
  'wait_for_subagent',
  'interrupt_subagents',
  // Skill (1)
  'skill',
  // MCP (1)
  'read_mcp_resource',
  // AST (5)
  'get_file_skeleton',
  'get_function',
  'find_symbol_references',
  'replace_symbol',
  'rename_symbol',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Validate that a zod schema produces valid JSON Schema. */
function expectValidJsonSchema(schema: z.ZodType, toolName: string): void {
  const jsonSchema = zodToJsonSchema(schema);
  expect(jsonSchema).toBeDefined();
  expect(typeof jsonSchema).toBe('object');
  // Must have type: object for tool input schemas
  expect(jsonSchema).toHaveProperty('type', 'object');
  expect(jsonSchema).toHaveProperty('properties');
}

/** Validate a tool definition has all required fields. */
function expectValidDefinition(def: { name: string; description: string; inputSchema: z.ZodType; category: string }, expectedName: string): void {
  expect(def.name).toBe(expectedName);
  expect(def.description).toBeTruthy();
  expect(def.description.length).toBeGreaterThan(10);
  expect(def.inputSchema).toBeDefined();
  expect(def.category).toBeTruthy();
}

/** Validate a tool handler is a function. */
function expectValidHandler(handler: unknown): void {
  expect(typeof handler).toBe('function');
}

// ── Static Tool Tests ───────────────────────────────────────────────────────

describe('Static Tool Definitions', () => {
  describe('filesystem tools (5)', () => {
    it('read has valid definition, schema, and handler', () => {
      expectValidDefinition(readDefinition, 'read');
      expectValidJsonSchema(readDefinition.inputSchema, 'read');
      expectValidHandler(readHandler);
      expect(readDefinition.category).toBe('filesystem');
    });

    it('edit has valid definition, schema, and handler', () => {
      expectValidDefinition(editDefinition, 'edit');
      expectValidJsonSchema(editDefinition.inputSchema, 'edit');
      expectValidHandler(editHandler);
      expect(editDefinition.category).toBe('filesystem');
    });

    it('write has valid definition, schema, and handler', () => {
      expectValidDefinition(writeDefinition, 'write');
      expectValidJsonSchema(writeDefinition.inputSchema, 'write');
      expectValidHandler(writeHandler);
      expect(writeDefinition.category).toBe('filesystem');
    });

    it('read_directory has valid definition, schema, and handler', () => {
      expectValidDefinition(readDirectoryDefinition, 'read_directory');
      expectValidJsonSchema(readDirectoryDefinition.inputSchema, 'read_directory');
      expectValidHandler(readDirectoryHandler);
      expect(readDirectoryDefinition.category).toBe('filesystem');
    });

    it('glob has valid definition, schema, and handler', () => {
      expectValidDefinition(globDefinition, 'glob');
      expectValidJsonSchema(globDefinition.inputSchema, 'glob');
      expectValidHandler(globHandler);
      expect(globDefinition.category).toBe('filesystem');
    });
  });

  describe('search tools (1)', () => {
    it('grep has valid definition, schema, and handler', () => {
      expectValidDefinition(grepToolDefinition, 'grep');
      expectValidJsonSchema(grepToolDefinition.inputSchema, 'grep');
      expectValidHandler(grepHandler);
      expect(grepToolDefinition.category).toBe('search');
    });
  });

  describe('RAG tools (2)', () => {
    it('rag_search has valid definition, schema, and handler', () => {
      expectValidDefinition(ragSearchDefinition, 'rag_search');
      expectValidJsonSchema(ragSearchDefinition.inputSchema, 'rag_search');
      expectValidHandler(ragSearchHandler);
      expect(ragSearchDefinition.category).toBe('rag');
    });

    it('rag_index has valid definition, schema, and handler', () => {
      expectValidDefinition(ragIndexDefinition, 'rag_index');
      expectValidJsonSchema(ragIndexDefinition.inputSchema, 'rag_index');
      expectValidHandler(ragIndexHandler);
      expect(ragIndexDefinition.category).toBe('rag');
    });
  });

  describe('process tools (4)', () => {
    it('execute_command has valid definition, schema, and handler', () => {
      expectValidDefinition(executeCommandToolDefinition, 'execute_command');
      expectValidJsonSchema(executeCommandToolDefinition.inputSchema, 'execute_command');
      expectValidHandler(executeCommandHandler);
      expect(executeCommandToolDefinition.category).toBe('process');
    });

    it('read_output has valid definition, schema, and handler', () => {
      expectValidDefinition(readOutputToolDefinition, 'read_output');
      expectValidJsonSchema(readOutputToolDefinition.inputSchema, 'read_output');
      expectValidHandler(readOutputHandler);
      expect(readOutputToolDefinition.category).toBe('process');
    });

    it('send_input has valid definition, schema, and handler', () => {
      expectValidDefinition(sendInputToolDefinition, 'send_input');
      expectValidJsonSchema(sendInputToolDefinition.inputSchema, 'send_input');
      expectValidHandler(sendInputHandler);
      expect(sendInputToolDefinition.category).toBe('process');
    });

    it('terminate_command has valid definition, schema, and handler', () => {
      expectValidDefinition(terminateCommandToolDefinition, 'terminate_command');
      expectValidJsonSchema(terminateCommandToolDefinition.inputSchema, 'terminate_command');
      expectValidHandler(terminateCommandHandler);
      expect(terminateCommandToolDefinition.category).toBe('process');
    });
  });

  describe('AST tools (5)', () => {
    it('get_file_skeleton has valid definition, schema, and handler', () => {
      expectValidDefinition(getFileSkeletonDefinition, 'get_file_skeleton');
      expectValidJsonSchema(getFileSkeletonDefinition.inputSchema, 'get_file_skeleton');
      expectValidHandler(getFileSkeletonHandler);
      expect(getFileSkeletonDefinition.category).toBe('ast');
    });

    it('get_function has valid definition, schema, and handler', () => {
      expectValidDefinition(getFunctionDefinition, 'get_function');
      expectValidJsonSchema(getFunctionDefinition.inputSchema, 'get_function');
      expectValidHandler(getFunctionHandler);
      expect(getFunctionDefinition.category).toBe('ast');
    });

    it('find_symbol_references has valid definition, schema, and handler', () => {
      expectValidDefinition(findSymbolReferencesDefinition, 'find_symbol_references');
      expectValidJsonSchema(findSymbolReferencesDefinition.inputSchema, 'find_symbol_references');
      expectValidHandler(findSymbolReferencesHandler);
      expect(findSymbolReferencesDefinition.category).toBe('ast');
    });

    it('replace_symbol has valid definition, schema, and handler', () => {
      expectValidDefinition(replaceSymbolDefinition, 'replace_symbol');
      expectValidJsonSchema(replaceSymbolDefinition.inputSchema, 'replace_symbol');
      expectValidHandler(replaceSymbolHandler);
      expect(replaceSymbolDefinition.category).toBe('ast');
    });

    it('rename_symbol has valid definition, schema, and handler', () => {
      expectValidDefinition(renameSymbolDefinition, 'rename_symbol');
      expectValidJsonSchema(renameSymbolDefinition.inputSchema, 'rename_symbol');
      expectValidHandler(renameSymbolHandler);
      expect(renameSymbolDefinition.category).toBe('ast');
    });
  });
});

// ── Dynamic Tool Builder Tests ──────────────────────────────────────────────

describe('Dynamic Tool Builders', () => {
  describe('todo tools (4)', () => {
    it('todo_create builder produces valid definition and handler', () => {
      const { definition, handler } = buildCreateTool({} as any);
      expectValidDefinition(definition, 'todo_create');
      expectValidJsonSchema(definition.inputSchema, 'todo_create');
      expectValidHandler(handler);
      expect(definition.category).toBe('todo');
    });

    it('todo_update builder produces valid definition and handler', () => {
      const { definition, handler } = buildUpdateTool({} as any);
      expectValidDefinition(definition, 'todo_update');
      expectValidJsonSchema(definition.inputSchema, 'todo_update');
      expectValidHandler(handler);
      expect(definition.category).toBe('todo');
    });

    it('todo_list builder produces valid definition and handler', () => {
      const { definition, handler } = buildListTool({} as any);
      expectValidDefinition(definition, 'todo_list');
      expectValidJsonSchema(definition.inputSchema, 'todo_list');
      expectValidHandler(handler);
      expect(definition.category).toBe('todo');
    });

    it('todo_delete builder produces valid definition and handler', () => {
      const { definition, handler } = buildDeleteTool({} as any);
      expectValidDefinition(definition, 'todo_delete');
      expectValidJsonSchema(definition.inputSchema, 'todo_delete');
      expectValidHandler(handler);
      expect(definition.category).toBe('todo');
    });
  });

  describe('web tools (1)', () => {
    it('web_fetch builder produces valid definition and handler', () => {
      const { definition, handler } = buildWebFetchTool();
      expectValidDefinition(definition, 'web_fetch');
      expectValidJsonSchema(definition.inputSchema, 'web_fetch');
      expectValidHandler(handler);
      expect(definition.category).toBe('web');
    });
  });

  describe('subagent tools (3)', () => {
    it('delegate_to_subagent builder produces valid definition and handler', () => {
      const { definition, handler } = buildDelegateTool(new Map(), {} as any);
      expectValidDefinition(definition, 'delegate_to_subagent');
      expectValidJsonSchema(definition.inputSchema, 'delegate_to_subagent');
      expectValidHandler(handler);
      expect(definition.category).toBe('subagent');
    });

    it('wait_for_subagent builder produces valid definition and handler', () => {
      const { definition, handler } = buildWaitTool({} as any);
      expectValidDefinition(definition, 'wait_for_subagent');
      expectValidJsonSchema(definition.inputSchema, 'wait_for_subagent');
      expectValidHandler(handler);
      expect(definition.category).toBe('subagent');
    });

    it('interrupt_subagents builder produces valid definition and handler', () => {
      const { definition, handler } = buildInterruptTool({} as any);
      expectValidDefinition(definition, 'interrupt_subagents');
      expectValidJsonSchema(definition.inputSchema, 'interrupt_subagents');
      expectValidHandler(handler);
      expect(definition.category).toBe('subagent');
    });
  });

  describe('skill tool (1)', () => {
    it('skill builder produces valid definition and handler', () => {
      const { definition, handler } = buildSkillTool(new Map());
      expectValidDefinition(definition, 'skill');
      expectValidJsonSchema(definition.inputSchema, 'skill');
      expectValidHandler(handler);
      expect(definition.category).toBe('skill');
    });
  });

  describe('MCP tools (1)', () => {
    it('read_mcp_resource builder produces valid definition and handler', () => {
      const { definition, handler } = buildMcpResourceTool({} as any);
      expectValidDefinition(definition, 'read_mcp_resource');
      expectValidJsonSchema(definition.inputSchema, 'read_mcp_resource');
      expectValidHandler(handler);
      expect(definition.category).toBe('mcp');
    });
  });
});

// ── Completeness Check ─────────────────────────────────────────────────────

describe('Tool Completeness', () => {
  it('all 27 expected tool names are defined in this test file', () => {
    // This test ensures we haven't accidentally removed a tool from our list.
    // If a new tool is added to the codebase, this list must be updated.
    expect(EXPECTED_TOOL_NAMES).toHaveLength(27);
  });

  it('static tool count matches expected', () => {
    // 5 filesystem + 1 search + 2 rag + 4 process + 5 ast = 17 static tools
    const staticDefinitions = [
      readDefinition,
      editDefinition,
      writeDefinition,
      readDirectoryDefinition,
      globDefinition,
      grepToolDefinition,
      ragSearchDefinition,
      ragIndexDefinition,
      executeCommandToolDefinition,
      readOutputToolDefinition,
      sendInputToolDefinition,
      terminateCommandToolDefinition,
      getFileSkeletonDefinition,
      getFunctionDefinition,
      findSymbolReferencesDefinition,
      replaceSymbolDefinition,
      renameSymbolDefinition,
    ];
    expect(staticDefinitions).toHaveLength(17);
    // All names should be unique
    const names = staticDefinitions.map((d) => d.name);
    expect(new Set(names).size).toBe(17);
  });

  it('all tool names are unique across static and dynamic tools', () => {
    const allNames = [
      readDefinition.name,
      editDefinition.name,
      writeDefinition.name,
      readDirectoryDefinition.name,
      globDefinition.name,
      grepToolDefinition.name,
      ragSearchDefinition.name,
      ragIndexDefinition.name,
      executeCommandToolDefinition.name,
      readOutputToolDefinition.name,
      sendInputToolDefinition.name,
      terminateCommandToolDefinition.name,
      getFileSkeletonDefinition.name,
      getFunctionDefinition.name,
      findSymbolReferencesDefinition.name,
      replaceSymbolDefinition.name,
      renameSymbolDefinition.name,
      // Dynamic tool names (from builder output)
      buildCreateTool({} as any).definition.name,
      buildUpdateTool({} as any).definition.name,
      buildListTool({} as any).definition.name,
      buildDeleteTool({} as any).definition.name,
      buildWebFetchTool().definition.name,
      buildSkillTool(new Map()).definition.name,
      buildMcpResourceTool({} as any).definition.name,
      buildDelegateTool(new Map(), {} as any).definition.name,
      buildWaitTool({} as any).definition.name,
      buildInterruptTool({} as any).definition.name,
    ];
    expect(allNames).toHaveLength(27);
    expect(new Set(allNames).size).toBe(27);
  });
});
