/**
 * Configuration form contracts (U7): draft merge boundary and valid zero values.
 */
import { describe, expect, it } from 'vitest';
import { defaults } from '../../src/main/config/schema';
import {
  applyConfigDraft,
  parseConfigNumber,
} from '../../src/renderer/utils/config-draft';
import type { ConfigPatch } from '../../src/shared/types/ipc';

describe('parseConfigNumber', () => {
  it('accepts valid zero when min is 0', () => {
    expect(parseConfigNumber('0', 0)).toBe(0);
    expect(parseConfigNumber('0', 0, { integer: true })).toBe(0);
  });

  it('rejects zero when min is positive', () => {
    expect(parseConfigNumber('0', 1)).toBeNull();
    expect(parseConfigNumber('0', 1, { integer: true })).toBeNull();
  });

  it('accepts positive integers and floats within min', () => {
    expect(parseConfigNumber('3', 0, { integer: true })).toBe(3);
    expect(parseConfigNumber('30.5', 1)).toBe(30.5);
  });

  it('rejects non-integers when integer mode is required', () => {
    expect(parseConfigNumber('12.5', 1, { integer: true })).toBeNull();
  });

  it('rejects empty and non-numeric input', () => {
    expect(parseConfigNumber('', 0)).toBeNull();
    expect(parseConfigNumber('abc', 0)).toBeNull();
  });
});

describe('applyConfigDraft', () => {
  it('merges scalar patches without broad casts losing nested config', () => {
    const base = defaults();
    const draft: ConfigPatch = {
      theme: 'bluey',
      llm_stream_retries: 0,
      rag: { chunk_overlap: 0 },
    };
    const next = applyConfigDraft(base, draft);
    expect(next.theme).toBe('bluey');
    expect(next.llm_stream_retries).toBe(0);
    expect(next.rag.chunk_overlap).toBe(0);
    expect(next.rag.chunk_size).toBe(base.rag.chunk_size);
    expect(next.rag.embedding_model).toBe(base.rag.embedding_model);
  });

  it('applies mcp_servers tombstones as deletes', () => {
    const base = {
      ...defaults(),
      mcp_servers: {
        keep: { command: 'npx' },
        drop: { command: 'node' },
      },
    };
    const next = applyConfigDraft(base, {
      mcp_servers: {
        keep: { command: 'npx', args: ['-y'] },
        drop: null,
      },
    });
    expect(next.mcp_servers).toEqual({
      keep: { command: 'npx', args: ['-y'] },
    });
  });

  it('preserves model selection contracts on default_model and tier_models', () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'gpt-4o',
    };
    const base = defaults();
    const next = applyConfigDraft(base, {
      default_model: selection,
      tier_models: {
        seed: selection,
        bloom: null,
      },
    });
    expect(next.default_model).toEqual(selection);
    expect(next.tier_models.seed).toEqual(selection);
    expect(next.tier_models.bloom).toBeNull();
    expect(next.tier_models.sprout).toBe(base.tier_models.sprout);
  });
});

describe('GeneralTab / RAGTab zero-value source contracts', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const prefs = path.resolve(__dirname, '../../src/renderer/components/Preferences');

  it('GeneralTab accepts zero stream retries via min-0 integer parse', () => {
    const source = fs.readFileSync(path.join(prefs, 'GeneralTab.tsx'), 'utf8');
    expect(source).toContain("handleIntChange('llm_stream_retries'");
    expect(source).toContain('min={0}');
    expect(source).toContain("parseConfigNumber");
  });

  it('RAGTab accepts zero chunk overlap via min-0 integer parse', () => {
    const source = fs.readFileSync(path.join(prefs, 'RAGTab.tsx'), 'utf8');
    expect(source).toContain("handleNumberChange('chunk_overlap'");
    expect(source).toContain(', 0)');
    expect(source).toContain('parseConfigNumber');
  });

  it('ConfigView uses typed applyConfigDraft instead of broad cast', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/components/ConfigView.tsx'),
      'utf8',
    );
    expect(source).toContain('applyConfigDraft');
    expect(source).not.toContain('as Config');
    expect(source).toContain('DialogSurface');
  });
});
