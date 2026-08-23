import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const guardPath = path.resolve(process.cwd(), 'scripts/check-host-boundary.mjs');
const fixtureRoots: string[] = [];

function makeFixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-host-boundary-'));
  fixtureRoots.push(root);

  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(root, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  return root;
}

function runGuard(...args: string[]): { status: number; output: string } {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [guardPath, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('host boundary guard', () => {
  it('keeps every file reachable from the real host-core roots free of electron imports', () => {
    const result = runGuard();

    expect(result.status).toBe(0);
  });

  it('fails when a file reachable from a root imports electron', () => {
    const root = makeFixture({
      'core/entry.ts': "import { helper } from './nested/helper';\nexport const entry = helper;\n",
      'core/nested/helper.ts': "import { ipcMain } from 'electron';\nexport const helper = ipcMain;\n",
    });

    const result = runGuard(path.join(root, 'core'));

    expect(result.status).not.toBe(0);
    expect(result.output.replaceAll('\\', '/')).toContain('core/nested/helper.ts');
    expect(result.output).toContain("imports 'electron'");
  });

  it('counts type-only electron imports as boundary violations', () => {
    const root = makeFixture({
      'core/entry.ts': "import type { Helper } from './helper';\nexport type Entry = Helper;\n",
      'core/helper.ts': "import type { WebContents } from 'electron';\nexport type Helper = WebContents;\n",
    });

    const result = runGuard(path.join(root, 'core'));

    expect(result.status).not.toBe(0);
    expect(result.output.replaceAll('\\', '/')).toContain('core/helper.ts');
  });

  it('passes a root whose reachable graph stays electron-free', () => {
    const root = makeFixture({
      'core/entry.ts': "import { helper } from './helper';\nexport const entry = helper;\n",
      'core/helper.ts': "import { randomUUID } from 'node:crypto';\nexport const helper = randomUUID;\n",
    });

    expect(runGuard(path.join(root, 'core'))).toMatchObject({ status: 0 });
  });
});
