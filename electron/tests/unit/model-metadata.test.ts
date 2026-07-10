/**
 * Model metadata resolution — provider/model refs, per-provider overrides,
 * and cache invalidation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaults } from '../../src/main/config/schema';
import type { Config } from '../../src/main/config/schema';
import {
  clearModelMetadataCache,
  resolveModelMetadata,
  splitProviderModelRef,
} from '../../src/main/llm/model-metadata';

afterEach(() => {
  clearModelMetadataCache();
});

function configWithProviders(
  providers: Config['providers'],
): Config {
  return { ...defaults(), providers };
}

describe('splitProviderModelRef', () => {
  it('splits alias/model on the first slash', () => {
    expect(splitProviderModelRef('default/mimo-v2.5')).toEqual({
      alias: 'default',
      modelId: 'mimo-v2.5',
    });
  });

  it('keeps slashes inside the model id after the first slash', () => {
    expect(splitProviderModelRef('cline/cline-pass/mimo-v2.5')).toEqual({
      alias: 'cline',
      modelId: 'cline-pass/mimo-v2.5',
    });
  });

  it('returns bare ids with a null alias', () => {
    expect(splitProviderModelRef('gpt-4o')).toEqual({
      alias: null,
      modelId: 'gpt-4o',
    });
  });
});

describe('resolveModelMetadata', () => {
  it('applies config overrides for alias/model refs', () => {
    const config = configWithProviders({
      default: {
        base_url: 'https://example.com/v1',
        litellm_provider: 'openai',
        models: {
          'mimo-v2.5': { max_input_tokens: 200_000 },
        },
      },
    });

    const meta = resolveModelMetadata('default/mimo-v2.5', config);
    expect(meta.max_input_tokens).toBe(200_000);
  });

  it('keeps independent overrides when two providers share a bare model id', () => {
    const config = configWithProviders({
      openai: {
        base_url: 'https://api.openai.com/v1',
        litellm_provider: 'openai',
        models: {
          'gpt-4o': { max_input_tokens: 128_000 },
        },
      },
      azure: {
        base_url: 'https://azure.example.com/v1',
        litellm_provider: 'openai',
        models: {
          'gpt-4o': { max_input_tokens: 200_000 },
        },
      },
    });

    expect(resolveModelMetadata('openai/gpt-4o', config).max_input_tokens).toBe(
      128_000,
    );
    expect(resolveModelMetadata('azure/gpt-4o', config).max_input_tokens).toBe(
      200_000,
    );
  });

  it('resolves model ids that themselves contain a slash', () => {
    const config = configWithProviders({
      cline: {
        base_url: 'https://api.cline.bot/api/v1',
        litellm_provider: 'openai',
        models: {
          'cline-pass/mimo-v2.5': { max_input_tokens: 200_000 },
        },
      },
    });

    const meta = resolveModelMetadata('cline/cline-pass/mimo-v2.5', config);
    expect(meta.max_input_tokens).toBe(200_000);
  });

  it('uses built-in defaults for known bare model ids under a provider prefix', () => {
    const config = configWithProviders({
      default: {
        base_url: 'https://example.com/v1',
        litellm_provider: 'openai',
        models: { 'gpt-4o': {} },
      },
    });

    const meta = resolveModelMetadata('default/gpt-4o', config);
    expect(meta.max_input_tokens).toBe(128_000);
    expect(meta.supports_vision).toBe(true);
  });

  it('lets config overrides win over built-in defaults', () => {
    const config = configWithProviders({
      default: {
        base_url: 'https://example.com/v1',
        litellm_provider: 'openai',
        models: {
          'gpt-4o': { max_input_tokens: 200_000, supports_vision: false },
        },
      },
    });

    const meta = resolveModelMetadata('default/gpt-4o', config);
    expect(meta.max_input_tokens).toBe(200_000);
    expect(meta.supports_vision).toBe(false);
    // Unset fields still come from built-in
    expect(meta.max_output_tokens).toBe(16_384);
  });

  it('returns null limits for unknown models with no overrides', () => {
    const config = configWithProviders({
      default: {
        base_url: 'https://example.com/v1',
        litellm_provider: 'openai',
        models: { 'totally-unknown-model': {} },
      },
    });

    const meta = resolveModelMetadata('default/totally-unknown-model', config);
    expect(meta.max_input_tokens).toBeNull();
    expect(meta.max_output_tokens).toBeNull();
    expect(meta.supports_vision).toBe(false);
    expect(meta.mode).toBe('chat');
  });

  it('invalidates cache when clearModelMetadataCache is called', () => {
    const before = configWithProviders({
      default: {
        base_url: 'https://example.com/v1',
        litellm_provider: 'openai',
        models: { 'custom-model': { max_input_tokens: 50_000 } },
      },
    });
    expect(resolveModelMetadata('default/custom-model', before).max_input_tokens).toBe(
      50_000,
    );

    const after = configWithProviders({
      default: {
        base_url: 'https://example.com/v1',
        litellm_provider: 'openai',
        models: { 'custom-model': { max_input_tokens: 200_000 } },
      },
    });

    // Without clear, stale cache would still return 50k
    expect(resolveModelMetadata('default/custom-model', after).max_input_tokens).toBe(
      50_000,
    );

    clearModelMetadataCache();
    expect(resolveModelMetadata('default/custom-model', after).max_input_tokens).toBe(
      200_000,
    );
  });
});
