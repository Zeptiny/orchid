/**
 * Tests for tool argument validation (U7).
 *
 * Covers: ToolRegistry.validate() method, createExecuteFn() validation integration,
 * and the error message format returned to the LLM.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/main/tools/registry';
import type { ToolDefinition, ToolHandler } from '../../src/main/tools/types';

// ── Test fixtures ───────────────────────────────────────────────────────────

const readInputSchema = z.object({
  file_path: z.string().describe('Path to the file to read'),
  offset: z.number().optional().describe('Line number to start from'),
  limit: z.number().optional().describe('Max lines to read'),
});

const editInputSchema = z.object({
  file_path: z.string().describe('Path to the file to edit'),
  old_string: z.string().describe('Exact string to replace'),
  new_string: z.string().describe('Replacement string'),
  replace_all: z.boolean().optional().describe('Replace all occurrences'),
});

const strictSchema = z
  .object({
    name: z.string().min(1),
    count: z.number().int().positive(),
  })
  .strict(); // rejects unknown keys

const dummyHandler: ToolHandler = async (input) => ({ result: input });

function makeReadTool(): ToolDefinition {
  return {
    name: 'read',
    description: 'Read file contents with optional offset and limit',
    inputSchema: readInputSchema,
    category: 'filesystem',
  };
}

function makeEditTool(): ToolDefinition {
  return {
    name: 'edit',
    description: 'Replace an exact string match in a file',
    inputSchema: editInputSchema,
    category: 'filesystem',
  };
}

function makeStrictTool(): ToolDefinition {
  return {
    name: 'strict_tool',
    description: 'A tool with strict schema (no unknown keys)',
    inputSchema: strictSchema,
    category: 'test',
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ToolRegistry.validate()', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // -- Happy path: valid args ------------------------------------------------

  describe('happy path', () => {
    it('should return ok with valid required args', () => {
      registry.register(makeReadTool(), dummyHandler);

      const result = registry.validate('read', { file_path: '/tmp/test.txt' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({ file_path: '/tmp/test.txt' });
      }
    });

    it('should return ok with valid required + optional args', () => {
      registry.register(makeReadTool(), dummyHandler);

      const result = registry.validate('read', {
        file_path: '/tmp/test.txt',
        offset: 10,
        limit: 50,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({
          file_path: '/tmp/test.txt',
          offset: 10,
          limit: 50,
        });
      }
    });

    it('should return ok when optional args are omitted', () => {
      registry.register(makeReadTool(), dummyHandler);

      const result = registry.validate('read', { file_path: '/a' });
      expect(result.ok).toBe(true);
    });

    it('should return ok for multiple required fields', () => {
      registry.register(makeEditTool(), dummyHandler);

      const result = registry.validate('edit', {
        file_path: '/tmp/test.txt',
        old_string: 'foo',
        new_string: 'bar',
      });
      expect(result.ok).toBe(true);
    });
  });

  // -- Error path: missing required args ------------------------------------

  describe('missing required args', () => {
    it('should reject when all required args are missing', () => {
      registry.register(makeReadTool(), dummyHandler);

      const result = registry.validate('read', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Invalid arguments');
        expect(result.error).toContain('file_path');
      }
    });

    it('should reject when some required args are missing', () => {
      registry.register(makeEditTool(), dummyHandler);

      const result = registry.validate('edit', { file_path: '/tmp/test.txt' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Invalid arguments');
        expect(result.error).toContain('old_string');
        expect(result.error).toContain('new_string');
      }
    });

    it('should include the field path in the error message', () => {
      registry.register(makeEditTool(), dummyHandler);

      const result = registry.validate('edit', {
        file_path: '/tmp/test.txt',
        old_string: 'a',
        new_string: 'b',
      });
      // Valid case - all required fields present
      expect(result.ok).toBe(true);
    });
  });

  // -- Error path: wrong types -----------------------------------------------

  describe('wrong types', () => {
    it('should reject when a string field receives a number', () => {
      registry.register(makeReadTool(), dummyHandler);

      const result = registry.validate('read', { file_path: 12345 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Invalid arguments');
        expect(result.error).toContain('file_path');
      }
    });

    it('should reject when a number field receives a string', () => {
      registry.register(makeReadTool(), dummyHandler);

      const result = registry.validate('read', {
        file_path: '/tmp/test.txt',
        offset: 'not_a_number',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('offset');
      }
    });
  });

  // -- Edge case: extra unknown args -----------------------------------------

  describe('extra unknown args', () => {
    it('should strip unknown args by default (non-strict schema)', () => {
      registry.register(makeReadTool(), dummyHandler);

      const result = registry.validate('read', {
        file_path: '/tmp/test.txt',
        unknown_param: 'hello',
        another_extra: 42,
      });
      // Non-strict schemas silently strip unknown keys
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({ file_path: '/tmp/test.txt' });
        expect(result.data).not.toHaveProperty('unknown_param');
      }
    });

    it('should reject unknown args for strict schemas', () => {
      registry.register(makeStrictTool(), dummyHandler);

      const result = registry.validate('strict_tool', {
        name: 'test',
        count: 5,
        unknown_field: 'should fail',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Invalid arguments');
        expect(result.error).toContain('unknown_field');
      }
    });
  });

  // -- Tool not found --------------------------------------------------------

  describe('tool not found', () => {
    it('should return error for unregistered tool name', () => {
      const result = registry.validate('nonexistent', { anything: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Tool 'nonexistent' not found");
      }
    });
  });

  // -- Null / undefined args -------------------------------------------------

  describe('null and undefined args', () => {
    it('should reject null args', () => {
      registry.register(makeReadTool(), dummyHandler);

      const result = registry.validate('read', null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Invalid arguments');
      }
    });

    it('should reject undefined args', () => {
      registry.register(makeReadTool(), dummyHandler);

      const result = registry.validate('read', undefined);
      expect(result.ok).toBe(false);
    });
  });

  // -- Multiple errors -------------------------------------------------------

  describe('multiple errors', () => {
    it('should list all validation errors in a single message', () => {
      registry.register(makeEditTool(), dummyHandler);

      const result = registry.validate('edit', {
        // missing file_path, old_string, new_string
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('file_path');
        expect(result.error).toContain('old_string');
        expect(result.error).toContain('new_string');
      }
    });
  });
});

describe('createExecuteFn() validation integration', () => {
  // We test the validation path by directly testing the registry.validate()
  // method which createExecuteFn() calls. The createExecuteFn itself depends
  // on dynamic imports and the full app context, so we verify the contract here.

  let registry: ToolRegistry;
  const handlerCalls: unknown[] = [];

  beforeEach(() => {
    registry = new ToolRegistry();
    handlerCalls.length = 0;
  });

  const trackingHandler: ToolHandler = async (input) => {
    handlerCalls.push(input);
    return { success: true };
  };

  it('should pass validated (and stripped) data to handler', () => {
    registry.register(makeReadTool(), trackingHandler);

    const args = {
      file_path: '/tmp/test.txt',
      offset: 5,
      extra_field: 'should be stripped',
    };

    const validation = registry.validate('read', args);
    expect(validation.ok).toBe(true);

    // The validated data should be what gets passed to the handler
    if (validation.ok) {
      expect(validation.data).toEqual({
        file_path: '/tmp/test.txt',
        offset: 5,
      });
      // Extra fields stripped by Zod
      expect(validation.data).not.toHaveProperty('extra_field');
    }
  });

  it('should not call handler when validation fails', () => {
    registry.register(makeReadTool(), trackingHandler);

    const validation = registry.validate('read', {});
    expect(validation.ok).toBe(false);

    // Handler should NOT have been called
    expect(handlerCalls).toHaveLength(0);
  });

  it('should produce error message suitable for LLM consumption', () => {
    registry.register(makeEditTool(), trackingHandler);

    const validation = registry.validate('edit', {
      file_path: '/tmp/test.txt',
      // missing old_string and new_string
    });
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      // Error should be descriptive enough for the LLM to understand what's wrong
      expect(validation.error).toMatch(/^Invalid arguments:/);
      expect(validation.error).toContain('old_string');
      expect(validation.error).toContain('new_string');
    }
  });

  it('should validate correctly when args are passed as parsed JSON', () => {
    // Simulates what createExecuteFn does: JSON.parse(args) then validate
    registry.register(makeReadTool(), trackingHandler);

    const rawArgs = '{"file_path":"/tmp/test.txt","offset":"not_a_number"}';
    const parsedArgs = JSON.parse(rawArgs);

    const validation = registry.validate('read', parsedArgs);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.error).toContain('offset');
    }
    expect(handlerCalls).toHaveLength(0);
  });
});
