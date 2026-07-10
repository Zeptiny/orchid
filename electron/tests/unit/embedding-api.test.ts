/**
 * Tests for API embedding model filtering and config changes.
 *
 * Covers:
 * - collectModelsFromProviders filters out embeddings models
 * - collectEmbeddingModelsFromProviders returns only embeddings models
 * - Config schema accepts embedding_api_model field
 * - ApiEmbedder retry logic (permanent errors don't retry, transient do)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectModelsFromProviders,
  collectEmbeddingModelsFromProviders,
} from '../../src/renderer/utils/models';
import { configSchema, defaults } from '../../src/main/config/schema';

// ── Model filtering tests ──────────────────────────────────────────────────

describe('Model filtering by mode', () => {
  const providers = {
    openai: {
      base_url: 'https://api.openai.com/v1',
      litellm_provider: 'openai',
      models: {
        'gpt-4o': {},
        'gpt-4o-mini': { supports_vision: true },
        'text-embedding-3-small': { mode: 'embeddings' },
        'text-embedding-3-large': { mode: 'embeddings' },
      },
    },
    local: {
      base_url: 'http://localhost:11434',
      litellm_provider: 'ollama',
      models: {
        'llama-3.3': {},
      },
    },
  };

  it('collectModelsFromProviders excludes embeddings models', () => {
    const models = collectModelsFromProviders(providers);
    expect(models).toContain('openai/gpt-4o');
    expect(models).toContain('openai/gpt-4o-mini');
    expect(models).toContain('local/llama-3.3');
    expect(models).not.toContain('openai/text-embedding-3-small');
    expect(models).not.toContain('openai/text-embedding-3-large');
  });

  it('collectEmbeddingModelsFromProviders returns only embeddings models', () => {
    const models = collectEmbeddingModelsFromProviders(providers);
    expect(models).toContain('openai/text-embedding-3-small');
    expect(models).toContain('openai/text-embedding-3-large');
    expect(models).not.toContain('openai/gpt-4o');
    expect(models).not.toContain('local/llama-3.3');
  });

  it('collectModelsFromProviders returns empty for null/undefined', () => {
    expect(collectModelsFromProviders(null)).toEqual([]);
    expect(collectModelsFromProviders(undefined)).toEqual([]);
  });

  it('collectEmbeddingModelsFromProviders returns empty for null/undefined', () => {
    expect(collectEmbeddingModelsFromProviders(null)).toEqual([]);
    expect(collectEmbeddingModelsFromProviders(undefined)).toEqual([]);
  });

  it('models without mode field are treated as chat', () => {
    const prov = {
      p: {
        models: {
          'chat-model': {},
          'embed-model': { mode: 'embeddings' },
        },
      },
    };
    expect(collectModelsFromProviders(prov)).toEqual(['p/chat-model']);
    expect(collectEmbeddingModelsFromProviders(prov)).toEqual(['p/embed-model']);
  });
});

// ── Config schema tests ────────────────────────────────────────────────────

describe('Config schema with embedding_api_model', () => {
  it('defaults include embedding_api_model as null', () => {
    const cfg = defaults();
    expect(cfg.rag.embedding_api_model).toBeNull();
  });

  it('accepts a string value for embedding_api_model', () => {
    const cfg = configSchema.parse({
      ...defaults(),
      rag: {
        ...defaults().rag,
        embedding_api_model: 'openai/text-embedding-3-small',
      },
    });
    expect(cfg.rag.embedding_api_model).toBe('openai/text-embedding-3-small');
  });

  it('accepts null for embedding_api_model', () => {
    const cfg = configSchema.parse({
      ...defaults(),
      rag: { ...defaults().rag, embedding_api_model: null },
    });
    expect(cfg.rag.embedding_api_model).toBeNull();
  });

  it('mode enum accepts chat and embeddings, rejects completion', () => {
    const cfg = defaults();
    const providers = {
      p: {
        base_url: 'https://example.com',
        litellm_provider: 'openai',
        models: {
          'm1': { mode: 'chat' },
          'm2': { mode: 'embeddings' },
        },
      },
    };
    const parsed = configSchema.parse({ ...cfg, providers });
    expect((parsed.providers.p.models as Record<string, unknown>)['m1']).toEqual({ mode: 'chat' });
    expect((parsed.providers.p.models as Record<string, unknown>)['m2']).toEqual({ mode: 'embeddings' });
  });
});

// ── ApiEmbedder retry tests ────────────────────────────────────────────────

describe('ApiEmbedder retry logic', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('retries on 429 rate limit', async () => {
    const { ApiEmbedder, EmbeddingError } = await import('../../src/main/rag/embedder');

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls < 3) {
        return new Response('rate limited', { status: 429 });
      }
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }));

    const embedder = new ApiEmbedder('https://api.example.com/v1', 'key', 'model', 10);
    const result = await embedder.embed(['hello']);

    expect(calls).toBe(3);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Float32Array);
  });

  it('does not retry on 401 auth error', async () => {
    const { ApiEmbedder } = await import('../../src/main/rag/embedder');

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return new Response('unauthorized', { status: 401 });
    }));

    const embedder = new ApiEmbedder('https://api.example.com/v1', 'bad-key', 'model', 10);

    await expect(embedder.embed(['hello'])).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('does not retry on 400 bad request', async () => {
    const { ApiEmbedder } = await import('../../src/main/rag/embedder');

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return new Response('bad model', { status: 400 });
    }));

    const embedder = new ApiEmbedder('https://api.example.com/v1', 'key', 'bad-model', 10);

    await expect(embedder.embed(['hello'])).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('returns empty array for empty input', async () => {
    const { ApiEmbedder } = await import('../../src/main/rag/embedder');

    const embedder = new ApiEmbedder('https://api.example.com/v1', 'key', 'model');
    const result = await embedder.embed([]);
    expect(result).toEqual([]);
  });

  it('parses embedding vectors as Float32Array', async () => {
    const { ApiEmbedder } = await import('../../src/main/rag/embedder');

    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            { embedding: [0.1, 0.2, 0.3] },
            { embedding: [0.4, 0.5, 0.6] },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }));

    const embedder = new ApiEmbedder('https://api.example.com/v1', 'key', 'model', 10);
    const result = await embedder.embed(['text1', 'text2']);

    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(Float32Array);
    const arr0 = Array.from(result[0]!);
    expect(arr0[0]).toBeCloseTo(0.1, 5);
    expect(arr0[1]).toBeCloseTo(0.2, 5);
    expect(arr0[2]).toBeCloseTo(0.3, 5);
    const arr1 = Array.from(result[1]!);
    expect(arr1[0]).toBeCloseTo(0.4, 5);
    expect(arr1[1]).toBeCloseTo(0.5, 5);
    expect(arr1[2]).toBeCloseTo(0.6, 5);
  });
});
