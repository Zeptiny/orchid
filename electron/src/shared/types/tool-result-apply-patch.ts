/**
 * Canonical result schema for the apply_patch tool.
 */
import { z } from 'zod';
import { fileChangeDataSchema } from './tool-result-filesystem';

export const applyPatchFileResultSchema = z.object({
  path: z.string().min(1),
  operation: z.enum(['create', 'update', 'delete']),
  status: z.enum(['complete', 'error']),
  fileChange: fileChangeDataSchema.optional(),
  movePath: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
}).strict();

export type ApplyPatchFileResult = z.infer<typeof applyPatchFileResultSchema>;

export const applyPatchResultDataSchema = z.object({
  files: z.array(applyPatchFileResultSchema),
  added: z.number().int().nonnegative(),
  modified: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
}).strict();

export type ApplyPatchResultData = z.infer<typeof applyPatchResultDataSchema>;
