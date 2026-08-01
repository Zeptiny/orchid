import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const guardPath = path.resolve(process.cwd(), 'scripts/check-runtime-cycles.mjs');
const fixtureRoots: string[] = [];

function makeFixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-runtime-cycle-'));
  fixtureRoots.push(root);

  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(root, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  return root;
}

function runGuard(root: string): { status: number; output: string } {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [guardPath, root], {
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

function runGuardFromCwd(cwd: string): { status: number; output: string } {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [guardPath], {
        cwd,
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

describe('runtime dependency cycle guard', () => {
  it('defaults to the src directory beneath the current working directory', () => {
    const root = makeFixture({
      'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
      'src/b.ts': "import { a } from './a';\nexport const b = a;\n",
    });

    const result = runGuardFromCwd(root);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.ts');
  });

  it('fails for a two-file runtime cycle and prints its concrete edge path', () => {
    const root = makeFixture({
      'a.ts': "import { b } from './b';\nexport const a = b;\n",
      'b.ts': "import { a } from './a';\nexport const b = a;\n",
    });

    const result = runGuard(root);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.ts');
    expect(result.output).toMatch(/a\.ts\s*->\s*b\.ts\s*->\s*a\.ts|b\.ts\s*->\s*a\.ts\s*->\s*b\.ts/);
  });

  it('resolves @shared path aliases as local runtime edges', () => {
    const root = makeFixture({
      'main/a.ts': "import { b } from '@shared/b.js';\nexport const a = b;\n",
      'shared/b.ts': "import { a } from '../main/a';\nexport const b = a;\n",
    });

    const result = runGuard(root);
    const output = result.output.replaceAll('\\', '/');

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/main\/a\.ts\s*->\s*shared\/b\.ts\s*->\s*main\/a\.ts|shared\/b\.ts\s*->\s*main\/a\.ts\s*->\s*shared\/b\.ts/);
  });

  it('allows type-only mutual references', () => {
    const root = makeFixture({
      'a.ts': "import type { B } from './b';\nexport type { B } from './b';\nexport interface A { b: B }\n",
      'b.ts': "import type { A } from './a';\nexport type { A } from './a';\nexport interface B { a: A }\n",
    });

    expect(runGuard(root)).toMatchObject({ status: 0 });
  });

  it('keeps empty imports as runtime module edges', () => {
    const root = makeFixture({
      'a.ts': "import {} from './b';\nexport const a = 1;\n",
      'b.ts': "import {} from './a';\nexport const b = 1;\n",
    });

    const result = runGuard(root);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/a\.ts\s*->\s*b\.ts\s*->\s*a\.ts|b\.ts\s*->\s*a\.ts\s*->\s*b\.ts/);
  });

  it('keeps empty re-exports as runtime module edges', () => {
    const root = makeFixture({
      'a.ts': "export {} from './b';\n",
      'b.ts': "export {} from './a';\n",
    });

    const result = runGuard(root);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/a\.ts\s*->\s*b\.ts\s*->\s*a\.ts|b\.ts\s*->\s*a\.ts\s*->\s*b\.ts/);
  });

  it('keeps runtime specifiers in mixed imports and exports', () => {
    const root = makeFixture({
      'a.ts': "import { type B, b } from './b';\nexport { type B, b } from './b';\nexport const a = b;\n",
      'b.ts': "import { type A, a } from './a';\nexport { type A, a } from './a';\nexport const b = a;\n",
    });

    const result = runGuard(root);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.ts');
  });

  it('keeps literal relative require calls as runtime module edges', () => {
    const root = makeFixture({
      'a.ts': "const b = require('./b');\nexport const a = b;\n",
      'b.ts': "const a = require('./a');\nexport const b = a;\n",
    });

    const result = runGuard(root);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/a\.ts\s*->\s*b\.ts\s*->\s*a\.ts|b\.ts\s*->\s*a\.ts\s*->\s*b\.ts/);
  });

  it('keeps literal relative dynamic imports as runtime module edges', () => {
    const root = makeFixture({
      'a.ts': "export const loadB = () => import('./b.js');\n",
      'b.ts': "export const loadA = () => import('./a');\n",
    });

    const result = runGuard(root);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/a\.ts\s*->\s*b\.ts\s*->\s*a\.ts|b\.ts\s*->\s*a\.ts\s*->\s*b\.ts/);
  });

  it('does not treat import type queries as runtime module edges', () => {
    const root = makeFixture({
      'a.ts': "export type A = import('./b').B;\n",
      'b.ts': "export type B = import('./a').A;\n",
    });

    expect(runGuard(root)).toMatchObject({ status: 0 });
  });
});
