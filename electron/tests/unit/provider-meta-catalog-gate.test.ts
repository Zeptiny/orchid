/**
 * Bundled-catalog gate: the signed dev catalog must pass the same
 * trust-policy validation that runs at app startup, with the Meta provider
 * declared and every policy pinned by trusted driver code.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCatalogBytes } from '../../src/main/providers/catalog/trust';

const CATALOG_PATH = resolve(__dirname, '../../assets/providers/catalog.json');

describe('bundled catalog trust validation', () => {
  it('accepts the bundled catalog with the Meta provider', () => {
    const bytes = readFileSync(CATALOG_PATH);
    const { catalog } = validateCatalogBytes(bytes, {
      appVersion: '0.1.0',
      allowExpired: true,
    });

    const meta = catalog.providers.find((provider) => provider.id === 'meta');
    expect(meta).toBeDefined();
    expect(meta?.supportedProtocols).toEqual(['openai-responses']);
    expect(meta?.models.map((model) => model.id)).toEqual([
      'muse-spark-1.1',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
    ]);
  });
});
