import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ELECTRON_ROOT = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(ELECTRON_ROOT, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };

describe('native module runtime lifecycle', () => {
  it('prepares native modules for the runtime used by development and tests', () => {
    expect(fs.existsSync(path.join(ELECTRON_ROOT, 'scripts/ensure-native-runtime.mjs'))).toBe(true);
    expect(packageJson.scripts.predev).toBe('npm run native:ensure:electron');
    expect(packageJson.scripts.pretest).toBe('npm run native:ensure:node');
    expect(packageJson.scripts['pretest:providers:live']).toBe('npm run native:ensure:node');

    expect(packageJson.scripts['native:ensure:electron']).toBe(
      'node scripts/ensure-native-runtime.mjs electron',
    );
    expect(packageJson.scripts['native:ensure:node']).toBe(
      'node scripts/ensure-native-runtime.mjs node',
    );
  });
});
