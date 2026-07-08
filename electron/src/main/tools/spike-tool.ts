/**
 * Spike: Minimal zod-validated tool for U2 foundation patterns validation.
 *
 * Defines a `list_files` tool with a zod schema. Validates that:
 * (a) schema produces valid JSON Schema via zod-to-json-schema
 * (b) tool executes and result feeds back into stream loop
 *
 * This is throwaway code — real tool registry comes in U7.
 */
import { readdir } from 'node:fs/promises';
import { tool } from 'ai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Zod schema for the list_files tool input.
 * Single source of truth for TS type, JSON Schema, and runtime validation.
 */
export const listFilesSchema = z.object({
  directory: z
    .string()
    .describe('The directory path to list files in'),
});

/**
 * The list_files tool defined with AI SDK's `tool()` helper.
 * Uses zod `parameters` for validation.
 */
export const listFilesTool = tool({
  description: 'List files and directories in the given directory path',
  parameters: listFilesSchema,
  execute: async ({ directory }) => {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const result = entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      }));
      return JSON.stringify(result, null, 2);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error listing files: ${message}`;
    }
  },
});

/**
 * Validate that the zod schema produces valid JSON Schema.
 * This is a key part of the go/no-go gate for R3.
 */
export function validateJsonSchema(): { valid: boolean; schema: unknown } {
  try {
    const jsonSchema = zodToJsonSchema(listFilesSchema);
    return { valid: true, schema: jsonSchema };
  } catch {
    return { valid: false, schema: null };
  }
}
