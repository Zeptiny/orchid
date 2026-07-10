/**
 * Core types for the Zod-based tool registry framework.
 *
 * Each tool is defined by a zod schema — single source of truth for:
 * - TypeScript types (via z.infer)
 * - Runtime validation (zod parse)
 * - JSON Schema generation (zod-to-json-schema)
 * - MCP exposure and LLM function-calling
 */
import { z } from 'zod';

/**
 * Defines a tool's metadata and schema.
 * The inputSchema zod object is the single source of truth —
 * TS types, IPC validation, and JSON Schema all derive from it.
 */
export interface ToolDefinition {
  /** Unique tool name (e.g., 'read', 'grep', 'mcp::context7::resolve-library-id') */
  name: string;

  /** Human-readable description for LLM consumption */
  description: string;

  /** Zod schema for tool input — single source of truth */
  inputSchema: z.ZodType;

  /** Optional zod schema for tool output */
  outputSchema?: z.ZodType;

  /** Action label shown in UI (e.g., "Reading file", "Editing file") */
  actionLabel?: string;

  /** Tool category for grouping/filtering */
  category: string;

  /** If true, skip timeout for this tool */
  noTimeout?: boolean;
}

export interface StructuredToolResultLike {
  display?: string;
  content: string;
  isError?: boolean;
  is_error?: boolean;
}

/** Handler function that executes the tool with validated input. Returns a plain string (success) or a structured result. */
export type ToolHandler = (input: unknown) => Promise<string | StructuredToolResultLike>;

/** A registered tool combining definition and handler */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}
