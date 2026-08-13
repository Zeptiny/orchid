import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateCatalogBytes } from '../../src/main/providers/catalog/trust';

const ELECTRON_ROOT = path.resolve(__dirname, '../..');
const SEED_SCRIPT = path.join(ELECTRON_ROOT, 'scripts/provider-catalog/seed-models-dev.ts');
const SIGN_SCRIPT = path.join(ELECTRON_ROOT, 'scripts/provider-catalog/sign.ts');
const FIXTURE = path.join(ELECTRON_ROOT, 'tests/fixtures/provider-catalog/models-dev-minimal.json');
const BUNDLED_CATALOG = path.join(ELECTRON_ROOT, 'assets/providers/catalog.json');
const NOW = '2026-07-12T00:00:00.000Z';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-provider-catalog-tools-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], {
    cwd: ELECTRON_ROOT,
    encoding: 'utf8',
  });
}

describe('provider catalog operator tools', () => {
  it('ships a strict, offline initial catalog with the complete approved provider set', () => {
    const bytes = fs.readFileSync(BUNDLED_CATALOG);
    const result = validateCatalogBytes(bytes, {
      appVersion: '0.1.0',
      now: new Date(NOW),
    });

    expect(result.stale).toBe(false);
    expect(result.catalog.providers.map((provider) => provider.id)).toEqual([
      'openai',
      'anthropic',
      'google-gemini',
      'xai',
      'opencode-go',
      'lilac',
      'neuralwatt',
      'meta',
      'generic-openai-compatible',
      'generic-anthropic-compatible',
    ]);
    expect(result.catalog.providers.every((provider) => provider.allowsCustomModels)).toBe(true);
    const bundledModels = result.catalog.providers.flatMap((provider) => provider.models);
    expect(bundledModels.every((model) => (
      model.capabilities.outputModalities.every((modality) => modality === 'text' || modality === 'embedding')
    ))).toBe(true);
    // Upstream models.dev no longer publishes embedding-output models; the
    // seed path that retains embedding-only models is covered by the fixture
    // capture below. The bundle must still ship usable text-generation models.
    expect(bundledModels.some((model) => model.capabilities.outputModalities.includes('text'))).toBe(true);
    expect(result.catalog.providers.find((provider) => provider.id === 'lilac')?.models)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'moonshotai/kimi-k2.6',
          pricing: expect.objectContaining({
            rates: expect.objectContaining({
              input: expect.objectContaining({ amount: '0.7' }),
            }),
          }),
        }),
      ]));
    expect(bytes.toString('utf8')).not.toMatch(/private key|BEGIN.*PRIVATE/i);
  });

  it('transforms a pinned models.dev capture deterministically and retains its hash provenance', () => {
    const first = path.join(tempDir, 'first.json');
    const second = path.join(tempDir, 'second.json');
    const common = [
      '--input', FIXTURE,
      '--captured-at', NOW,
      '--catalog-version', '42',
      '--expires-at', '2027-01-01T00:00:00.000Z',
    ];

    expect(runScript(SEED_SCRIPT, [...common, '--output', first]).status).toBe(0);
    expect(runScript(SEED_SCRIPT, [...common, '--output', second]).status).toBe(0);
    expect(fs.readFileSync(first)).toEqual(fs.readFileSync(second));

    const seeded = validateCatalogBytes(fs.readFileSync(first), {
      appVersion: '0.1.0',
      now: new Date(NOW),
    });
    expect(seeded.catalog.provenance.contentHash).toBe(
      `sha256:${createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex')}`,
    );
    expect(seeded.catalog.providers[0].models.map((model) => model.id)).toEqual([
      'embedding-only',
      'model/z',
      'z-text',
    ]);
    expect(seeded.catalog.providers[0].models.find((model) => model.id === 'embedding-only')?.capabilities.outputModalities)
      .toEqual(['embedding']);
    expect(seeded.catalog.providers.map((provider) => provider.id)).toEqual([
      'openai',
      'generic-openai-compatible',
      'generic-anthropic-compatible',
    ]);
    expect(seeded.catalog.providers.slice(1).every((provider) => provider.models.length === 0)).toBe(true);
  });

  it('signs exact bytes with an operator-supplied Ed25519 key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPath = path.join(tempDir, 'catalog-private.pem');
    const catalogPath = path.join(tempDir, 'catalog.json');
    const signaturePath = path.join(tempDir, 'catalog.json.sig');
    fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.copyFileSync(BUNDLED_CATALOG, catalogPath);

    const signed = runScript(SIGN_SCRIPT, [
      '--input', catalogPath,
      '--private-key', privateKeyPath,
      '--output', signaturePath,
    ]);
    expect(signed.status).toBe(0);
    expect(verify(
      null,
      fs.readFileSync(catalogPath),
      publicKey,
      Buffer.from(fs.readFileSync(signaturePath, 'utf8').trim(), 'base64'),
    )).toBe(true);

  });
});
