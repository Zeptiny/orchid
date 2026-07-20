import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CANONICAL_TOOL_RESULT_VERSION,
  agentProjectionSchema,
  canonicalToolResultSchema,
  createCanonicalToolResult,
  createToolExecutionResultSchema,
  emitToolResultFallbackDiagnostic,
  genericToolResultDataSchema,
  isJsonSafe,
  serializeCanonicalResultForCopy,
  serializeCanonicalResultForRetrieval,
  toolResultFallbackDiagnosticSchema,
  wrapDynamicToolOutput,
} from '../../src/shared/types/tool-result';
import {
  directoryEntriesDataSchema,
  fileChangeDataSchema,
  fileContentDataSchema,
  fileWriteDataSchema,
  searchResultsDataSchema,
} from '../../src/shared/types/tool-result-filesystem';

describe('canonical tool result contract', () => {
  it('round-trips complete nested JSON without losing data', () => {
    const canonical = createCanonicalToolResult('generic', {
      status: 'complete',
      data: {
        value: {
          answer: 42,
          flags: [true, false, null],
          nested: { text: 'kept exactly' },
        },
      },
    });

    expect(canonicalToolResultSchema.parse(canonical)).toEqual(canonical);
    expect(canonical.schemaVersion).toBe(CANONICAL_TOOL_RESULT_VERSION);
  });

  it.each([
    ['complete', 'complete'],
    ['empty', 'complete'],
    ['error', 'complete'],
    ['cancelled', 'complete'],
  ] as const)('accepts %s only with complete completeness', (status, completeness) => {
    const error = status === 'error'
      ? { code: 'failed', message: 'Tool failed' }
      : undefined;
    expect(canonicalToolResultSchema.safeParse({
      schemaVersion: 1,
      family: 'generic',
      status,
      completeness,
      data: { value: null },
      ...(error ? { error } : {}),
    }).success).toBe(true);

    expect(canonicalToolResultSchema.safeParse({
      schemaVersion: 1,
      family: 'generic',
      status,
      completeness: 'partial',
      data: { value: null },
      retrieval: { kind: 'read', path: '/tmp/result.json' },
      ...(error ? { error } : {}),
    }).success).toBe(false);
  });

  it('requires deterministic retrieval guidance for partial canonical results', () => {
    const base = {
      schemaVersion: 1,
      family: 'search-results',
      status: 'partial',
      completeness: 'partial',
      data: { kind: 'glob', root: '/repo', pattern: '*.ts', matches: [], totalMatches: 0, limitReached: false },
    } as const;

    expect(canonicalToolResultSchema.safeParse(base).success).toBe(false);
    expect(canonicalToolResultSchema.safeParse({
      ...base,
      retrieval: { kind: 'rerun', toolName: 'glob', input: { pattern: '*.ts' } },
    }).success).toBe(true);
  });

  it('requires retrieval guidance for partial agent projections', () => {
    expect(agentProjectionSchema.safeParse({
      content: 'First ten matches',
      completeness: 'partial',
    }).success).toBe(false);

    expect(agentProjectionSchema.safeParse({
      content: 'First ten matches',
      completeness: 'partial',
      retrieval: { kind: 'grep', path: '/tmp/result.json', pattern: 'needle' },
    }).success).toBe(true);
  });

  it('rejects contradictory errors and missing error metadata', () => {
    expect(canonicalToolResultSchema.safeParse({
      schemaVersion: 1,
      family: 'generic',
      status: 'complete',
      completeness: 'complete',
      data: { value: null },
      error: { code: 'unexpected', message: 'must not be here' },
    }).success).toBe(false);

    expect(canonicalToolResultSchema.safeParse({
      schemaVersion: 1,
      family: 'generic',
      status: 'error',
      completeness: 'complete',
      data: { value: null },
    }).success).toBe(false);
  });

  it('validates the generated execution wrapper against definition data', () => {
    const dataSchema = z.object({ answer: z.number().int() }).strict();
    const schema = createToolExecutionResultSchema(dataSchema, 'generic');
    const canonical = createCanonicalToolResult('generic', {
      status: 'complete',
      data: { answer: 'not a number' },
    });

    expect(schema.safeParse({
      canonical,
      agentProjection: { content: 'answer', completeness: 'complete' },
    }).success).toBe(false);

    expect(schema.safeParse({
      canonical: createCanonicalToolResult('generic', {
        status: 'complete',
        data: { answer: 42 },
      }),
      agentProjection: { content: 'answer: 42', completeness: 'complete' },
    }).success).toBe(true);
  });
});

describe('filesystem family schemas', () => {
  it('validates distinct file-change, file-write, and file-content records', () => {
    expect(fileChangeDataSchema.parse({
      path: '/repo/a.ts',
      operation: 'update',
      hunks: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: 'remove', content: 'old', oldLineNumber: 1 },
          { kind: 'add', content: 'new', newLineNumber: 1 },
        ],
      }],
      addedLines: 1,
      removedLines: 1,
      resultingContent: 'new\n',
    }).operation).toBe('update');

    expect(fileWriteDataSchema.parse({
      path: '/repo/new.ts',
      operation: 'create',
      content: 'export {};\n',
      byteCount: 11,
      lineCount: 1,
    }).operation).toBe('create');

    expect(fileContentDataSchema.parse({
      path: '/repo/a.ts',
      lines: [{ number: 2, content: 'const a = 1;' }],
      requestedRange: { start: 2, end: 2 },
      returnedRange: { start: 2, end: 2 },
      totalLineCount: 4,
      language: 'typescript',
    }).totalLineCount).toBe(4);
  });

  it('validates directory and both search result variants', () => {
    expect(directoryEntriesDataSchema.safeParse({
      root: '/repo',
      entries: [{ name: 'src', relativePath: 'src', kind: 'directory', depth: 0 }],
      totalEntries: 1,
      depthLimit: 2,
      depthLimitReached: false,
    }).success).toBe(true);

    expect(searchResultsDataSchema.safeParse({
      kind: 'glob',
      root: '/repo',
      pattern: '*.ts',
      matches: [{ path: 'a.ts', size: 10 }],
      totalMatches: 1,
      limitReached: false,
    }).success).toBe(true);

    expect(searchResultsDataSchema.safeParse({
      kind: 'grep',
      root: '/repo',
      pattern: 'needle',
      matches: [{ path: 'a.ts', line: 2, column: 4, text: 'needle' }],
      totalMatches: 1,
      limitReached: true,
    }).success).toBe(true);
  });
});

describe('deterministic and safe serialization', () => {
  it('serializes generic object keys deterministically', () => {
    const left = createCanonicalToolResult('generic', {
      status: 'complete',
      data: { value: { z: 1, a: { d: 4, b: 2 } } },
    });
    const right = createCanonicalToolResult('generic', {
      status: 'complete',
      data: { value: { a: { b: 2, d: 4 }, z: 1 } },
    });

    expect(serializeCanonicalResultForCopy(left)).toBe(
      serializeCanonicalResultForCopy(right),
    );
  });

  it('includes every search record even when an agent projection could be partial', () => {
    const canonical = createCanonicalToolResult('search-results', {
      status: 'complete',
      data: {
        kind: 'grep',
        root: '/repo',
        pattern: 'needle',
        matches: [
          { path: 'a.ts', line: 1, text: 'first needle' },
          { path: 'b.ts', line: 9, text: 'last needle' },
        ],
        totalMatches: 2,
        limitReached: false,
      },
    });

    const copy = serializeCanonicalResultForCopy(canonical);
    const retrieval = serializeCanonicalResultForRetrieval(canonical);
    expect(copy).toContain('first needle');
    expect(copy).toContain('last needle');
    expect(retrieval).toContain('first needle');
    expect(retrieval).toContain('last needle');
  });

  it('rejects non-JSON-safe values rather than silently coercing them', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(isJsonSafe({ ok: [1, true, null] })).toBe(true);
    expect(isJsonSafe({ missing: undefined })).toBe(false);
    expect(isJsonSafe({ infinite: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isJsonSafe({ bigint: 1n })).toBe(false);
    expect(isJsonSafe(new Date())).toBe(false);
    expect(isJsonSafe([, 'sparse'])).toBe(false);
    expect(isJsonSafe({ value: () => 'not data' })).toBe(false);
    expect(isJsonSafe(cyclic)).toBe(false);
    expect(genericToolResultDataSchema.safeParse({ value: cyclic }).success).toBe(false);
  });

  it('turns invalid dynamic output into an explicit canonical error', () => {
    const canonical = wrapDynamicToolOutput('mcp::demo::unsafe', { value: 1n }, 'mcp');
    expect(canonical.status).toBe('error');
    expect(canonical.error?.code).toBe('invalid_json_output');
    expect(canonical.data).toEqual({
      value: null,
      origin: { kind: 'mcp', name: 'mcp::demo::unsafe' },
    });
  });
});

describe('metadata-only fallback diagnostics', () => {
  it('accepts only the metadata fields in the diagnostic boundary', () => {
    expect(toolResultFallbackDiagnosticSchema.safeParse({
      toolCallId: 'call-1',
      toolName: 'read',
      family: 'file-content',
      status: 'complete',
      stage: 'projection',
      exceptionClass: 'Error',
      recordCount: 5,
    }).success).toBe(true);

    expect(toolResultFallbackDiagnosticSchema.safeParse({
      toolName: 'read',
      family: 'file-content',
      status: 'complete',
      stage: 'projection',
      content: 'CANONICAL_ONLY_SENTINEL',
    }).success).toBe(false);
  });

  it('never forwards content-bearing values to the logger', () => {
    const logger = vi.fn();
    emitToolResultFallbackDiagnostic(logger, {
      toolName: 'read',
      family: 'file-content',
      status: 'complete',
      stage: 'projection',
      exceptionClass: 'Error',
    });

    expect(logger).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.mock.calls[0]?.[0])).not.toContain('SENTINEL');
  });
});
