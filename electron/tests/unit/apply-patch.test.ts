import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyPatchHandler } from '../../src/main/tools/filesystem/apply-patch';
import type { ToolExecutionContext } from '../../src/main/tools/types';
import type { ApplyPatchResultData } from '../../src/shared/types/tool-result-apply-patch';

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
});
