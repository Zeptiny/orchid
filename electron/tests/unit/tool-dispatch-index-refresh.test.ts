/**
 * Tool-dispatch index-refresh notification tests — U5.
 *
 * Covers:
 * - Successful write/edit outcomes enqueue an upsert with the canonical path (relative)
 * - apply_patch with mixed operations enqueues upserts plus one delete, skipping errored entries
 * - apply_patch moves enqueue a source delete plus a destination upsert; an
 *   escaping destination keeps only the source delete
 * - rename_symbol / replace_symbol results enqueue an upsert per mutated file
 * - Error and cancelled outcomes enqueue nothing
 * - Completed execute_command marks the project dirty; a read-only tool does not
 * - A background execute_command spawn does NOT mark dirty (the store marks
 *   at process exit instead — see background-store-index-refresh.test.ts)
 * - A path escaping the workspace is dropped
 * - A coordinator throw leaves the tool result byte-identical
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import { executeToolCall } from '../../src/main/llm/tool-dispatch';
import { ToolRegistry } from '../../src/main/tools/registry';
import { sessionPermissionOverrides } from '../../src/main/ipc/permission';
import { defaults } from '../../src/main/config';
import type { Config } from '../../src/main/config';
import {
  disposeIndexRefreshCoordinator,
  _setIndexRefreshCoordinatorForTests,
  _getPendingIndexRefreshForTests,
  type IndexMutationEntry,
  type RefreshAstIndexer,
  type RefreshRagIndexer,
} from '../../src/main/indexing/refresh-coordinator';
import {
  genericToolResultDataSchema,
  type JsonValue,
  type ToolHandlerOutcome,
  type ToolResultFamily,
} from '../../src/shared/types/tool-result';
import {
  fileChangeDataSchema,
  fileContentDataSchema,
  fileWriteDataSchema,
} from '../../src/shared/types/tool-result-filesystem';
import {
  applyPatchResultDataSchema,
  type ApplyPatchFileResult,
} from '../../src/shared/types/tool-result-apply-patch';
import type { RAGIndexResult, ASTIndexResult } from '../../src/shared/types/ipc-boundary';
import type { ASTIncrementalResult } from '../../src/main/ast/indexer';

const coordinatorHooks = vi.hoisted(() => ({
  enqueueMutation: null as ((projectPath: string, entries: IndexMutationEntry[]) => void) | null,
}));

vi.mock('../../src/main/indexing/refresh-coordinator', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/main/indexing/refresh-coordinator')
  >();
  return {
    ...actual,
    enqueueMutation: (projectPath: string, entries: IndexMutationEntry[]) => {
      if (coordinatorHooks.enqueueMutation) {
        coordinatorHooks.enqueueMutation(projectPath, entries);
        return;
      }
      actual.enqueueMutation(projectPath, entries);
    },
  };
});

const sessionId = 'index-refresh-dispatch-session';
const DEBOUNCE_MS = 60_000;

const RAG_RESULT: RAGIndexResult = {
  filesScanned: 0,
  filesIndexed: 0,
  filesSkipped: 0,
  filesDeleted: 0,
  chunksCreated: 0,
  errors: [],
  durationSeconds: 0,
};

const AST_RESULT: ASTIndexResult = {
  filesScanned: 0,
  filesIndexed: 0,
  filesSkipped: 0,
  filesDeleted: 0,
  symbolsExtracted: 0,
  errors: [],
  durationSeconds: 0,
};

const AST_INCREMENTAL_RESULT: ASTIncrementalResult = {
  filesIndexed: 0,
  filesSkipped: 0,
  filesDeleted: 0,
  symbolsExtracted: 0,
  errors: [],
};

function makeRagIndexer(): RefreshRagIndexer {
  return {
    upsertFiles: vi.fn(async (): RAGIndexResult => ({ ...RAG_RESULT })),
    deleteFiles: vi.fn(async (): Promise<void> => {}),
    indexProject: vi.fn(async (): RAGIndexResult => ({ ...RAG_RESULT })),
  };
}

function makeAstIndexer(): RefreshAstIndexer {
  return {
    upsertFiles: vi.fn(async (): ASTIncrementalResult => ({ ...AST_INCREMENTAL_RESULT })),
    deleteFiles: vi.fn(async (): Promise<number> => 0),
    indexProject: vi.fn(async (): ASTIndexResult => ({ ...AST_RESULT })),
  };
}

function fileWriteOutcome(absPath: string): ToolHandlerOutcome<JsonValue> {
  return {
    status: 'complete',
    data: fileWriteDataSchema.parse({
      path: absPath,
      operation: 'create',
      content: 'hello\n',
      byteCount: 6,
      lineCount: 1,
    }) as unknown as JsonValue,
  };
}

function fileChangeOutcome(absPath: string): ToolHandlerOutcome<JsonValue> {
  return {
    status: 'complete',
    data: fileChangeDataSchema.parse({
      path: absPath,
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
    }) as unknown as JsonValue,
  };
}

function fileContentOutcome(absPath: string): ToolHandlerOutcome<JsonValue> {
  return {
    status: 'complete',
    data: fileContentDataSchema.parse({
      path: absPath,
      lines: [{ number: 1, content: 'hello' }],
      requestedRange: { start: 1 },
      returnedRange: { start: 1, end: 1 },
      totalLineCount: 1,
    }) as unknown as JsonValue,
  };
}

function applyPatchOutcome(files: ApplyPatchFileResult[]): ToolHandlerOutcome<JsonValue> {
  const complete = files.filter((file) => file.status === 'complete');
  return {
    status: 'complete',
    data: applyPatchResultDataSchema.parse({
      files,
      added: complete.filter((file) => file.operation === 'create').length,
      modified: complete.filter((file) => file.operation === 'update').length,
      deleted: complete.filter((file) => file.operation === 'delete').length,
      failed: files.filter((file) => file.status === 'error').length,
    }) as unknown as JsonValue,
  };
}

function genericOutcome(
  value: JsonValue,
  name = 'test',
): ToolHandlerOutcome<JsonValue> {
  return {
    status: 'complete',
    data: { value, origin: { kind: 'built-in', name } },
  };
}

describe('executeToolCall index refresh notification', () => {
  let registry: ToolRegistry;
  let root: string;
  let cwd: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let toolDispatchApi: typeof import('../../src/main/llm/tool-dispatch');

  function registerFakeTool(
    definition: {
      name: string;
      resultFamily: ToolResultFamily;
      outputDataSchema: z.ZodTypeAny;
      riskClass: 'mutation' | 'execution' | 'read-only';
    },
    outcome: () => ToolHandlerOutcome<JsonValue>,
  ): void {
    registry.register(
      {
        name: definition.name,
        description: `Fake ${definition.name} tool`,
        inputSchema: z.object({}),
        resultFamily: definition.resultFamily,
        outputDataSchema: definition.outputDataSchema,
        category: 'test',
        riskClass: definition.riskClass,
      },
      async () => outcome(),
    );
  }

  function dispatch(name: string, id = `${name}-call`) {
    return executeToolCall({ id, name, args: {} }, registry, { cwd, sessionId });
  }

  beforeEach(async () => {
    registry = new ToolRegistry();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-index-refresh-dispatch-'));
    cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd);
    sessionPermissionOverrides.set(sessionId, 'allow');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: Config = {
      ...defaults(),
      index_refresh: { ...defaults().index_refresh, debounce_ms: DEBOUNCE_MS },
    };
    _setIndexRefreshCoordinatorForTests({
      ragIndexer: makeRagIndexer(),
      astIndexer: makeAstIndexer(),
      configLoader: () => config,
    });
    toolDispatchApi = await import('../../src/main/llm/tool-dispatch');
    toolDispatchApi._setAgentsMdStoreResolverForTests(() => null);
  });

  afterEach(() => {
    toolDispatchApi._setAgentsMdStoreResolverForTests(null);
    sessionPermissionOverrides.delete(sessionId);
    disposeIndexRefreshCoordinator();
    _setIndexRefreshCoordinatorForTests({
      ragIndexer: null,
      astIndexer: null,
      configLoader: null,
    });
    coordinatorHooks.enqueueMutation = null;
    warnSpy.mockRestore();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('enqueues an upsert for a successful write outcome', async () => {
    const data = fileWriteDataSchema.parse({
      path: path.join(cwd, 'src', 'new.ts'),
      operation: 'create',
      content: 'hello\n',
      byteCount: 6,
      lineCount: 1,
    });
    registerFakeTool(
      {
        name: 'write',
        resultFamily: 'file-write',
        outputDataSchema: fileWriteDataSchema,
        riskClass: 'mutation',
      },
      () => ({ status: 'complete', data: data as unknown as JsonValue }),
    );

    const result = await dispatch('write');

    expect(result.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd)).toEqual({
      entries: [{ rel: 'src/new.ts', op: 'upsert' }],
      dirty: false,
      timerArmed: true,
      flushing: false,
    });
  });

  it('enqueues an upsert for a successful edit outcome', async () => {
    registerFakeTool(
      {
        name: 'edit',
        resultFamily: 'file-change',
        outputDataSchema: fileChangeDataSchema,
        riskClass: 'mutation',
      },
      () => fileChangeOutcome(path.join(cwd, 'src', 'edited.ts')),
    );

    const result = await dispatch('edit');

    expect(result.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd)).toEqual({
      entries: [{ rel: 'src/edited.ts', op: 'upsert' }],
      dirty: false,
      timerArmed: true,
      flushing: false,
    });
  });

  it('enqueues upserts and one delete from a mixed apply_patch, skipping errored entries', async () => {
    registerFakeTool(
      {
        name: 'apply_patch',
        resultFamily: 'generic',
        outputDataSchema: applyPatchResultDataSchema,
        riskClass: 'mutation',
      },
      () => applyPatchOutcome([
        { path: 'src/created.ts', operation: 'create', status: 'complete' },
        { path: 'src/updated.ts', operation: 'update', status: 'complete' },
        { path: 'src/gone.ts', operation: 'delete', status: 'complete' },
        {
          path: 'src/failed.ts',
          operation: 'update',
          status: 'error',
          error: { code: 'match_failed', message: 'no match' },
        },
      ]),
    );

    const result = await dispatch('apply_patch');

    expect(result.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd)).toEqual({
      entries: [
        { rel: 'src/created.ts', op: 'upsert' },
        { rel: 'src/updated.ts', op: 'upsert' },
        { rel: 'src/gone.ts', op: 'delete' },
      ],
      dirty: false,
      timerArmed: true,
      flushing: false,
    });
  });

  it('splits an apply_patch move into a source delete plus a destination upsert', async () => {
    registerFakeTool(
      {
        name: 'apply_patch',
        resultFamily: 'generic',
        outputDataSchema: applyPatchResultDataSchema,
        riskClass: 'mutation',
      },
      () => applyPatchOutcome([
        {
          path: 'src/old-name.ts',
          operation: 'update',
          status: 'complete',
          movePath: 'src/new-name.ts',
        },
      ]),
    );

    const result = await dispatch('apply_patch');

    expect(result.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd)).toEqual({
      entries: [
        { rel: 'src/old-name.ts', op: 'delete' },
        { rel: 'src/new-name.ts', op: 'upsert' },
      ],
      dirty: false,
      timerArmed: true,
      flushing: false,
    });
  });

  it('keeps the source delete when an apply_patch move destination escapes the workspace', async () => {
    registerFakeTool(
      {
        name: 'apply_patch',
        resultFamily: 'generic',
        outputDataSchema: applyPatchResultDataSchema,
        riskClass: 'mutation',
      },
      () => applyPatchOutcome([
        {
          path: 'src/moved.ts',
          operation: 'update',
          status: 'complete',
          movePath: '../outside.ts',
        },
      ]),
    );

    const result = await dispatch('apply_patch', 'patch-move-outside');

    expect(result.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd).entries).toEqual([
      { rel: 'src/moved.ts', op: 'delete' },
    ]);
  });

  it('enqueues an upsert per mutated file from rename_symbol and replace_symbol results', async () => {
    registerFakeTool(
      {
        name: 'rename_symbol',
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        riskClass: 'mutation',
      },
      () => genericOutcome({
        oldName: 'greet',
        newName: 'salute',
        files: 2,
        success: true,
        edits: [
          { path: 'src/greeter.ts', replacements: 2 },
          { path: 'src/greeter.test.ts', replacements: 1 },
          {
            path: 'src/locked.ts',
            success: false,
            replacements: 0,
            replaceAll: false,
            added: 0,
            removed: 0,
            error: 'EACCES: permission denied',
          },
        ],
      }, 'rename_symbol'),
    );
    registerFakeTool(
      {
        name: 'replace_symbol',
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        riskClass: 'mutation',
      },
      () => genericOutcome({
        file: path.join(cwd, 'src', 'geometry.ts'),
        symbol: 'areaOfCircle',
        success: true,
        replacements: 1,
        items: [{ oldString: 'return 3.14 * r * r;', newString: 'return Math.PI * r * r;' }],
      }, 'replace_symbol'),
    );

    const renameResult = await dispatch('rename_symbol', 'rename-call');
    expect(renameResult.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd).entries).toEqual([
      { rel: 'src/greeter.ts', op: 'upsert' },
      { rel: 'src/greeter.test.ts', op: 'upsert' },
    ]);

    const replaceResult = await dispatch('replace_symbol', 'replace-call');
    expect(replaceResult.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd).entries).toEqual([
      { rel: 'src/greeter.ts', op: 'upsert' },
      { rel: 'src/greeter.test.ts', op: 'upsert' },
      { rel: 'src/geometry.ts', op: 'upsert' },
    ]);
  });

  it('enqueues nothing for error and cancelled outcomes', async () => {
    const writeData = fileWriteOutcome(path.join(cwd, 'src', 'x.ts')).data;
    registerFakeTool(
      {
        name: 'write',
        resultFamily: 'file-write',
        outputDataSchema: fileWriteDataSchema,
        riskClass: 'mutation',
      },
      () => ({ status: 'error', data: writeData, error: { code: 'disk_full', message: 'nope' } }),
    );
    registerFakeTool(
      {
        name: 'edit',
        resultFamily: 'file-change',
        outputDataSchema: fileChangeDataSchema,
        riskClass: 'mutation',
      },
      () => {
        const outcome = fileChangeOutcome(path.join(cwd, 'src', 'y.ts'));
        return { status: 'cancelled', data: outcome.data };
      },
    );

    const errorResult = await dispatch('write', 'write-error');
    const cancelledResult = await dispatch('edit', 'edit-cancelled');

    expect(errorResult.canonical.status).toBe('error');
    expect(cancelledResult.canonical.status).toBe('cancelled');
    expect(_getPendingIndexRefreshForTests(cwd)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });
  });

  it('marks the project dirty for a completed execute_command but not for a read-only tool', async () => {
    registerFakeTool(
      {
        name: 'execute_command',
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        riskClass: 'execution',
      },
      () => genericOutcome('command ran'),
    );
    registerFakeTool(
      {
        name: 'read',
        resultFamily: 'file-content',
        outputDataSchema: fileContentDataSchema,
        riskClass: 'read-only',
      },
      () => fileContentOutcome(path.join(cwd, 'src', 'a.ts')),
    );

    const readResult = await dispatch('read', 'read-call');
    expect(readResult.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });

    const commandResult = await dispatch('execute_command', 'command-call');
    expect(commandResult.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd)).toEqual({
      entries: [],
      dirty: true,
      timerArmed: true,
      flushing: false,
    });
  });

  it('does not mark the project dirty when execute_command spawns a background process', async () => {
    // Mirrors the real background spawn facts: the outcome is complete while
    // the process is still running, so dispatch must defer the dirty mark to
    // the background store's process-exit path.
    registerFakeTool(
      {
        name: 'execute_command',
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        riskClass: 'execution',
      },
      () => genericOutcome({
        commandId: 7,
        command: 'npm run watch',
        description: 'npm run watch',
        background: true,
        running: true,
        createdAt: 1_700_000_000_000,
      }, 'execute_command'),
    );

    const result = await dispatch('execute_command', 'background-command-call');

    expect(result.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });
  });

  it('drops mutated paths that escape the workspace', async () => {
    registerFakeTool(
      {
        name: 'write',
        resultFamily: 'file-write',
        outputDataSchema: fileWriteDataSchema,
        riskClass: 'mutation',
      },
      () => fileWriteOutcome(path.join(root, 'outside.ts')),
    );
    registerFakeTool(
      {
        name: 'apply_patch',
        resultFamily: 'generic',
        outputDataSchema: applyPatchResultDataSchema,
        riskClass: 'mutation',
      },
      () => applyPatchOutcome([
        { path: '../sibling.ts', operation: 'update', status: 'complete' },
        { path: 'src/inside.ts', operation: 'update', status: 'complete' },
      ]),
    );

    const outsideResult = await dispatch('write', 'write-outside');
    expect(outsideResult.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd).entries).toEqual([]);

    const patchResult = await dispatch('apply_patch', 'patch-mixed');
    expect(patchResult.canonical.status).toBe('complete');
    expect(_getPendingIndexRefreshForTests(cwd).entries).toEqual([
      { rel: 'src/inside.ts', op: 'upsert' },
    ]);
  });

  it('leaves the tool result byte-identical when the coordinator throws', async () => {
    registerFakeTool(
      {
        name: 'write',
        resultFamily: 'file-write',
        outputDataSchema: fileWriteDataSchema,
        riskClass: 'mutation',
      },
      () => fileWriteOutcome(path.join(cwd, 'src', 'boom.ts')),
    );

    const control = await dispatch('write', 'write-control');
    coordinatorHooks.enqueueMutation = () => {
      throw new Error('coordinator exploded');
    };

    const withThrow = await dispatch('write', 'write-throw');

    expect(withThrow.canonical.status).toBe('complete');
    expect(withThrow).toEqual(control);
    expect(warnSpy).toHaveBeenCalledWith(
      '[tool-dispatch] index refresh notify failed',
      expect.objectContaining({ toolName: 'write' }),
    );
  });
});
