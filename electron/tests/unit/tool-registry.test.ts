/**
 * Tests for the Zod Tool Registry Framework.
 *
 * Covers: registration, lookup, glob-based filtering, JSON Schema generation,
 * reset behavior, and error cases.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/main/tools/registry';
import type { ToolDefinition, ToolHandler } from '../../src/main/tools/types';

// ── Test fixtures ───────────────────────────────────────────────────────────

const readInputSchema = z.object({
  file_path: z.string().describe('Path to the file to read'),
  offset: z.number().optional().describe('Line number to start from'),
  limit: z.number().optional().describe('Max lines to read'),
});

const grepInputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  directory_path: z.string().describe('Directory to search in'),
  include_pattern: z.string().optional().describe('Glob filter for files'),
});

const editInputSchema = z.object({
  file_path: z.string().describe('Path to the file to edit'),
  old_string: z.string().describe('Exact string to replace'),
  new_string: z.string().describe('Replacement string'),
  replace_all: z.boolean().optional().describe('Replace all occurrences'),
});

const context7ResolveSchema = z.object({
  libraryName: z.string().describe('Library name to resolve'),
  query: z.string().describe('Search query'),
});

const context7QuerySchema = z.object({
  libraryId: z.string().describe('Context7 library ID'),
  query: z.string().describe('Documentation query'),
});

const dummyHandler: ToolHandler = async (input, _ctx) => ({ result: input });

function makeReadTool(): ToolDefinition {
  return {
    name: 'read',
    description: 'Read file contents with optional offset and limit',
    inputSchema: readInputSchema,
    actionLabel: 'Reading file',
    category: 'filesystem',
  };
}

function makeGrepTool(): ToolDefinition {
  return {
    name: 'grep',
    description: 'Search file contents using regex',
    inputSchema: grepInputSchema,
    actionLabel: 'Grepping',
    category: 'search',
  };
}

function makeEditTool(): ToolDefinition {
  return {
    name: 'edit',
    description: 'Replace an exact string match in a file',
    inputSchema: editInputSchema,
    actionLabel: 'Editing file',
    category: 'filesystem',
  };
}

function makeMcpContext7ResolveTool(): ToolDefinition {
  return {
    name: 'mcp::context7::resolve-library-id',
    description: 'Resolve a library name to a Context7 library ID',
    inputSchema: context7ResolveSchema,
    category: 'mcp',
  };
}

function makeMcpContext7QueryTool(): ToolDefinition {
  return {
    name: 'mcp::context7::query-docs',
    description: 'Query documentation from Context7',
    inputSchema: context7QuerySchema,
    category: 'mcp',
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // -- Registration & Lookup -------------------------------------------------

  describe('register and get', () => {
    it('should register a tool and retrieve it by name', () => {
      const def = makeReadTool();
      registry.register(def, dummyHandler);

      const result = registry.get('read');
      expect(result).toBeDefined();
      expect(result!.definition.name).toBe('read');
      expect(result!.definition.description).toBe(def.description);
      expect(result!.handler).toBe(dummyHandler);
    });

    it('should return undefined for unknown tool names', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should throw when registering a tool with duplicate name', () => {
      registry.register(makeReadTool(), dummyHandler);
      expect(() => registry.register(makeReadTool(), dummyHandler)).toThrowError(
        'Tool "read" is already registered',
      );
    });
  });

  // -- has() -----------------------------------------------------------------

  describe('has', () => {
    it('should return true for registered tools', () => {
      registry.register(makeReadTool(), dummyHandler);
      expect(registry.has('read')).toBe(true);
    });

    it('should return false for unregistered tools', () => {
      expect(registry.has('read')).toBe(false);
    });
  });

  // -- listAll() -------------------------------------------------------------

  describe('listAll', () => {
    it('should return empty array when no tools registered', () => {
      expect(registry.listAll()).toEqual([]);
    });

    it('should return all registered tools', () => {
      registry.register(makeReadTool(), dummyHandler);
      registry.register(makeGrepTool(), dummyHandler);
      registry.register(makeEditTool(), dummyHandler);

      const all = registry.listAll();
      expect(all).toHaveLength(3);
      const names = all.map((t) => t.definition.name);
      expect(names).toContain('read');
      expect(names).toContain('grep');
      expect(names).toContain('edit');
    });
  });

  // -- filter() with exact names ---------------------------------------------

  describe('filter with exact names', () => {
    beforeEach(() => {
      registry.register(makeReadTool(), dummyHandler);
      registry.register(makeGrepTool(), dummyHandler);
      registry.register(makeEditTool(), dummyHandler);
    });

    it('should filter by exact tool names', () => {
      const result = registry.filter(['read', 'grep']);
      expect(result).toHaveLength(2);
      const names = result.map((t) => t.definition.name);
      expect(names).toContain('read');
      expect(names).toContain('grep');
      expect(names).not.toContain('edit');
    });

    it('should return empty for non-matching exact names', () => {
      const result = registry.filter(['nonexistent']);
      expect(result).toHaveLength(0);
    });
  });

  // -- filter() with glob patterns -------------------------------------------

  describe('filter with glob patterns', () => {
    it('should match all tools with *', () => {
      registry.register(makeReadTool(), dummyHandler);
      registry.register(makeGrepTool(), dummyHandler);
      registry.register(makeEditTool(), dummyHandler);

      const result = registry.filter(['*']);
      expect(result).toHaveLength(3);
    });

    it('should match prefixed tools with read*', () => {
      registry.register(makeReadTool(), dummyHandler);
      registry.register(
        {
          name: 'read_directory',
          description: 'Read directory tree',
          inputSchema: z.object({ path: z.string() }),
          category: 'filesystem',
        },
        dummyHandler,
      );
      registry.register(
        {
          name: 'read_output',
          description: 'Read command output',
          inputSchema: z.object({ id: z.string() }),
          category: 'process',
        },
        dummyHandler,
      );
      registry.register(makeGrepTool(), dummyHandler);

      const result = registry.filter(['read*']);
      expect(result).toHaveLength(3);
      const names = result.map((t) => t.definition.name);
      expect(names).toContain('read');
      expect(names).toContain('read_directory');
      expect(names).toContain('read_output');
      expect(names).not.toContain('grep');
    });

    it('should match MCP tools with mcp::context7::*', () => {
      registry.register(makeReadTool(), dummyHandler);
      registry.register(makeMcpContext7ResolveTool(), dummyHandler);
      registry.register(makeMcpContext7QueryTool(), dummyHandler);

      const result = registry.filter(['mcp::context7::*']);
      expect(result).toHaveLength(2);
      const names = result.map((t) => t.definition.name);
      expect(names).toContain('mcp::context7::resolve-library-id');
      expect(names).toContain('mcp::context7::query-docs');
      expect(names).not.toContain('read');
    });

    it('should match mcp::* for all MCP tools across providers', () => {
      registry.register(makeReadTool(), dummyHandler);
      registry.register(makeMcpContext7ResolveTool(), dummyHandler);
      registry.register(
        {
          name: 'mcp::tavily::search',
          description: 'Search the web via Tavily',
          inputSchema: z.object({ query: z.string() }),
          category: 'mcp',
        },
        dummyHandler,
      );

      const result = registry.filter(['mcp::*']);
      expect(result).toHaveLength(2);
      const names = result.map((t) => t.definition.name);
      expect(names).toContain('mcp::context7::resolve-library-id');
      expect(names).toContain('mcp::tavily::search');
    });

    it('should handle mixed exact names and glob patterns', () => {
      registry.register(makeReadTool(), dummyHandler);
      registry.register(makeGrepTool(), dummyHandler);
      registry.register(makeEditTool(), dummyHandler);
      registry.register(makeMcpContext7ResolveTool(), dummyHandler);

      const result = registry.filter(['grep', 'mcp::*']);
      expect(result).toHaveLength(2);
      const names = result.map((t) => t.definition.name);
      expect(names).toContain('grep');
      expect(names).toContain('mcp::context7::resolve-library-id');
    });

    it('should return empty for non-matching glob patterns', () => {
      registry.register(makeReadTool(), dummyHandler);

      const result = registry.filter(['write_*']);
      expect(result).toHaveLength(0);
    });
  });

  // -- toJsonSchema() --------------------------------------------------------

  describe('toJsonSchema', () => {
    it('should return empty object when no tools registered', () => {
      expect(registry.toJsonSchema()).toEqual({});
    });

    it('should convert zod schemas to JSON Schema format', () => {
      registry.register(makeReadTool(), dummyHandler);

      const schemas = registry.toJsonSchema();
      expect(schemas).toHaveProperty('read');

      const readSchema = schemas['read'] as Record<string, unknown>;
      expect(readSchema.name).toBe('read');
      expect(readSchema.description).toBe('Read file contents with optional offset and limit');
      expect(readSchema.actionLabel).toBe('Reading file');
      expect(readSchema.category).toBe('filesystem');

      // JSON Schema derived from zod should have the right structure
      const inputSchema = readSchema.inputSchema as Record<string, unknown>;
      expect(inputSchema).toBeDefined();
      expect(inputSchema).toHaveProperty('type', 'object');
      expect(inputSchema).toHaveProperty('properties');
    });

    it('should include all registered tools in JSON Schema output', () => {
      registry.register(makeReadTool(), dummyHandler);
      registry.register(makeGrepTool(), dummyHandler);
      registry.register(makeEditTool(), dummyHandler);

      const schemas = registry.toJsonSchema();
      expect(Object.keys(schemas)).toHaveLength(3);
      expect(schemas).toHaveProperty('read');
      expect(schemas).toHaveProperty('grep');
      expect(schemas).toHaveProperty('edit');
    });

    it('should produce valid JSON Schema with required/optional fields', () => {
      registry.register(makeReadTool(), dummyHandler);

      const schemas = registry.toJsonSchema();
      const inputSchema = schemas['read']!.inputSchema as Record<string, unknown>;

      // file_path is required, offset/limit are optional
      expect(inputSchema).toHaveProperty('required');
      const required = inputSchema.required as string[];
      expect(required).toContain('file_path');
      expect(required).not.toContain('offset');
      expect(required).not.toContain('limit');
    });

    it('should omit actionLabel when not set', () => {
      registry.register(makeMcpContext7ResolveTool(), dummyHandler);

      const schemas = registry.toJsonSchema();
      const mcpSchema = schemas['mcp::context7::resolve-library-id'] as Record<string, unknown>;
      // actionLabel is not set on MCP tools, so it should be absent
      expect(mcpSchema).not.toHaveProperty('actionLabel');
    });
  });

  // -- reset() ---------------------------------------------------------------

  describe('reset', () => {
    it('should clear all registered tools', () => {
      registry.register(makeReadTool(), dummyHandler);
      registry.register(makeGrepTool(), dummyHandler);
      expect(registry.listAll()).toHaveLength(2);

      registry.reset();
      expect(registry.listAll()).toHaveLength(0);
      expect(registry.get('read')).toBeUndefined();
      expect(registry.has('read')).toBe(false);
    });

    it('should allow re-registration after reset', () => {
      registry.register(makeReadTool(), dummyHandler);
      registry.reset();

      // Should not throw — registry was cleared
      registry.register(makeReadTool(), dummyHandler);
      expect(registry.has('read')).toBe(true);
    });
  });

  // -- Edge cases ------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty filter array', () => {
      registry.register(makeReadTool(), dummyHandler);
      const result = registry.filter([]);
      expect(result).toHaveLength(0);
    });

    it('should preserve handler reference integrity', async () => {
      const customHandler: ToolHandler = async (input, _ctx) => ({
        processed: true,
        data: input,
      });
      registry.register(makeReadTool(), customHandler);

      const tool = registry.get('read')!;
      const result = await tool.handler(
        { file_path: '/test' },
        { cwd: '/tmp' },
      );
      expect(result).toEqual({ processed: true, data: { file_path: '/test' } });
    });

    it('should support tools with outputSchema', () => {
      const outputSchema = z.object({
        content: z.string(),
        lineCount: z.number(),
      });
      registry.register(
        {
          ...makeReadTool(),
          outputSchema,
        },
        dummyHandler,
      );

      const tool = registry.get('read')!;
      expect(tool.definition.outputSchema).toBeDefined();
    });
  });
});
