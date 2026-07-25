/**
 * Tool Registry — singleton registry for zod-defined tools.
 *
 * Provides registration, lookup, glob-based filtering, and JSON Schema
 * generation for LLM function-calling and MCP exposure.
 */
import { minimatch } from 'minimatch';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { type ZodError } from 'zod';
import type { ToolDefinition, ToolHandler, RegisteredTool } from './types';
import {
  createToolExecutionResultSchema,
  type AgentProjector,
  type ToolResultFamily,
} from '../../shared/types/tool-result';
import {
  defaultFamilyAgentProjectors,
  genericAgentProjector,
} from './result';

export interface ResolvedAgentProjector {
  projector: AgentProjector;
  source: 'tool' | 'family' | 'generic';
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private familyAgentProjectors = new Map<ToolResultFamily, AgentProjector>(
    defaultFamilyAgentProjectors,
  );
  private genericAgentProjector: AgentProjector = genericAgentProjector;

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

  /** Register or replace the code-owned default projector for one family. */
  registerFamilyAgentProjector(
    family: ToolResultFamily,
    projector: AgentProjector,
  ): void {
    this.familyAgentProjectors.set(family, projector);
  }

  /** Replace the generic-family projector (primarily for composition/tests). */
  setGenericAgentProjector(projector: AgentProjector): void {
    this.genericAgentProjector = projector;
  }

  /** Tool override > explicit family default > generic fallback. */
  resolveAgentProjector(toolName: string): ResolvedAgentProjector {
    const definition = this.tools.get(toolName)?.definition;
    if (definition?.agentProjector) {
      return { projector: definition.agentProjector, source: 'tool' };
    }
    if (definition?.resultFamily) {
      const familyProjector = this.familyAgentProjectors.get(
        definition.resultFamily,
      );
      if (familyProjector) {
        return { projector: familyProjector, source: 'family' };
      }
    }
    return { projector: this.genericAgentProjector, source: 'generic' };
  }

  /**
   * Generate the AI SDK raw execution-result schema from the tool's canonical
   * data metadata.
   */
  getToolExecutionResultSchema(toolName: string) {
    const definition = this.tools.get(toolName)?.definition;
    if (!definition) return undefined;
    return createToolExecutionResultSchema(
      definition.outputDataSchema,
      definition.resultFamily,
    );
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
   * Empty allowlist (`[]`) means no tools — not all tools. Agents that need
   * every tool must pass `['*']` explicitly.
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
        inputSchema: zodToJsonSchema(definition.inputSchema as any), // eslint-disable-line @typescript-eslint/no-explicit-any
        ...(definition.category && { category: definition.category }),
        ...(definition.noTimeout !== undefined && { noTimeout: definition.noTimeout }),
        resultFamily: definition.resultFamily,
      };
    }
    return schemas;
  }

  /**
   * Validate tool arguments against its Zod input schema.
   *
   * Returns `{ ok: true, data }` on success with the parsed/typed data,
   * or `{ ok: false, error }` with a human-readable error message on failure.
   *
   * This is used by the tool execution pipeline to reject malformed
   * tool calls from the LLM before they reach the handler.
   */
  validate(
    toolName: string,
    args: unknown,
  ): { ok: true; data: unknown } | { ok: false; error: string } {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { ok: false, error: `Tool '${toolName}' not found` };
    }

    const result = tool.definition.inputSchema.safeParse(args);
    if (result.success) {
      return { ok: true, data: result.data };
    }

    // Format Zod errors into a human-readable message for the LLM
    const issues = result.error.issues
      .map((issue: ZodError['issues'][number]) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('; ');

    return { ok: false, error: `Invalid arguments: ${issues}` };
  }

  /**
   * Clear all registered tools.
   * Call after config changes to rebuild on next access.
   */
  reset(): void {
    this.tools.clear();
  }
}
