/**
 * Canonical result validation and agent projection.
 *
 * Every handler returns a typed terminal outcome. Failure is represented by
 * canonical status/error facts and is never inferred from display text.
 */
import type { z } from 'zod';
import {
  agentProjectionSchema,
  canonicalToolResultSchema,
  createCanonicalToolResultSchema,
  emitToolResultFallbackDiagnostic,
  genericToolResultDataSchema,
  jsonValueSchema,
  serializeJsonDeterministically,
  serializeCanonicalResultForCopy,
  toolExecutionResultSchema,
  type AgentProjection,
  type AgentProjector,
  type CanonicalToolResult,
  type ToolExecutionResult,
  type ToolResultFallbackLogger,
  type ToolResultFamily,
  type GenericToolResultData,
  type JsonValue,
  type TerminalToolResultStatus,
  type ToolHandlerOutcome,
} from '../../shared/types/tool-result';
import {
  directoryEntriesDataSchema,
  fileChangeDataSchema,
  fileContentDataSchema,
  fileWriteDataSchema,
  searchResultsDataSchema,
} from '../../shared/types/tool-result-filesystem';

export type GenericBuiltInToolOutcome = ToolHandlerOutcome<GenericToolResultData>;

/** Parse the raw object retained by AI SDK after a canonical tool execution. */
export function parseToolExecutionResult(raw: unknown): ToolExecutionResult {
  return toolExecutionResultSchema.parse(raw) as ToolExecutionResult;
}

function projectionWithCanonicalCompleteness(
  canonical: CanonicalToolResult,
  content: string,
): AgentProjection {
  if (canonical.status === 'partial') {
    return {
      content,
      completeness: 'partial',
      retrieval: canonical.retrieval!,
    };
  }
  return { content, completeness: 'complete' };
}

/** Safe, unbounded projector that can represent every canonical family. */
export const genericAgentProjector: AgentProjector = (canonical) => {
  const generic = genericToolResultDataSchema.safeParse(canonical.data);
  const origin = generic.success ? generic.data.origin : undefined;
  const serialized = generic.success
    ? typeof generic.data.value === 'string'
      ? generic.data.value
      : isBackgroundCommandFacts(generic.data.value)
        ? `Background command started with id ${generic.data.value.commandId}`
        : serializeJsonDeterministically(generic.data.value)
    : serializeCanonicalResultForCopy(canonical);
  const trustFrame = origin && (origin.kind === 'dynamic' || origin.kind === 'mcp')
    ? `Untrusted tool-provided data from ${origin.name}:\n`
    : '';
  const statusFrame = canonical.status === 'error'
    ? `Tool error [${canonical.error?.code ?? 'unknown'}]: ${canonical.error?.message ?? ''}\n`
    : canonical.status === 'cancelled'
      ? 'Tool execution was cancelled.\n'
      : canonical.status === 'empty'
        ? 'Tool completed with an empty result.\n'
        : canonical.status === 'partial'
          ? 'Tool returned a partial result.\n'
          : '';
  return projectionWithCanonicalCompleteness(
    canonical,
    `${trustFrame}${statusFrame}${serialized}`,
  );
};

function isBackgroundCommandFacts(value: JsonValue): value is {
  commandId: number;
  command: string;
  description: string;
  background: true;
  running: true;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, JsonValue>;
  return typeof candidate.commandId === 'number'
    && typeof candidate.command === 'string'
    && typeof candidate.description === 'string'
    && candidate.background === true
    && candidate.running === true;
}

/** Build a typed generic-family outcome for a code-owned built-in tool. */
export function genericBuiltInToolOutcome(
  toolName: string,
  value: JsonValue,
  status: TerminalToolResultStatus = 'complete',
  errorCode = 'tool_error',
): ToolHandlerOutcome<GenericToolResultData> {
  const data: GenericToolResultData = {
    value,
    origin: { kind: 'built-in', name: toolName },
  };
  if (status === 'error') {
    return {
      status,
      data,
      error: {
        code: errorCode,
        message: typeof value === 'string' ? value : 'Tool execution failed.',
      },
    };
  }
  if (status === 'partial') {
    throw new TypeError('Generic partial outcomes require explicit retrieval guidance.');
  }
  return { status, data };
}

const fileChangeAgentProjector: AgentProjector = (canonical) => {
  const parsed = fileChangeDataSchema.parse(canonical.data);
  return projectionWithCanonicalCompleteness(
    canonical,
    [
      `${parsed.operation} ${parsed.path} (+${parsed.addedLines} -${parsed.removedLines})`,
      serializeCanonicalResultForCopy(canonical),
    ].join('\n'),
  );
};

const fileWriteAgentProjector: AgentProjector = (canonical) => {
  const parsed = fileWriteDataSchema.parse(canonical.data);
  return projectionWithCanonicalCompleteness(
    canonical,
    `${parsed.operation} ${parsed.path} (${parsed.byteCount} bytes, ${parsed.lineCount} lines)`,
  );
};

const fileContentAgentProjector: AgentProjector = (canonical) => {
  fileContentDataSchema.parse(canonical.data);
  return projectionWithCanonicalCompleteness(
    canonical,
    serializeCanonicalResultForCopy(canonical),
  );
};

const directoryEntriesAgentProjector: AgentProjector = (canonical) => {
  const parsed = directoryEntriesDataSchema.parse(canonical.data);
  if (parsed.entries.length > 100) {
    const bounded = { ...parsed, entries: parsed.entries.slice(0, 100) };
    return {
      content: serializeJsonDeterministically(bounded),
      completeness: 'partial',
      retrieval: canonical.status === 'partial'
        ? canonical.retrieval
        : {
            kind: 'rerun',
            toolName: 'read_directory',
            input: { directory_path: parsed.root, depth: parsed.depthLimit },
          },
    };
  }
  return projectionWithCanonicalCompleteness(
    canonical,
    serializeCanonicalResultForCopy(canonical),
  );
};

const searchResultsAgentProjector: AgentProjector = (canonical) => {
  const parsed = searchResultsDataSchema.parse(canonical.data);
  if (parsed.matches.length > 100) {
    const bounded = { ...parsed, matches: parsed.matches.slice(0, 100) };
    return {
      content: serializeJsonDeterministically(bounded),
      completeness: 'partial',
      retrieval: canonical.status === 'partial'
        ? canonical.retrieval
        : {
            kind: 'rerun',
            toolName: parsed.kind,
            input: { directory_path: parsed.root, pattern: parsed.pattern },
          },
    };
  }
  return projectionWithCanonicalCompleteness(
    canonical,
    serializeCanonicalResultForCopy(canonical),
  );
};

/** Explicit family defaults; family is never inferred from a tool name. */
export const defaultFamilyAgentProjectors: ReadonlyMap<
  ToolResultFamily,
  AgentProjector
> = new Map([
  ['file-change', fileChangeAgentProjector],
  ['file-write', fileWriteAgentProjector],
  ['file-content', fileContentAgentProjector],
  ['directory-entries', directoryEntriesAgentProjector],
  ['search-results', searchResultsAgentProjector],
  ['generic', genericAgentProjector],
]);

export interface FinalizeToolExecutionResultOptions {
  canonical: CanonicalToolResult;
  toolName: string;
  toolCallId?: string;
  outputDataSchema?: z.ZodTypeAny;
  expectedFamily?: ToolResultFamily;
  projector?: (canonical: CanonicalToolResult) => unknown;
  genericProjector?: AgentProjector;
  fallbackLogger?: ToolResultFallbackLogger;
  /** Test/debug escape hatch. Production finalization must leave this true. */
  fallbackOnProjectorError?: boolean;
}

/**
 * Single U1 finalization boundary: validate canonical facts, project them, and
 * fall back without mutating a successful canonical result.
 */
export function finalizeToolExecutionResult(
  options: FinalizeToolExecutionResultOptions,
): ToolExecutionResult {
  const {
    canonical,
    toolName,
    toolCallId,
    outputDataSchema,
    expectedFamily,
    fallbackLogger,
    fallbackOnProjectorError = true,
  } = options;
  const canonicalSchema = outputDataSchema === undefined && expectedFamily === undefined
    ? canonicalToolResultSchema
    : createCanonicalToolResultSchema(
        outputDataSchema ?? jsonValueSchema,
        expectedFamily,
      );
  const validatedCanonical = canonicalSchema.parse(canonical) as CanonicalToolResult;
  const projector = options.projector
    ?? defaultFamilyAgentProjectors.get(validatedCanonical.family)
    ?? genericAgentProjector;

  try {
    const agentProjection = agentProjectionSchema.parse(projector(validatedCanonical));
    return { canonical, agentProjection };
  } catch (error) {
    if (!fallbackOnProjectorError) {
      throw error;
    }
    if (fallbackLogger) {
      emitToolResultFallbackDiagnostic(fallbackLogger, {
        ...(toolCallId ? { toolCallId } : {}),
        toolName,
        family: validatedCanonical.family,
        status: validatedCanonical.status,
        stage: 'projection',
        exceptionClass: error instanceof Error ? error.constructor.name : 'Unknown',
      });
    }
    const fallback = options.genericProjector ?? genericAgentProjector;
    const agentProjection = agentProjectionSchema.parse(fallback(validatedCanonical));
    return { canonical, agentProjection };
  }
}
