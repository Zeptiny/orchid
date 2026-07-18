/**
 * Shared canonical tool-result contract.
 *
 * The canonical envelope is the only persisted authority for terminal status,
 * completeness, errors, and result facts. Agent/user text is derived later.
 */
import { z } from 'zod';
import {
  directoryEntriesDataSchema,
  fileChangeDataSchema,
  fileContentDataSchema,
  fileWriteDataSchema,
  searchResultsDataSchema,
  type FileChangeData,
  type FileContentData,
  type FileWriteData,
} from './tool-result-filesystem';

export const CANONICAL_TOOL_RESULT_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isPlainJsonObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkJsonSafety(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object') {
    return false;
  }
  if (!Array.isArray(value) && !isPlainJsonObject(value)) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  let children: unknown[];
  if (Array.isArray(value)) {
    if (Object.keys(value).some((key) => !/^\d+$/.test(key))) {
      ancestors.delete(value);
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        ancestors.delete(value);
        return false;
      }
    }
    children = value;
  } else {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(value);
    if (names.some((name) => {
      const descriptor = descriptors[name];
      return descriptor?.enumerable !== true || !('value' in descriptor);
    })) {
      ancestors.delete(value);
      return false;
    }
    children = names.map((name) => descriptors[name]!.value);
  }
  const safe = children.every((child) => checkJsonSafety(child, ancestors));
  ancestors.delete(value);
  return safe;
}

/** True only when JSON serialization is exact and cannot silently coerce data. */
export function isJsonSafe(value: unknown): value is JsonValue {
  return checkJsonSafety(value, new Set());
}

export const jsonValueSchema = z.custom<JsonValue>(isJsonSafe, {
  message: 'Expected an exact JSON-safe value',
});

export const canonicalToolResultVersionSchema = z.literal(
  CANONICAL_TOOL_RESULT_VERSION,
);
export const terminalToolResultStatusSchema = z.enum([
  'complete',
  'partial',
  'empty',
  'error',
  'cancelled',
]);
export const toolResultFamilySchema = z.enum([
  'file-change',
  'file-write',
  'file-content',
  'directory-entries',
  'search-results',
  'generic',
]);
export const toolResultCompletenessSchema = z.enum(['complete', 'partial']);

export type TerminalToolResultStatus = z.infer<typeof terminalToolResultStatusSchema>;
export type ToolResultFamily = z.infer<typeof toolResultFamilySchema>;
export type ToolResultCompleteness = z.infer<typeof toolResultCompletenessSchema>;

export const toolResultRetrievalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('read'),
    path: z.string().min(1),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    kind: z.literal('grep'),
    path: z.string().min(1),
    pattern: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('rerun'),
    toolName: z.string().min(1),
    input: jsonValueSchema,
  }).strict(),
  z.object({
    kind: z.literal('cache'),
    path: z.string().min(1),
    instructions: z.array(z.string().min(1)).min(1),
  }).strict(),
]);

export type ToolResultRetrieval = z.infer<typeof toolResultRetrievalSchema>;

export const canonicalToolErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  metadata: z.record(jsonValueSchema).optional(),
}).strict();

export type CanonicalToolError = z.infer<typeof canonicalToolErrorSchema>;

export const genericToolResultOriginSchema = z.object({
  kind: z.enum(['built-in', 'dynamic', 'mcp']),
  name: z.string().min(1),
}).strict();

export const genericToolResultDataSchema = z.object({
  value: jsonValueSchema,
  origin: genericToolResultOriginSchema.optional(),
}).strict();

export type GenericToolResultData = z.infer<typeof genericToolResultDataSchema>;

type ResultFamilySchema = typeof toolResultFamilySchema | z.ZodLiteral<ToolResultFamily>;

function familySchema(expectedFamily?: ToolResultFamily): ResultFamilySchema {
  return expectedFamily === undefined
    ? toolResultFamilySchema
    : z.literal(expectedFamily);
}

/** Build a canonical envelope schema whose data is owned by one tool definition. */
export function createCanonicalToolResultSchema<T extends z.ZodTypeAny>(
  outputDataSchema: T,
  expectedFamily?: ToolResultFamily,
) {
  const common = {
    schemaVersion: canonicalToolResultVersionSchema,
    family: familySchema(expectedFamily),
    data: z.intersection(outputDataSchema, jsonValueSchema),
  };

  return z.discriminatedUnion('status', [
    z.object({
      ...common,
      status: z.literal('complete'),
      completeness: z.literal('complete'),
    }).strict(),
    z.object({
      ...common,
      status: z.literal('partial'),
      completeness: z.literal('partial'),
      retrieval: toolResultRetrievalSchema,
    }).strict(),
    z.object({
      ...common,
      status: z.literal('empty'),
      completeness: z.literal('complete'),
    }).strict(),
    z.object({
      ...common,
      status: z.literal('error'),
      completeness: z.literal('complete'),
      error: canonicalToolErrorSchema,
    }).strict(),
    z.object({
      ...common,
      status: z.literal('cancelled'),
      completeness: z.literal('complete'),
    }).strict(),
  ]);
}

export const canonicalToolResultSchema = createCanonicalToolResultSchema(
  jsonValueSchema,
);

interface CanonicalToolResultBase<TData> {
  readonly schemaVersion: typeof CANONICAL_TOOL_RESULT_VERSION;
  readonly family: ToolResultFamily;
  readonly data: TData;
}

export type CanonicalToolResult<TData = JsonValue> =
  | (CanonicalToolResultBase<TData> & {
      readonly status: 'complete' | 'empty' | 'cancelled';
      readonly completeness: 'complete';
    })
  | (CanonicalToolResultBase<TData> & {
      readonly status: 'partial';
      readonly completeness: 'partial';
      readonly retrieval: ToolResultRetrieval;
    })
  | (CanonicalToolResultBase<TData> & {
      readonly status: 'error';
      readonly completeness: 'complete';
      readonly error: CanonicalToolError;
    });

export type ToolHandlerOutcome<TData = JsonValue> =
  | { readonly status: 'complete'; readonly data: TData }
  | { readonly status: 'partial'; readonly data: TData; readonly retrieval: ToolResultRetrieval }
  | { readonly status: 'empty'; readonly data: TData }
  | { readonly status: 'error'; readonly data: TData; readonly error: CanonicalToolError }
  | { readonly status: 'cancelled'; readonly data: TData };

/** Add the version, family, and status-consistent completeness to an outcome. */
export function createCanonicalToolResult<TData>(
  family: ToolResultFamily,
  outcome: ToolHandlerOutcome<TData>,
): CanonicalToolResult<TData> {
  const canonical = {
    schemaVersion: CANONICAL_TOOL_RESULT_VERSION,
    family,
    ...outcome,
    completeness: outcome.status === 'partial' ? 'partial' : 'complete',
  };
  return canonicalToolResultSchema.parse(canonical) as CanonicalToolResult<TData>;
}

export const agentProjectionSchema = z.discriminatedUnion('completeness', [
  z.object({
    content: z.string(),
    completeness: z.literal('complete'),
  }).strict(),
  z.object({
    content: z.string(),
    completeness: z.literal('partial'),
    retrieval: toolResultRetrievalSchema,
  }).strict(),
]);

export type AgentProjection = z.infer<typeof agentProjectionSchema>;
export type AgentProjector = (
  canonical: CanonicalToolResult,
) => AgentProjection;

export interface ToolExecutionResult<TData = JsonValue> {
  readonly canonical: CanonicalToolResult<TData>;
  readonly agentProjection: AgentProjection;
}

/** Build the AI SDK raw-output schema separately from a handler data schema. */
export function createToolExecutionResultSchema<T extends z.ZodTypeAny>(
  outputDataSchema: T,
  expectedFamily?: ToolResultFamily,
) {
  return z.object({
    canonical: createCanonicalToolResultSchema(outputDataSchema, expectedFamily),
    agentProjection: agentProjectionSchema,
  }).strict();
}

export const toolExecutionResultSchema = createToolExecutionResultSchema(
  jsonValueSchema,
);

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map((key) => [key, sortJson(value[key]!)]),
    );
  }
  return value;
}

/** Stable JSON with lexicographically ordered object keys at every depth. */
export function serializeJsonDeterministically(value: unknown): string {
  if (!isJsonSafe(value)) {
    throw new TypeError('Cannot serialize a non-JSON-safe value');
  }
  return JSON.stringify(sortJson(value), null, 2);
}

function serializeFileChange(data: FileChangeData): string {
  const oldPath = data.operation === 'create' ? '/dev/null' : data.path;
  const newPath = data.operation === 'delete' ? '/dev/null' : data.path;
  const lines = [`--- ${oldPath}`, `+++ ${newPath}`];
  for (const hunk of data.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const line of hunk.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
      lines.push(`${prefix}${line.content}`);
    }
  }
  return lines.join('\n');
}

function serializeFileWrite(data: FileWriteData): string {
  return [
    `Path: ${data.path}`,
    `Operation: ${data.operation}`,
    `Bytes: ${data.byteCount}`,
    `Lines: ${data.lineCount}`,
    '',
    data.content,
  ].join('\n');
}

function serializeFileContent(data: FileContentData): string {
  const returned = data.returnedRange === null
    ? 'none'
    : `${data.returnedRange.start}-${data.returnedRange.end}`;
  return [
    `Path: ${data.path}`,
    `Returned: ${returned} of ${data.totalLineCount} lines`,
    ...data.lines.map((line) => `${line.number} | ${line.content}`),
  ].join('\n');
}

/**
 * Complete user-copy serialization. It is intentionally independent from the
 * bounded agent projection and never receives a page/window argument.
 */
export function serializeCanonicalResultForCopy(
  canonical: CanonicalToolResult,
): string {
  switch (canonical.family) {
    case 'file-change': {
      const parsed = fileChangeDataSchema.safeParse(canonical.data);
      return parsed.success
        ? serializeFileChange(parsed.data)
        : serializeJsonDeterministically(canonical.data);
    }
    case 'file-write': {
      const parsed = fileWriteDataSchema.safeParse(canonical.data);
      return parsed.success
        ? serializeFileWrite(parsed.data)
        : serializeJsonDeterministically(canonical.data);
    }
    case 'file-content': {
      const parsed = fileContentDataSchema.safeParse(canonical.data);
      return parsed.success
        ? serializeFileContent(parsed.data)
        : serializeJsonDeterministically(canonical.data);
    }
    case 'directory-entries': {
      const parsed = directoryEntriesDataSchema.safeParse(canonical.data);
      return serializeJsonDeterministically(parsed.success ? parsed.data : canonical.data);
    }
    case 'search-results': {
      const parsed = searchResultsDataSchema.safeParse(canonical.data);
      return serializeJsonDeterministically(parsed.success ? parsed.data : canonical.data);
    }
    case 'generic': {
      const parsed = genericToolResultDataSchema.safeParse(canonical.data);
      if (parsed.success && typeof parsed.data.value === 'string') {
        return parsed.data.value;
      }
      return serializeJsonDeterministically(parsed.success ? parsed.data.value : canonical.data);
    }
  }
}

/** Complete canonical serialization used for deterministic recovery artifacts. */
export function serializeCanonicalResultForRetrieval(
  canonical: CanonicalToolResult,
): string {
  return serializeJsonDeterministically(canonical);
}

export const toolResultFallbackDiagnosticSchema = z.object({
  toolCallId: z.string().min(1).optional(),
  toolName: z.string().min(1),
  family: toolResultFamilySchema,
  status: terminalToolResultStatusSchema,
  schemaPath: z.string().min(1).optional(),
  recordCount: z.number().int().nonnegative().optional(),
  omittedCount: z.number().int().nonnegative().optional(),
  exceptionClass: z.string().min(1).optional(),
  stage: z.enum(['json-safety', 'schema', 'projection', 'renderer']),
}).strict();

export type ToolResultFallbackDiagnostic = z.infer<
  typeof toolResultFallbackDiagnosticSchema
>;
export type ToolResultFallbackLogger = (
  diagnostic: ToolResultFallbackDiagnostic,
) => void;

/** Runtime-enforced metadata-only logging boundary. */
export function emitToolResultFallbackDiagnostic(
  logger: ToolResultFallbackLogger,
  diagnostic: ToolResultFallbackDiagnostic,
): void {
  logger(toolResultFallbackDiagnosticSchema.parse(diagnostic));
}

/** Deliberate generic adapter for dynamic and MCP results. */
export function wrapDynamicToolOutput(
  toolName: string,
  output: unknown,
  originKind: 'dynamic' | 'mcp' = 'dynamic',
): CanonicalToolResult<GenericToolResultData> {
  const origin = { kind: originKind, name: toolName } as const;
  if (!isJsonSafe(output)) {
    return createCanonicalToolResult('generic', {
      status: 'error',
      data: { value: null, origin },
      error: {
        code: 'invalid_json_output',
        message: 'Dynamic tool output is not JSON-safe and was not accepted.',
      },
    });
  }
  return createCanonicalToolResult('generic', {
    status: 'complete',
    data: { value: output, origin },
  });
}
