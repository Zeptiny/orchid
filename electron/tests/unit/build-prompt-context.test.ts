/**
 * Dynamic system prompt context population (P0-1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildSystemPromptContext,
  __resetDirectoryTreeCacheForTests,
} from '../../src/main/llm/build-prompt-context';
import { buildSystemPrompt } from '../../src/main/llm/system-prompt';
import { defaults } from '../../src/main/config/schema';

describe('buildSystemPromptContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-prompt-ctx-'));
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'hi');
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'export {}');
    __resetDirectoryTreeCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    __resetDirectoryTreeCacheForTests();
  });

  it('includes directory tree and injected todos', async () => {
    const config = defaults();
    const ctx = await buildSystemPromptContext({
      cwd: tmpDir,
      config,
      getTodos: () => [
        {
          id: 'abcd1234',
          title: 'Ship P0',
          status: 'IN_PROGRESS',
        },
      ],
    });

    expect(ctx.cwd).toBe(tmpDir);
    expect(ctx.directoryTree).toContain('hello.txt');
    expect(ctx.directoryTree).toContain('src/');
    expect(ctx.todos).toHaveLength(1);
    expect(ctx.todos![0]!.title).toBe('Ship P0');
    expect(ctx.subagents).toEqual([]);
    expect(ctx.backgroundCommands).toEqual([]);

    const prompt = buildSystemPrompt('Be helpful.', ctx);
    expect(prompt).toContain('<working_directory>');
    expect(prompt).toContain('<directory_structure>');
    expect(prompt).toContain('hello.txt');
    expect(prompt).toContain('<todos>');
    expect(prompt).toContain('Ship P0');
    expect(prompt).toContain('IN_PROGRESS');
  });
});
