import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyPatchHandler, applyPatchDefinition } from '../../src/main/tools/filesystem/apply-patch';
import type { ToolExecutionContext } from '../../src/main/tools/types';
import type { ApplyPatchResultData } from '../../src/shared/types/tool-result-apply-patch';
import type { CanonicalToolResult } from '../../src/shared/types/tool-result';
import type { FileChangeData } from '../../src/shared/types/tool-result-filesystem';

let tmpDir: string;

function toolCtx(): ToolExecutionContext {
  return { cwd: tmpDir };
}

function writeFile(relPath: string, content: string): string {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(tmpDir, relPath), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-patch-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('apply_patch handler', () => {
  it('applies a single-file update', async () => {
    writeFile('hello.ts', 'const a = 1;\nconst b = 2;\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: hello.ts',
      '@@',
      '-const a = 1;',
      '+const a = 42;',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.modified).toBe(1);
    expect(data.added).toBe(0);
    expect(data.deleted).toBe(0);
    expect(data.failed).toBe(0);
    expect(readFile('hello.ts')).toBe('const a = 42;\nconst b = 2;\n');
  });

  it('applies a multi-file patch (add + update + delete)', async () => {
    writeFile('existing.ts', 'old content\n');
    writeFile('remove-me.txt', 'delete this\n');

    const patch = [
      '*** Begin Patch',
      '*** Add File: new-file.ts',
      '+export const x = 1;',
      '*** Update File: existing.ts',
      '@@',
      '-old content',
      '+new content',
      '*** Delete File: remove-me.txt',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.added).toBe(1);
    expect(data.modified).toBe(1);
    expect(data.deleted).toBe(1);
    expect(data.failed).toBe(0);
    expect(readFile('new-file.ts')).toBe('export const x = 1;\n');
    expect(readFile('existing.ts')).toBe('new content\n');
    expect(fs.existsSync(path.join(tmpDir, 'remove-me.txt'))).toBe(false);
  });

  it('renames a file via *** Move to:', async () => {
    writeFile('old-name.ts', 'const val = 1;\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: old-name.ts',
      '*** Move to: new-name.ts',
      '@@',
      '-const val = 1;',
      '+const val = 2;',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.modified).toBe(1);
    expect(data.files[0].movePath).toBe('new-name.ts');
    expect(fs.existsSync(path.join(tmpDir, 'old-name.ts'))).toBe(false);
    expect(readFile('new-name.ts')).toBe('const val = 2;\n');
  });

  it('creates parent directories for added files', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: deep/nested/dir/file.ts',
      '+export const deep = true;',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    expect(readFile('deep/nested/dir/file.ts')).toBe('export const deep = true;\n');
  });

  it('returns error for a patch with no hunks', async () => {
    const patch = [
      '*** Begin Patch',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.code).toBe('empty_patch');
    }
  });

  it('returns per-file error for updating a nonexistent file', async () => {
    writeFile('exists.ts', 'content\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: missing.ts',
      '@@',
      '-foo',
      '+bar',
      '*** Update File: exists.ts',
      '@@',
      '-content',
      '+updated',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.modified).toBe(1);
    expect(data.files[0].status).toBe('error');
    expect(data.files[1].status).toBe('complete');
    expect(readFile('exists.ts')).toBe('updated\n');
  });

  it('returns per-file error for deleting a nonexistent file', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Delete File: ghost.txt',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].status).toBe('error');
    expect(data.files[0].error?.code).toBe('not_found');
  });

  it('reports match failure for one file while others succeed', async () => {
    writeFile('good.ts', 'alpha\nbeta\n');
    writeFile('bad.ts', 'one\ntwo\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: bad.ts',
      '@@',
      '-THIS DOES NOT EXIST',
      '+replacement',
      '*** Update File: good.ts',
      '@@',
      '-alpha',
      '+omega',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.modified).toBe(1);
    expect(data.files[0].error?.code).toBe('match_failed');
    expect(readFile('good.ts')).toBe('omega\nbeta\n');
    expect(readFile('bad.ts')).toBe('one\ntwo\n');
  });

  it('rejects absolute paths with path_traversal error', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: /etc/evil.conf',
      '+malicious',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].error?.code).toBe('path_traversal');
  });

  it('rejects ../../ traversal with path_traversal error', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: ../../etc/passwd',
      '+root:x:0:0',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].error?.code).toBe('path_traversal');
  });

  it('returns error for invalid patch syntax', async () => {
    const patch = 'this is not a valid patch at all';

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.code).toBe('parse_error');
    }
  });

  it('rejects a premature End Patch marker before creating any files', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: first.txt',
      '+first',
      '*** End Patch',
      '*** Add File: second.txt',
      '+second',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.code).toBe('parse_error');
    }
    expect(fs.existsSync(path.join(tmpDir, 'first.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'second.txt'))).toBe(false);
  });

  it('rejects Windows absolute paths with path_traversal error', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: C:\\repo\\evil.conf',
      '+malicious',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].error?.code).toBe('path_traversal');
  });

  it('move-path traversal leaves source unchanged', async () => {
    writeFile('source.ts', 'const x = 1;\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: source.ts',
      '*** Move to: ../../outside.ts',
      '@@',
      '-const x = 1;',
      '+const x = 2;',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].error?.code).toBe('path_traversal');
    expect(readFile('source.ts')).toBe('const x = 1;\n');
    expect(fs.existsSync(path.join(tmpDir, '..', 'outside.ts'))).toBe(false);
  });

  it('move-path absolute path leaves source unchanged', async () => {
    writeFile('source.ts', 'const x = 1;\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: source.ts',
      '*** Move to: /tmp/evil.ts',
      '@@',
      '-const x = 1;',
      '+const x = 2;',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].error?.code).toBe('path_traversal');
    expect(readFile('source.ts')).toBe('const x = 1;\n');
  });

  it('Windows absolute move path leaves source unchanged', async () => {
    writeFile('source.ts', 'const x = 1;\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: source.ts',
      '*** Move to: C:\\repo\\evil.ts',
      '@@',
      '-const x = 1;',
      '+const x = 2;',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].error?.code).toBe('path_traversal');
    expect(readFile('source.ts')).toBe('const x = 1;\n');
  });

  it('add file onto existing file fails with already_exists', async () => {
    writeFile('target.ts', 'original content\n');

    const patch = [
      '*** Begin Patch',
      '*** Add File: target.ts',
      '+overwritten content',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].error?.code).toBe('already_exists');
    expect(readFile('target.ts')).toBe('original content\n');
  });

  // ── F-tests from the comprehensive test report ─────────────────────────

  it('F3: updating a symlink patches the target, preserves the symlink', async () => {
    // Create a real target file and a symlink pointing to it.
    const targetPath = path.join(tmpDir, 'real.txt');
    const linkPath = path.join(tmpDir, 'link.txt');
    fs.writeFileSync(targetPath, 'line1\nold\nline3\n', 'utf-8');
    fs.symlinkSync(targetPath, linkPath);

    const patch = [
      '*** Begin Patch',
      '*** Update File: link.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.modified).toBe(1);
    // Symlink is preserved.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // Target file has the patched content.
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('line1\nnew\nline3\n');
  });

  it('F5: Move to existing destination fails with move_target_exists', async () => {
    writeFile('source.ts', 'const x = 1;\n');
    writeFile('dest.ts', 'existing content\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: source.ts',
      '*** Move to: dest.ts',
      '@@',
      '-const x = 1;',
      '+const x = 2;',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].error?.code).toBe('move_target_exists');
    // Both files are unchanged.
    expect(readFile('source.ts')).toBe('const x = 1;\n');
    expect(readFile('dest.ts')).toBe('existing content\n');
  });

  it('F9: no-op hunk (context only) does not increment modified', async () => {
    writeFile('ctx.txt', 'aaa\nbbb\nccc\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: ctx.txt',
      '@@',
      ' aaa',
      ' bbb',
      ' ccc',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.modified).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.files[0].status).toBe('complete');
    // File content is unchanged.
    expect(readFile('ctx.txt')).toBe('aaa\nbbb\nccc\n');
  });

  it('F10: Add File with trailing slash fails with invalid_path', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: dir/',
      '+content',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].error?.code).toBe('invalid_path');
  });

  it('F2: *** End of File anchor enforced — fails when match is not at EOF', async () => {
    writeFile('f.txt', 'aaa\nbbb\nccc\nddd\neee\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '-bbb',
      '-ccc',
      '+BBB',
      '+CCC',
      '*** End of File',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].error?.code).toBe('match_failed');
    expect(data.files[0].error?.message).toContain('End of File anchor failed');
  });

  it('F6: ambiguous hunk without @@ fails with match_failed', async () => {
    writeFile('amb.txt', 'foo\nbar\nfoo\nbar\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: amb.txt',
      '-foo',
      '-bar',
      '+FOO',
      '+BAR',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.failed).toBe(1);
    expect(data.files[0].error?.code).toBe('match_failed');
    expect(data.files[0].error?.message).toContain('matches multiple locations');
  });

  it('F4: CRLF line endings preserved across the whole file', async () => {
    writeFile('crlf.txt', 'line1\r\nline2\r\nline3\r\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: crlf.txt',
      '@@',
      '-line2',
      '+LINE2',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.modified).toBe(1);
    expect(readFile('crlf.txt')).toBe('line1\r\nLINE2\r\nline3\r\n');
  });

  it('F7: file without trailing newline stays without one', async () => {
    writeFile('nonl.txt', 'first\nsecond\nthird');

    const patch = [
      '*** Begin Patch',
      '*** Update File: nonl.txt',
      '@@',
      '-second',
      '+SECOND',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.modified).toBe(1);
    expect(readFile('nonl.txt')).toBe('first\nSECOND\nthird');
  });

  it('F1: context line whitespace preserved from file, not patch', async () => {
    // File has trailing spaces on a context line; the patch's context line
    // lacks them. The file's version must be preserved.
    writeFile('ws.txt', 'hello   \nold\nworld\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: ws.txt',
      ' hello',
      '-old',
      '+new',
      ' world',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchHandler({ patch }, toolCtx());

    expect(result.status).toBe('complete');
    const data = result.data as ApplyPatchResultData;
    expect(data.modified).toBe(1);
    // The trailing spaces on 'hello   ' are preserved (file's version).
    expect(readFile('ws.txt')).toBe('hello   \nnew\nworld\n');
  });
});

describe('apply_patch agentProjector', () => {
  const projector = applyPatchDefinition.agentProjector!;

  function canonical(data: ApplyPatchResultData, status: 'complete' | 'error' = 'complete'): CanonicalToolResult {
    return {
      schemaVersion: 1,
      family: 'generic',
      status,
      completeness: 'complete',
      data,
    };
  }

  function fileChange(overrides: Partial<FileChangeData> & { hunks: FileChangeData['hunks'] }): FileChangeData {
    return {
      path: 'file.ts',
      operation: 'update',
      addedLines: 0,
      removedLines: 0,
      resultingContent: '',
      ...overrides,
    };
  }

  it('renders mixed success/error multi-file result', () => {
    const data: ApplyPatchResultData = {
      files: [
        {
          path: 'new.ts',
          operation: 'create',
          status: 'complete',
          fileChange: fileChange({
            path: 'new.ts',
            operation: 'create',
            addedLines: 1,
            hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: 'add', content: 'export const x = 1;', newLineNumber: 1 }] }],
            resultingContent: 'export const x = 1;\n',
          }),
        },
        {
          path: 'src/app.ts',
          operation: 'update',
          status: 'complete',
          fileChange: fileChange({
            path: 'src/app.ts',
            operation: 'update',
            addedLines: 1,
            removedLines: 1,
            hunks: [{
              oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
              lines: [
                { kind: 'context', content: 'import { a } from "./a";', oldLineNumber: 1, newLineNumber: 1 },
                { kind: 'remove', content: 'const old = true;', oldLineNumber: 2 },
                { kind: 'add', content: 'const updated = true;', newLineNumber: 2 },
                { kind: 'context', content: 'export default old;', oldLineNumber: 3, newLineNumber: 3 },
              ],
            }],
            resultingContent: 'import { a } from "./a";\nconst updated = true;\nexport default old;\n',
          }),
        },
        {
          path: 'bad.ts',
          operation: 'update',
          status: 'error',
          error: { code: 'match_failed', message: 'Could not match hunk' },
        },
      ],
      added: 1,
      modified: 1,
      deleted: 0,
      failed: 1,
    };

    const result = projector(canonical(data));

    expect(result.content).toContain('<tool_result name="apply_patch"');
    expect(result.content).toContain('<file path="new.ts" operation="create" status="complete"');
    expect(result.content).toContain('<file path="src/app.ts" operation="update" status="complete"');
    expect(result.content).toContain('<file path="bad.ts" operation="update" status="error"');
    expect(result.content).toContain('<error code="match_failed"');
    expect(result.content).toContain('3 files');
    expect(result.content).toContain('1 failed');
  });

  it('renders move_path attribute', () => {
    const data: ApplyPatchResultData = {
      files: [
        {
          path: 'old.ts',
          operation: 'update',
          status: 'complete',
          movePath: 'new-location.ts',
          fileChange: fileChange({
            path: 'old.ts',
            operation: 'update',
            addedLines: 1,
            removedLines: 1,
            hunks: [{
              oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
              lines: [
                { kind: 'remove', content: 'const a = 1;', oldLineNumber: 1 },
                { kind: 'add', content: 'const a = 2;', newLineNumber: 1 },
              ],
            }],
            resultingContent: 'const a = 2;\n',
          }),
        },
      ],
      added: 0,
      modified: 1,
      deleted: 0,
      failed: 0,
    };

    const result = projector(canonical(data));

    expect(result.content).toContain('move_path="new-location.ts"');
  });

  it('renders delete-only result with empty file body', () => {
    const data: ApplyPatchResultData = {
      files: [
        { path: 'obsolete.txt', operation: 'delete', status: 'complete' },
      ],
      added: 0,
      modified: 0,
      deleted: 1,
      failed: 0,
    };

    const result = projector(canonical(data));

    expect(result.content).toContain('<file path="obsolete.txt" operation="delete" status="complete"');
    expect(result.content).toContain('<file path="obsolete.txt" operation="delete" status="complete">\n</file>');
    expect(result.content).not.toContain('<old_string>');
    expect(result.content).not.toContain('<new_string>');
  });

  it('omits failed attribute when failed=0', () => {
    const data: ApplyPatchResultData = {
      files: [
        { path: 'a.ts', operation: 'create', status: 'complete' },
        { path: 'b.ts', operation: 'delete', status: 'complete' },
      ],
      added: 1,
      modified: 0,
      deleted: 1,
      failed: 0,
    };

    const result = projector(canonical(data));

    expect(result.content).not.toContain('failed=');
  });

  it('escapes XML metacharacters in paths', () => {
    const data: ApplyPatchResultData = {
      files: [
        { path: 'src/say "hi" & <bye>.ts', operation: 'delete', status: 'complete' },
      ],
      added: 0,
      modified: 0,
      deleted: 1,
      failed: 0,
    };

    const result = projector(canonical(data));

    expect(result.content).toContain('&quot;');
    expect(result.content).toContain('&amp;');
    expect(result.content).toContain('&lt;');
    expect(result.content).not.toContain('path="src/say "hi"');
    expect(result.content).not.toContain('<bye>');
  });

  it('renders old_string/new_string from hunks', () => {
    const data: ApplyPatchResultData = {
      files: [
        {
          path: 'src/util.ts',
          operation: 'update',
          status: 'complete',
          fileChange: fileChange({
            path: 'src/util.ts',
            operation: 'update',
            addedLines: 1,
            removedLines: 1,
            hunks: [{
              oldStart: 10, oldLines: 4, newStart: 10, newLines: 4,
              lines: [
                { kind: 'context', content: 'function greet() {', oldLineNumber: 10, newLineNumber: 10 },
                { kind: 'remove', content: '  return "hi";', oldLineNumber: 11 },
                { kind: 'add', content: '  return "hello";', newLineNumber: 11 },
                { kind: 'context', content: '}', oldLineNumber: 12, newLineNumber: 12 },
              ],
            }],
            resultingContent: '',
          }),
        },
      ],
      added: 0,
      modified: 1,
      deleted: 0,
      failed: 0,
    };

    const result = projector(canonical(data));

    expect(result.content).toContain('<old_string>');
    expect(result.content).toContain('function greet() {\n  return "hi";\n}');
    expect(result.content).toContain('<new_string>');
    expect(result.content).toContain('function greet() {\n  return "hello";\n}');
  });

  it('F11: counts unique file paths in summary (not operations)', () => {
    // Two operations on the same file — the summary should say "1 file", not "2 files".
    const data: ApplyPatchResultData = {
      files: [
        {
          path: 'same.ts',
          operation: 'update',
          status: 'complete',
          fileChange: fileChange({
            path: 'same.ts',
            operation: 'update',
            addedLines: 1,
            removedLines: 1,
            hunks: [{
              oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
              lines: [
                { kind: 'remove', content: 'old', oldLineNumber: 1 },
                { kind: 'add', content: 'new1', newLineNumber: 1 },
              ],
            }],
            resultingContent: '',
          }),
        },
        {
          path: 'same.ts',
          operation: 'update',
          status: 'complete',
          fileChange: fileChange({
            path: 'same.ts',
            operation: 'update',
            addedLines: 1,
            removedLines: 1,
            hunks: [{
              oldStart: 5, oldLines: 1, newStart: 5, newLines: 1,
              lines: [
                { kind: 'remove', content: 'x', oldLineNumber: 5 },
                { kind: 'add', content: 'y', newLineNumber: 5 },
              ],
            }],
            resultingContent: '',
          }),
        },
      ],
      added: 0,
      modified: 2,
      deleted: 0,
      failed: 0,
    };

    const result = projector(canonical(data));

    expect(result.content).toContain('1 file:');
    expect(result.content).not.toContain('2 files');
  });
});
