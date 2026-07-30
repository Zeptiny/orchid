/**
 * Tests for API embedding configuration and retry behavior.
 *
 * Covers:
 * - Config schema accepts embedding_api_model field
 * - ApiEmbedder retry logic (permanent errors don't retry, transient do)
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { configSchema, defaults } from '../../src/main/config/schema';

// ── Config schema tests ────────────────────────────────────────────────────

describe('Config schema with embedding_api_model', () => {
  it('defaults include embedding_api_model as null', () => {
    const cfg = defaults();
    expect(cfg.rag.embedding_api_model).toBeNull();
  });

  it('rejects a legacy string embedding alias', () => {
    expect(() => configSchema.parse({
      ...defaults(),
      rag: {
        ...defaults().rag,
        embedding_api_model: 'openai/text-embedding-3-small',
      },
    })).toThrow(/object/i);
  });

  it('accepts null for embedding_api_model', () => {
    const cfg = configSchema.parse({
      ...defaults(),
      rag: { ...defaults().rag, embedding_api_model: null },
    });
    expect(cfg.rag.embedding_api_model).toBeNull();
  });

  it('accepts a typed connection-scoped API embedding selection', () => {
    const cfg = configSchema.parse({
      ...defaults(),
      rag: {
        ...defaults().rag,
        embedding_api_model: {
          connectionId: '11111111-1111-4111-8111-111111111111',
          modelId: 'text-embedding-3-small',
        },
      },
    });
    expect(cfg.rag.embedding_api_model).toEqual({
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'text-embedding-3-small',
    });
  });

});

// ── ApiEmbedder retry tests ────────────────────────────────────────────────

describe('ApiEmbedder retry logic', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('keeps the request deadline active while a successful response body stalls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(init.signal?.reason ?? new Error('aborted'));
          }, { once: true });
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));

    const { ApiEmbedder } = await import('../../src/main/rag/embedder');
    const embedder = new ApiEmbedder('https://api.example.com/v1', 'key', 'model', 10, 10, 0);
    const pending = embedder.embed(['hello']);
    const rejected = expect(pending).rejects.toThrow(/embedding.*request failed|aborted/i);

    await vi.advanceTimersByTimeAsync(11);

    await rejected;
  });
});
