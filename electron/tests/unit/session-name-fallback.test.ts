import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionNames } from '../../src/main/session/storage';
import { resolveSessionNamesWithFallback } from '../../src/main/providers/accounting/analytics-queries';
import {
  getProviderAccountingStore,
  initializeProviderAccountingStore,
  resetProviderAccountingStore,
} from '../../src/main/providers/accounting/store';

vi.mock('../../src/main/session/storage', () => ({
  getSessionNames: vi.fn(),
}));

const mockedGetSessionNames = vi.mocked(getSessionNames);

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-name-fallback-'));
  initializeProviderAccountingStore({ dbPath: path.join(tempDir, 'accounting.db') });
  mockedGetSessionNames.mockReset();
});

afterEach(() => {
  resetProviderAccountingStore();
  mockedGetSessionNames.mockReset();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveSessionNamesWithFallback precedence', () => {
  it('live sessions.db names win; only missing ids fall back to tombstones', () => {
    const store = getProviderAccountingStore();
    // Both a live row and a tombstone exist for 'live-id' — the live (renamed)
    // name must win. Only the deleted id resolves via the tombstone.
    store.upsertSessionNameTombstone('live-id', 'Old Name');
    store.upsertSessionNameTombstone('deleted-id', 'Gone Name');
    mockedGetSessionNames.mockReturnValue(new Map([['live-id', 'Renamed Live Name']]));

    const resolved = resolveSessionNamesWithFallback(store.getDatabase(), ['live-id', 'deleted-id', 'unknown-id']);

    expect(resolved.get('live-id')).toBe('Renamed Live Name');
    expect(resolved.get('deleted-id')).toBe('Gone Name');
    expect(resolved.has('unknown-id')).toBe(false);
  });

  it('degrades to tombstones when the live lookup fails outright', () => {
    const store = getProviderAccountingStore();
    store.upsertSessionNameTombstone('deleted-id', 'Gone Name');
    mockedGetSessionNames.mockImplementation(() => {
      throw new Error('sessions.db unavailable');
    });

    const resolved = resolveSessionNamesWithFallback(store.getDatabase(), ['deleted-id']);
    expect(resolved.get('deleted-id')).toBe('Gone Name');
  });
});
