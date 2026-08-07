import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importESM } from '../../src/main/utils/esm-import';

vi.mock('../../src/main/utils/esm-import', () => ({ importESM: vi.fn() }));

const compatibleModel = { kind: 'openai-compatible' };
const anthropicModel = { kind: 'anthropic-compatible' };
const createOpenAICompatible = vi.fn(() => vi.fn(() => compatibleModel));
const createAnthropic = vi.fn(() => ({ messages: vi.fn(() => anthropicModel) }));

describe('compatible provider adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importESM).mockImplementation(async (specifier: string) => {
      if (specifier === '@ai-sdk/openai-compatible') return { createOpenAICompatible };
      if (specifier === '@ai-sdk/anthropic') return { createAnthropic };
      throw new Error(`Unexpected adapter import ${specifier}`);
    });
  });

  it('preserves slash-containing model ids and uses only the selected generic endpoint', async () => {
    const { createCompatibleLanguageModel } = await import('../../src/main/providers/drivers/compatible');
    const model = await createCompatibleLanguageModel({
      providerId: 'generic-openai-compatible',
      protocol: 'openai-compatible',
      modelId: 'vendor/path/model',
      apiKey: 'generic-key',
      endpoint: 'https://gateway.example.test/v1',
    });

    expect(model).toBe(compatibleModel);
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'generic-openai-compatible',
      baseURL: 'https://gateway.example.test/v1',
      apiKey: 'generic-key',
      fetch: expect.any(Function),
      includeUsage: true,
    });
  });

  it('routes generic Anthropic-compatible endpoints through the Anthropic Messages adapter', async () => {
    const { createCompatibleLanguageModel } = await import('../../src/main/providers/drivers/compatible');
    const model = await createCompatibleLanguageModel({
      providerId: 'generic-anthropic-compatible',
      protocol: 'anthropic-messages',
      modelId: 'vendor/claude-compatible',
      apiKey: 'generic-key',
      endpoint: 'https://gateway.example.test/messages',
    });

    expect(model).toBe(anthropicModel);
    expect(createAnthropic).toHaveBeenCalledWith({
      name: 'generic-anthropic-compatible',
      baseURL: 'https://gateway.example.test/messages',
      apiKey: 'generic-key',
    });
  });

  it('rejects credential-bearing URLs, unsupported schemes, and non-loopback plaintext HTTP without an explicit confirmation', async () => {
    const { validateGenericEndpoint } = await import('../../src/main/providers/drivers/compatible');

    expect(() => validateGenericEndpoint('https://user:secret@gateway.example.test/v1')).toThrow(/credentials/i);
    expect(() => validateGenericEndpoint('ftp://gateway.example.test/v1')).toThrow(/http/i);
    expect(() => validateGenericEndpoint('http://gateway.example.test/v1')).toThrow(/confirmation/i);
    expect(validateGenericEndpoint('http://gateway.example.test/v1', {
      allowInsecureNonLoopbackHttp: true,
    })).toMatchObject({
      origin: 'http://gateway.example.test',
      insecureNonLoopback: true,
    });
    expect(validateGenericEndpoint('http://127.0.0.1:8080/v1')).toMatchObject({
      origin: 'http://127.0.0.1:8080',
      insecureNonLoopback: false,
    });
    expect(validateGenericEndpoint('http://localhost:8080/v1')).toMatchObject({
      origin: 'http://localhost:8080',
      insecureNonLoopback: false,
    });
    // Hostnames that merely start with "127." are not loopback.
    expect(() => validateGenericEndpoint('http://127.evil.com/v1')).toThrow(/confirmation/i);
    expect(() => validateGenericEndpoint('http://127.0.0.2/v1')).toThrow(/confirmation/i);
    expect(validateGenericEndpoint('http://127.evil.com/v1', {
      allowInsecureNonLoopbackHttp: true,
    })).toMatchObject({
      origin: 'http://127.evil.com',
      insecureNonLoopback: true,
    });
  });
});
