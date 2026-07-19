import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeToolCall } from '../../src/main/llm/tool-dispatch';
import { ToolRegistry } from '../../src/main/tools/registry';
import {
  editDefinition,
  editHandler,
} from '../../src/main/tools/filesystem/edit';
import {
  writeDefinition,
  writeHandler,
} from '../../src/main/tools/filesystem/write';
import {
  readDefinition,
  readHandler,
} from '../../src/main/tools/filesystem/read';
import {
  readDirectoryDefinition,
  readDirectoryHandler,
} from '../../src/main/tools/filesystem/read-directory';
import {
  globDefinition,
  globHandler,
} from '../../src/main/tools/filesystem/glob';
import {
  grepHandler,
  grepToolDefinition,
} from '../../src/main/tools/search/grep';
import {
  _setStructuredPatchForTests,
  buildStructuredFileChange,
} from '../../src/main/tools/filesystem/structured-diff';
import { finalizeToolExecutionResult } from '../../src/main/tools/result';
import {
  _setResultRetrievalCacheRootForTests,
} from '../../src/main/tools/result-retrieval';
import {
  serializeCanonicalResultForCopy,
  type ToolHandlerOutcome,
} from '../../src/shared/types/tool-result';
import {
  directoryEntriesDataSchema,
  fileChangeDataSchema,
  fileContentDataSchema,
  fileWriteDataSchema,
  searchResultsDataSchema,
  type DirectoryEntriesData,
  type FileChangeData,
  type FileContentData,
  type FileWriteData,
  type GrepResultsData,
  type SearchResultsData,
} from '../../src/shared/types/tool-result-filesystem';

let tmpDir: string;

function outcome<T>(value: unknown): ToolHandlerOutcome<T> {
  return value as ToolHandlerOutcome<T>;
}

function writeFixture(relativePath: string, content: string): string {
  const filePath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-results-'));
  _setResultRetrievalCacheRootForTests(path.join(tmpDir, 'retrieval-cache'));
});

afterEach(() => {
  _setStructuredPatchForTests(null);
  _setResultRetrievalCacheRootForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('filesystem result metadata', () => {
  it.each([
    [editDefinition, 'file-change', fileChangeDataSchema],
    [writeDefinition, 'file-write', fileWriteDataSchema],
    [readDefinition, 'file-content', fileContentDataSchema],
    [readDirectoryDefinition, 'directory-entries', directoryEntriesDataSchema],
    [globDefinition, 'search-results', searchResultsDataSchema],
    [grepToolDefinition, 'search-results', searchResultsDataSchema],
  ] as const)('declares the typed family for %s', (definition, family, schema) => {
    expect(definition.resultFamily).toBe(family);
    expect(definition.outputDataSchema).toBe(schema);
  });
});

describe('structured filesystem diff', () => {
  it('derives complete hunks, coordinates, counts, and copy text from one change', () => {
    const data = buildStructuredFileChange({
      path: '/repo/example.ts',
      operation: 'update',
      oldContent: ['one', 'remove me', 'three', 'four'].join('\n'),
      newContent: ['one', 'add a', 'add b', 'three', 'add c', 'add d', 'four'].join('\n'),
    });

    expect(fileChangeDataSchema.parse(data)).toEqual(data);
    expect(data.addedLines).toBe(4);
    expect(data.removedLines).toBe(1);
    expect(data.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === 'add'))
      .toHaveLength(4);
    expect(data.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === 'remove'))
      .toHaveLength(1);

    for (const hunk of data.hunks) {
      expect(hunk.lines.filter((line) => line.kind !== 'add')).toHaveLength(hunk.oldLines);
      expect(hunk.lines.filter((line) => line.kind !== 'remove')).toHaveLength(hunk.newLines);
    }

    const copy = serializeCanonicalResultForCopy({
      schemaVersion: 1,
      family: 'file-change',
      status: 'complete',
      completeness: 'complete',
      data,
    });
    expect(copy).toContain('-remove me');
    expect(copy).toContain('+add d');
  });

  it.each([
    ['', 'created without newline'],
    ['deleted without newline', ''],
    ['alpha\r\nbeta\r\n', 'alpha\r\nchanged\r\n'],
    ['alpha\nbeta\n', 'alpha\nbeta'],
    ['alpha\nbeta', 'alpha\nbeta\n'],
  ])('handles empty, CRLF, and final-newline inputs', (oldContent, newContent) => {
    const data = buildStructuredFileChange({
      path: '/repo/boundary.txt',
      operation: oldContent === '' ? 'create' : newContent === '' ? 'delete' : 'update',
      oldContent,
      newContent,
    });

    expect(fileChangeDataSchema.safeParse(data).success).toBe(true);
    expect(data.resultingContent).toBe(newContent);
    expect(data.hunks.flatMap((hunk) => hunk.lines).every((line) => !line.content.includes('\r')))
      .toBe(true);
  });

  it('keeps separated edits in separate hunks and handles a large file', () => {
    const oldLines = Array.from({ length: 5_000 }, (_, index) => `line ${index + 1}`);
    const newLines = [...oldLines];
    newLines[10] = 'changed near start';
    newLines[4_900] = 'changed near end';

    const data = buildStructuredFileChange({
      path: '/repo/large.txt',
      operation: 'update',
      oldContent: oldLines.join('\n'),
      newContent: newLines.join('\n'),
    });

    expect(data.hunks).toHaveLength(2);
    expect(data.addedLines).toBe(2);
    expect(data.removedLines).toBe(2);
  });
});

describe('typed filesystem outcomes', () => {
  it('captures edit facts before an atomic mutation and leaves bytes unchanged on diff failure', async () => {
    const filePath = writeFixture('edit.txt', 'before\nkeep\n');
    const success = outcome<FileChangeData>(await editHandler({
      file_path: filePath,
      old_string: 'before',
      new_string: 'after',
    }, { cwd: tmpDir }));

    expect(success.status).toBe('complete');
    expect(success.data).toMatchObject({
      path: filePath,
      operation: 'update',
      addedLines: 1,
      removedLines: 1,
      resultingContent: 'after\nkeep\n',
    });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('after\nkeep\n');
    expect(success).not.toHaveProperty('display');
    expect(success).not.toHaveProperty('content');

    fs.writeFileSync(filePath, 'stable bytes\n', 'utf-8');
    _setStructuredPatchForTests(() => {
      throw new Error('injected diff failure');
    });
    const failure = outcome<FileChangeData>(await editHandler({
      file_path: filePath,
      old_string: 'stable',
      new_string: 'changed',
    }, { cwd: tmpDir }));

    expect(failure.status).toBe('error');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('stable bytes\n');
  });

  it('distinguishes create and replace writes with exact content, bytes, and lines', async () => {
    const filePath = path.join(tmpDir, 'written.txt');
    const created = outcome<FileWriteData>(await writeHandler({
      file_path: filePath,
      content: 'ol\u00e1\n',
    }, { cwd: tmpDir }));
    expect(created).toEqual({
      status: 'complete',
      data: {
        path: filePath,
        operation: 'create',
        content: 'ol\u00e1\n',
        byteCount: 5,
        lineCount: 1,
      },
    });

    const replaced = outcome<FileWriteData>(await writeHandler({
      file_path: filePath,
      content: '',
    }, { cwd: tmpDir }));
    expect(replaced).toMatchObject({
      status: 'complete',
      data: { operation: 'replace', content: '', byteCount: 0, lineCount: 0 },
    });
  });

  it('preserves read ranges and supplies native retrieval for remaining lines', async () => {
    const filePath = writeFixture('read.txt', 'one\ntwo\nthree\nfour\n');
    const result = outcome<FileContentData>(await readHandler({
      file_path: filePath,
      offset: 2,
      limit: 2,
    }, { cwd: tmpDir }));

    expect(result.status).toBe('partial');
    expect(result.data).toEqual({
      path: filePath,
      lines: [{ number: 2, content: 'two' }, { number: 3, content: 'three' }],
      requestedRange: { start: 2, end: 3 },
      returnedRange: { start: 2, end: 3 },
      totalLineCount: 4,
      language: 'text',
    });
    if (result.status !== 'partial') throw new Error('expected partial read');
    expect(result.retrieval).toEqual({ kind: 'read', path: filePath, offset: 4, limit: 2 });
  });

  it('records directory hierarchy, kinds, metadata, and depth partiality', async () => {
    writeFixture('src/deep/file.ts', 'export {};\n');
    writeFixture('.hidden', 'secret');
    const linkPath = path.join(tmpDir, 'source-link');
    fs.symlinkSync(path.join(tmpDir, 'src'), linkPath, 'dir');

    const result = outcome<DirectoryEntriesData>(await readDirectoryHandler({
      directory_path: tmpDir,
      max_depth: 1,
    }, { cwd: tmpDir, projectRuntime: { config: { ignored_dirs: [] } as never } }));

    expect(result.status).toBe('partial');
    expect(result.data.depthLimitReached).toBe(true);
    expect(result.data.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'src', relativePath: 'src', kind: 'directory', depth: 0 }),
      expect.objectContaining({ name: 'source-link', relativePath: 'source-link', kind: 'symlink', depth: 0 }),
    ]));
    expect(result.data.entries.some((entry) => entry.name === '.hidden')).toBe(false);
    expect(result.data.totalEntries).toBe(result.data.entries.length);
  });

  it('keeps glob metadata in deterministic mtime/path order', async () => {
    const first = writeFixture('a.ts', 'a');
    const second = writeFixture('b.ts', 'bb');
    const sameTime = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(first, sameTime, sameTime);
    fs.utimesSync(second, sameTime, sameTime);

    const result = outcome<SearchResultsData>(await globHandler({
      directory_path: tmpDir,
      pattern: '*.ts',
    }, { cwd: tmpDir }));

    expect(result.status).toBe('complete');
    expect(result.data).toEqual({
      kind: 'glob',
      root: tmpDir,
      pattern: '*.ts',
      matches: [
        { path: 'a.ts', size: 1, modifiedAt: sameTime.toISOString() },
        { path: 'b.ts', size: 2, modifiedAt: sameTime.toISOString() },
      ],
      totalMatches: 2,
      limitReached: false,
    });
  });

  it('keeps grep locations and marks max-results partiality with rerun guidance', async () => {
    writeFixture('a.ts', 'needle first\nnone\nneedle last\n');
    const result = outcome<GrepResultsData>(await grepHandler({
      directory_path: tmpDir,
      pattern: 'needle',
      max_results: 2,
    }, { cwd: tmpDir, projectRuntime: { config: { ignored_dirs: [], grep_max_results: 100 } as never } }));

    expect(result.status).toBe('partial');
    expect(result.data.matches).toEqual([
      { path: 'a.ts', line: 1, column: 1, text: 'needle first' },
      { path: 'a.ts', line: 3, column: 1, text: 'needle last' },
    ]);
    expect(result.data.limitReached).toBe(true);
    if (result.status !== 'partial') throw new Error('expected partial grep');
    expect(result.retrieval).toMatchObject({
      kind: 'rerun',
      toolName: 'grep',
      input: { pattern: 'needle', directory_path: tmpDir },
    });
  });
});

describe('bounded family projections', () => {
  it('keeps every canonical glob record while materializing omitted projection records', async () => {
    for (let index = 0; index < 240; index += 1) {
      writeFixture(`many/file-${String(index).padStart(3, '0')}.ts`, `export const n = ${index};`);
    }
    const registry = new ToolRegistry();
    registry.register(globDefinition, globHandler);
    const execution = await executeToolCall({
      id: 'large-glob-call',
      type: 'function',
      function: {
        name: 'glob',
        arguments: JSON.stringify({ directory_path: tmpDir, pattern: '**/*.ts' }),
      },
    }, registry, { cwd: tmpDir, sessionId: 'filesystem-results-session' });

    const canonical = searchResultsDataSchema.parse(execution.canonical.data);
    expect(canonical.matches).toHaveLength(240);
    expect(canonical.matches.at(-1)?.path).toBe('many/file-239.ts');
    expect(execution.agentProjection.completeness).toBe('partial');
    if (execution.agentProjection.completeness !== 'partial') {
      throw new Error('expected bounded projection');
    }
    expect(execution.agentProjection.retrieval.kind).toBe('cache');
    if (execution.agentProjection.retrieval.kind !== 'cache') {
      throw new Error('expected cache retrieval');
    }
    const cached = fs.readFileSync(execution.agentProjection.retrieval.path, 'utf-8');
    expect(cached).toContain('many/file-239.ts');
  });
});

describe('XML agent projections', () => {
  it('preserves read line content while escaping XML syntax', async () => {
    const filePath = writeFixture('exact.txt', '  <tag>&\nblank\n');
    const registry = new ToolRegistry();
    registry.register(readDefinition, readHandler);

    const execution = await executeToolCall({
      id: 'read-exact',
      type: 'function',
      function: {
        name: 'read',
        arguments: JSON.stringify({ file_path: filePath }),
      },
    }, registry, { cwd: tmpDir });

    expect(execution.agentProjection.content).toContain(
      '<tool_result name="read" status="complete"',
    );
    expect(execution.agentProjection.content).toContain(
      '1 |   &lt;tag&gt;&amp;',
    );
    expect(execution.agentProjection.content).toContain('2 | blank');
    expect(execution.agentProjection.content).not.toContain('1 | &lt;tag&gt;');
  });

  it('uses the compact edit, glob, grep, and directory formats', async () => {
    const first = writeFixture('src/a.ts', 'needle first\n');
    writeFixture('src/b.ts', 'needle second\n');
    const registry = new ToolRegistry();
    registry.register(editDefinition, editHandler);
    registry.register(globDefinition, globHandler);
    registry.register(grepToolDefinition, grepHandler);
    registry.register(readDirectoryDefinition, readDirectoryHandler);
    const context = {
      cwd: tmpDir,
      projectRuntime: { config: { ignored_dirs: [] } as never },
    };

    const edit = await executeToolCall({
      id: 'edit-xml',
      type: 'function',
      function: {
        name: 'edit',
        arguments: JSON.stringify({
          file_path: first,
          old_string: 'needle',
          new_string: 'changed',
        }),
      },
    }, registry, context);
    expect(edit.agentProjection.content).toContain('<old_string>needle first</old_string>');
    expect(edit.agentProjection.content).toContain('<new_string>changed first</new_string>');
    expect(edit.agentProjection.content).not.toContain('@@');

    const glob = await executeToolCall({
      id: 'glob-xml',
      type: 'function',
      function: {
        name: 'glob',
        arguments: JSON.stringify({ directory_path: tmpDir, pattern: '**/*.ts' }),
      },
    }, registry, context);
    expect(glob.agentProjection.content).toContain('<query ');
    expect(glob.agentProjection.content).toContain('<files format="path-per-line">');
    expect(glob.agentProjection.content).toContain('src/a.ts');
    expect(glob.agentProjection.content).not.toContain('<file>');

    const grep = await executeToolCall({
      id: 'grep-xml',
      type: 'function',
      function: {
        name: 'grep',
        arguments: JSON.stringify({ directory_path: tmpDir, pattern: 'needle' }),
      },
    }, registry, context);
    expect(grep.agentProjection.content).toContain(
      '<matches format="path | line | content">',
    );
    expect(grep.agentProjection.content).toContain('src/b.ts | 1 | needle second');
    expect(grep.agentProjection.content).not.toContain('column');

    const directory = await executeToolCall({
      id: 'directory-xml',
      type: 'function',
      function: {
        name: 'read_directory',
        arguments: JSON.stringify({ directory_path: tmpDir, max_depth: 2 }),
      },
    }, registry, context);
    expect(directory.agentProjection.content).toContain('<tree>\n');
    expect(directory.agentProjection.content).toContain('└── src/');
    expect(directory.agentProjection.content).not.toContain('format="dynamic-system-prompt"');
  });
});

describe('projector-error fallback', () => {
  function fileChangeCanonical() {
    return {
      schemaVersion: 1 as const,
      family: 'file-change' as const,
      status: 'complete' as const,
      completeness: 'complete' as const,
      data: buildStructuredFileChange({
        path: '/repo/example.ts',
        operation: 'update',
        oldContent: 'before\n',
        newContent: 'after\n',
      }),
    };
  }

  it('falls back to the generic projector and logs a diagnostic', () => {
    const fallbackLogger = vi.fn();
    const result = finalizeToolExecutionResult({
      canonical: fileChangeCanonical(),
      toolName: 'edit',
      projector: () => {
        throw new Error('projector exploded');
      },
      fallbackOnProjectorError: true,
      fallbackLogger,
    });

    expect(result.agentProjection.content).toContain('<tool_result');
    expect(fallbackLogger).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'projection' }),
    );
  });

  it('rethrows the original error when fallback is disabled', () => {
    expect(() =>
      finalizeToolExecutionResult({
        canonical: fileChangeCanonical(),
        toolName: 'edit',
        projector: () => {
          throw new Error('projector exploded');
        },
        fallbackOnProjectorError: false,
      }),
    ).toThrow('projector exploded');
  });
});
