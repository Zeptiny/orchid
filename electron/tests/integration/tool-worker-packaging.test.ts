import * as path from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { createBuiltinToolRegistry } from '../../src/main/tools';
import { createToolWorkerRegistry } from '../../src/main/tools/worker-registry';

describe('tool worker packaging boundary', () => {
  it('registers every and only tool marked for worker offloading', () => {
    const offloadedNames = createBuiltinToolRegistry()
      .listAll()
      .filter((tool) => tool.definition.offload)
      .map((tool) => tool.definition.name)
      .sort();
    const workerNames = createToolWorkerRegistry()
      .listAll()
      .map((tool) => tool.definition.name)
      .sort();

    expect(workerNames).toEqual(offloadedNames);
  });

  it('does not pull Electron main-process APIs into the worker bundle', async () => {
    const appRoot = path.resolve(__dirname, '../..');
    const result = await build({
      absWorkingDir: appRoot,
      entryPoints: ['src/main/tools/tool-worker.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });

    const externalImports = Object.values(result.metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((entry) => entry.external)
      .map((entry) => entry.path);

    expect(externalImports).not.toContain('electron');
  });
});
