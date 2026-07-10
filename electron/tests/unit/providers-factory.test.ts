/**
 * Tests for createProviderModel() — AI SDK model instantiation from ResolvedModelRef.
 *
 * Covers:
 * - openai-compatible path via useCompatible / providerName
 * - Direct OpenAI provider (default)
 * - Default baseURL / apiKey when omitted
 * - baseURL only included on OpenAI when explicitly set
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedModelRef } from '../../src/main/llm/providers';
import { importESM } from '../../src/main/utils/esm-import';

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: vi.fn(),
}));

const mockImportESM = vi.mocked(importESM);

// ---------------------------------------------------------------------------
// Mocks for AI SDK provider factories
// ---------------------------------------------------------------------------

const mockCompatibleModel = { kind: 'compatible-model' };
const mockOpenAIModel = { kind: 'openai-model' };

const mockCompatibleProvider = vi.fn(() => mockCompatibleModel);
const mockCreateOpenAICompatible = vi.fn(() => mockCompatibleProvider);

const mockChat = vi.fn(() => mockOpenAIModel);
const mockOpenAIProvider = { chat: mockChat };
const mockCreateOpenAI = vi.fn(() => mockOpenAIProvider);

function makeRef(overrides: Partial<ResolvedModelRef> = {}): ResolvedModelRef {
  return {
    providerName: 'openai',
    modelId: 'gpt-4o',
    apiKey: 'sk-test',
    useCompatible: false,
    ...overrides,
  };
}

describe('createProviderModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompatibleProvider.mockReturnValue(mockCompatibleModel);
    mockCreateOpenAICompatible.mockReturnValue(mockCompatibleProvider);
    mockChat.mockReturnValue(mockOpenAIModel);
    mockCreateOpenAI.mockReturnValue(mockOpenAIProvider);

    mockImportESM.mockImplementation(async (specifier: string) => {
      if (specifier === '@ai-sdk/openai-compatible') {
        return { createOpenAICompatible: mockCreateOpenAICompatible };
      }
      if (specifier === '@ai-sdk/openai') {
        return { createOpenAI: mockCreateOpenAI };
      }
      throw new Error(`Unexpected importESM specifier: ${specifier}`);
    });
  });

  // -------------------------------------------------------------------------
  // OpenAI-compatible branch
  // -------------------------------------------------------------------------

  it('uses openai-compatible when useCompatible is true', async () => {
    const { createProviderModel } = await import('../../src/main/llm/providers-factory');

    const ref = makeRef({
      providerName: 'openai-compatible',
      modelId: 'llama-3',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'compat-key',
      useCompatible: true,
    });

    const model = await createProviderModel(ref);

    expect(mockImportESM).toHaveBeenCalledWith('@ai-sdk/openai-compatible');
    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith({
      name: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'compat-key',
      fetch: expect.any(Function),
    });
    expect(mockCompatibleProvider).toHaveBeenCalledWith('llama-3');
    expect(model).toBe(mockCompatibleModel);
    expect(mockCreateOpenAI).not.toHaveBeenCalled();
  });

  it('uses openai-compatible when providerName is openai-compatible even if useCompatible is false', async () => {
    const { createProviderModel } = await import('../../src/main/llm/providers-factory');

    const ref = makeRef({
      providerName: 'openai-compatible',
      modelId: 'custom-model',
      baseUrl: 'http://localhost:8080/v1',
      useCompatible: false,
    });

    const model = await createProviderModel(ref);

    expect(mockImportESM).toHaveBeenCalledWith('@ai-sdk/openai-compatible');
    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith({
      name: 'openai-compatible',
      baseURL: 'http://localhost:8080/v1',
      apiKey: 'sk-test',
      fetch: expect.any(Function),
    });
    expect(mockCompatibleProvider).toHaveBeenCalledWith('custom-model');
    expect(model).toBe(mockCompatibleModel);
  });

  it('defaults baseURL and apiKey for openai-compatible when omitted', async () => {
    const { createProviderModel } = await import('../../src/main/llm/providers-factory');

    const ref = makeRef({
      providerName: 'my-local',
      modelId: 'local-model',
      baseUrl: undefined,
      apiKey: undefined,
      useCompatible: true,
    });

    await createProviderModel(ref);

    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith({
      name: 'my-local',
      baseURL: 'https://api.openai.com/v1',
      apiKey: '',
      fetch: expect.any(Function),
    });
  });

  // -------------------------------------------------------------------------
  // Direct OpenAI branch
  // -------------------------------------------------------------------------

  it('uses direct OpenAI provider by default', async () => {
    const { createProviderModel } = await import('../../src/main/llm/providers-factory');

    const ref = makeRef({
      providerName: 'openai',
      modelId: 'gpt-4o',
      apiKey: 'sk-openai',
      useCompatible: false,
    });

    const model = await createProviderModel(ref);

    expect(mockImportESM).toHaveBeenCalledWith('@ai-sdk/openai');
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-openai',
    });
    expect(mockChat).toHaveBeenCalledWith('gpt-4o');
    expect(model).toBe(mockOpenAIModel);
    expect(mockCreateOpenAICompatible).not.toHaveBeenCalled();
  });

  it('passes baseURL to OpenAI when provided', async () => {
    const { createProviderModel } = await import('../../src/main/llm/providers-factory');

    const ref = makeRef({
      providerName: 'openai',
      modelId: 'gpt-4o-mini',
      baseUrl: 'https://custom.openai.proxy/v1',
      apiKey: 'sk-proxy',
      useCompatible: false,
    });

    await createProviderModel(ref);

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-proxy',
      baseURL: 'https://custom.openai.proxy/v1',
    });
    expect(mockChat).toHaveBeenCalledWith('gpt-4o-mini');
  });

  it('defaults apiKey to empty string for OpenAI when omitted', async () => {
    const { createProviderModel } = await import('../../src/main/llm/providers-factory');

    const ref = makeRef({
      providerName: 'openai',
      modelId: 'gpt-4o',
      apiKey: undefined,
      useCompatible: false,
    });

    await createProviderModel(ref);

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: '',
    });
  });

  it('does not include baseURL on OpenAI when baseUrl is undefined', async () => {
    const { createProviderModel } = await import('../../src/main/llm/providers-factory');

    const ref = makeRef({
      baseUrl: undefined,
      useCompatible: false,
    });

    await createProviderModel(ref);

    const callArgs = mockCreateOpenAI.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).toEqual({ apiKey: 'sk-test' });
    expect(callArgs).not.toHaveProperty('baseURL');
  });
});
