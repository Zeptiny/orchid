/**
 * Canonical data schemas for filesystem result families.
 *
 * These schemas contain persisted facts only. Titles, summaries, badges, and
 * display text are projections and deliberately do not belong here.
 */
import { z } from 'zod';

export const fileChangeLineSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('context'),
    content: z.string(),
    oldLineNumber: z.number().int().positive(),
    newLineNumber: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('add'),
    content: z.string(),
    newLineNumber: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('remove'),
    content: z.string(),
    oldLineNumber: z.number().int().positive(),
  }).strict(),
]);

export type FileChangeLine = z.infer<typeof fileChangeLineSchema>;

export const fileChangeHunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(fileChangeLineSchema),
}).strict();

export type FileChangeHunk = z.infer<typeof fileChangeHunkSchema>;

export const fileChangeDataSchema = z.object({
  path: z.string().min(1),
  operation: z.enum(['create', 'update', 'delete']),
  hunks: z.array(fileChangeHunkSchema),
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
  resultingContent: z.string(),
  oldString: z.string().optional(),
  newString: z.string().optional(),
  replaceAll: z.boolean().optional(),
  replacementCount: z.number().int().nonnegative().optional(),
}).strict();

export type FileChangeData = z.infer<typeof fileChangeDataSchema>;

export const fileWriteDataSchema = z.object({
  path: z.string().min(1),
  operation: z.enum(['create', 'replace']),
  content: z.string(),
  byteCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
}).strict();

export type FileWriteData = z.infer<typeof fileWriteDataSchema>;

export const sourceRangeSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive().optional(),
}).strict().refine(
  ({ start, end }) => end === undefined || end >= start,
  { message: 'Range end must be greater than or equal to start' },
);

export const returnedSourceRangeSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
}).strict().refine(
  ({ start, end }) => end >= start,
  { message: 'Range end must be greater than or equal to start' },
);

export const fileContentLineSchema = z.object({
  number: z.number().int().positive(),
  content: z.string(),
}).strict();

export const fileContentDataSchema = z.object({
  path: z.string().min(1),
  lines: z.array(fileContentLineSchema),
  requestedRange: sourceRangeSchema,
  returnedRange: returnedSourceRangeSchema.nullable(),
  totalLineCount: z.number().int().nonnegative(),
  language: z.string().min(1).optional(),
}).strict();

export type FileContentData = z.infer<typeof fileContentDataSchema>;

export const directoryEntryKindSchema = z.enum([
  'file',
  'directory',
  'symlink',
  'other',
]);

export const directoryEntrySchema = z.object({
  name: z.string().min(1),
  relativePath: z.string().min(1),
  kind: directoryEntryKindSchema,
  depth: z.number().int().nonnegative(),
  parentPath: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().datetime().optional(),
}).strict();

export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

export const directoryEntriesDataSchema = z.object({
  root: z.string().min(1),
  entries: z.array(directoryEntrySchema),
  totalEntries: z.number().int().nonnegative(),
  depthLimit: z.number().int().nonnegative(),
  depthLimitReached: z.boolean(),
}).strict();

export type DirectoryEntriesData = z.infer<typeof directoryEntriesDataSchema>;

export const globMatchSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().datetime().optional(),
}).strict();

export const grepMatchSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive().optional(),
  text: z.string(),
}).strict();

export type GlobMatch = z.infer<typeof globMatchSchema>;
export type GrepMatch = z.infer<typeof grepMatchSchema>;

export const globResultsDataSchema = z.object({
  kind: z.literal('glob'),
  root: z.string().min(1),
  pattern: z.string(),
  matches: z.array(globMatchSchema),
  totalMatches: z.number().int().nonnegative(),
  limitReached: z.boolean(),
}).strict();

export const grepResultsDataSchema = z.object({
  kind: z.literal('grep'),
  root: z.string().min(1),
  pattern: z.string(),
  matches: z.array(grepMatchSchema),
  totalMatches: z.number().int().nonnegative(),
  limitReached: z.boolean(),
}).strict();

export const searchResultsDataSchema = z.discriminatedUnion('kind', [
  globResultsDataSchema,
  grepResultsDataSchema,
]);

export type GlobResultsData = z.infer<typeof globResultsDataSchema>;
export type GrepResultsData = z.infer<typeof grepResultsDataSchema>;
export type SearchResultsData = z.infer<typeof searchResultsDataSchema>;

export const filesystemResultDataSchemas = {
  'file-change': fileChangeDataSchema,
  'file-write': fileWriteDataSchema,
  'file-content': fileContentDataSchema,
  'directory-entries': directoryEntriesDataSchema,
  'search-results': searchResultsDataSchema,
} as const;
