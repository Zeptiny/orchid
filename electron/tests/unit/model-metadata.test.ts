/** U1 metadata tests: model IDs are opaque, not aliases. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearModelMetadataCache,
  resolveModelMetadata,
} from '../../src/main/llm/model-metadata';

afterEach(() => {
  clearModelMetadataCache();
});

describe('resolveModelMetadata', () => {
  it('uses built-in metadata only for an exact opaque model ID', () => {
    expect(resolveModelMetadata('gpt-4o')).toMatchObject({
      max_input_tokens: 128_000,
      supports_vision: true,
    });
    expect(resolveModelMetadata('legacy/gpt-4o')).toMatchObject({
      max_input_tokens: null,
      supports_vision: false,
    });
  });

  it('does not strip slash-containing opaque IDs before lookup', () => {
    expect(resolveModelMetadata('vendor/path/model')).toMatchObject({
      max_input_tokens: null,
      max_output_tokens: null,
    });
  });

  it('keeps its cache keyed by the complete model ID', () => {
    const first = resolveModelMetadata('vendor/path/model');
    clearModelMetadataCache();
    const second = resolveModelMetadata('vendor/path/model');
    expect(second).toEqual(first);
  });
});
