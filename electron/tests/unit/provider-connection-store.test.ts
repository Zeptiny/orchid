import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectionStore,
  _clearConnectionStoreWriteChains,
} from '../../src/main/providers/connection-store';

let tmpDir: string;
let providersPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-provider-store-'));
  providersPath = path.join(tmpDir, 'providers.json');
  _clearConnectionStoreWriteChains();
});

afterEach(() => {
  _clearConnectionStoreWriteChains();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createStore(): ConnectionStore {
  return new ConnectionStore({ providersPath });
}

function input(name: string, handle: string) {
  return {
    providerId: 'openai',
    name,
    protocol: 'openai-compatible' as const,
    authMethod: 'api-key' as const,
    credential: { kind: 'stored' as const, handle },
    modelIds: ['vendor/path/model'],
    health: 'ready' as const,
  };
}

describe('ConnectionStore', () => {
  it('round-trips non-secret connections with restrictive permissions', async () => {
    const created = await createStore().create(input('Work', 'credential-work-v1'));
    const reloaded = await createStore().get(created.id);

    expect(reloaded).toEqual(created);
    const raw = fs.readFileSync(providersPath, 'utf8');
    expect(raw).toContain('credential-work-v1');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('sk-');
    expect(fs.statSync(path.dirname(providersPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(providersPath).mode & 0o777).toBe(0o600);
  });

  it('does not mutate a sibling connection or credential reference when one is disabled or removed', async () => {
    const store = createStore();
    const work = await store.create(input('Work', 'credential-work-v1'));
    const personal = await store.create(input('Personal', 'credential-personal-v1'));

    await store.update(work.id, { health: 'disabled' });
    expect(await store.get(personal.id)).toEqual(personal);

    expect(await store.remove(work.id)).toEqual(expect.objectContaining({ id: work.id }));
    expect(await store.get(work.id)).toBeNull();
    expect(await store.get(personal.id)).toEqual(personal);
  });

  it('returns null when removing an unknown connection', async () => {
    await expect(createStore().remove('33333333-3333-4333-8333-333333333333'))
      .resolves.toBeNull();
  });

  it('serializes concurrent mutations across store instances without losing entries', async () => {
    const first = createStore();
    const second = createStore();

    await Promise.all([
      first.create(input('Work', 'credential-work-v1')),
      second.create(input('Personal', 'credential-personal-v1')),
    ]);

    expect(await createStore().list()).toHaveLength(2);
  });

  it('rejects duplicate generated ids and secret-bearing inputs', async () => {
    const duplicateId = '33333333-3333-4333-8333-333333333333';
    const store = new ConnectionStore({ providersPath, idFactory: () => duplicateId });
    await store.create(input('Work', 'credential-work-v1'));
    await expect(store.create(input('Personal', 'credential-personal-v1'))).rejects.toThrow(/duplicate/i);
    await expect(createStore().create({
      ...input('Invalid', 'credential-invalid-v1'),
      apiKey: 'sk-should-not-pass',
    } as never)).rejects.toThrow();
  });

  it('rejects credential-bearing endpoint URLs on create and update', async () => {
    const store = createStore();
    await expect(store.create({
      ...input('Invalid endpoint', 'credential-invalid-v1'),
      endpoint: 'https://user:secret@example.test/v1',
    })).rejects.toThrow(/credentials/i);

    const created = await store.create({
      ...input('Safe endpoint', 'credential-safe-v1'),
      endpoint: 'https://example.test/v1',
    });
    await expect(store.update(created.id, {
      endpoint: 'https://example.test/v1?api_key=secret',
    })).rejects.toThrow(/query parameters/i);

    expect(fs.readFileSync(providersPath, 'utf8')).not.toContain('secret');
  });
});
