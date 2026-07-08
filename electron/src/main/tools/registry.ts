/**
 * Tool Registry — singleton registry for zod-defined tools.
 *
 * Provides registration, lookup, glob-based filtering, and JSON Schema
 * generation for LLM function-calling and MCP exposure.
 */
import { minimatch } from 'minimatch';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition, ToolHandler, RegisteredTool } from './types';

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  /**
   * Register a tool with its definition and handler.
   * Throws if a tool with the same name is already registered.
   */
  register(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered`);
    }
    this.tools.set(definition.name, { definition, handler });
  }

  /**
   * Get a registered tool by exact name.
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is registered by exact name.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Filter tools by glob patterns using minimatch.
   *
   * Patterns support the same syntax as Python's fnmatch:
   * - `*` → matches all tools
   * - `read*` → matches read, read_directory, read_output, read_mcp_resource
   * - `mcp::context7::*` → matches all context7 MCP tools
   * - `["read", "grep"]` → exact match for read and grep
   */
  filter(allowedTools: string[]): RegisteredTool[] {
    const all = this.listAll();
    if (allowedTools.length === 0) return [];

    return all.filter(({ definition }) =>
      allowedTools.some((pattern) => {
        // Exact match (no glob chars) — fast path
        if (!pattern.includes('*') && !pattern.includes('?') && !pattern.includes('[')) {
          return definition.name === pattern;
        }
        // Glob match via minimatch
        return minimatch(definition.name, pattern);
      }),
    );
  }

  /**
   * List all registered tools.
   */
  listAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Convert all registered tools to JSON Schema format for LLM function-calling.
   *
   * Returns an object mapping tool names to their JSON Schema representation,
   * suitable for MCP tool listing or LLM function-calling payloads.
   */
  toJsonSchema(): Record<string, unknown> {
    const schemas: Record<string, unknown> = {};
    for (const [name, { definition }] of this.tools) {
      schemas[name] = {
        name: definition.name,
        description: definition.description,
        inputSchema: zodToJsonSchema(definition.inputSchema),
        ...(definition.actionLabel && { actionLabel: definition.actionLabel }),
        ...(definition.category && { category: definition.category }),
        ...(definition.noTimeout !== undefined && { noTimeout: definition.noTimeout }),
      };
    }
    return schemas;
  }

  /**
   * Clear all registered tools.
   * Call after config changes to rebuild on next access.
   */
  reset(): void {
    this.tools.clear();
  }
}
