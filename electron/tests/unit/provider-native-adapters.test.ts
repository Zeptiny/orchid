import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importESM } from '../../src/main/utils/esm-import';

vi.mock('../../src/main/utils/esm-import', () => ({ importESM: vi.fn() }));

const mockOpenAIModel = { kind: 'openai' };
const mockAnthropicModel = { kind: 'anthropic' };
const mockGoogleModel = { kind: 'google' };
const mockXaiModel = { kind: 'xai' };
const mockCreateOpenAI = vi.fn(() => ({ chat: vi.fn(() => mockOpenAIModel) }));
const mockCreateAnthropic = vi.fn(() => ({ messages: vi.fn(() => mockAnthropicModel) }));
const mockCreateGoogle = vi.fn(() => ({ languageModel: vi.fn(() => mockGoogleModel) }));
const mockCreateXai = vi.fn(() => ({ chat: vi.fn(() => mockXaiModel) }));

describe('native provider adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importESM).mockImplementation(async (specifier: string) => {
      switch (specifier) {
        case '@ai-sdk/openai': return { createOpenAI: mockCreateOpenAI };
        case '@ai-sdk/anthropic': return { createAnthropic: mockCreateAnthropic };
        case '@ai-sdk/google': return { createGoogle: mockCreateGoogle };
        case '@ai-sdk/xai': return { createXai: mockCreateXai };
        default: throw new Error(`Unexpected adapter import ${specifier}`);
      }
    });
  });

  it.each([
    ['openai', 'openai-compatible', 'gpt-5.2-pro', 'openai-key', mockOpenAIModel, '@ai-sdk/openai'],
    ['anthropic', 'anthropic-messages', 'claude-opus-4-5', 'anthropic-key', mockAnthropicModel, '@ai-sdk/anthropic'],
    ['google-gemini', 'google-generative-ai', 'gemini-2.5-pro', 'google-key', mockGoogleModel, '@ai-sdk/google'],
    ['xai', 'xai', 'grok-4.3', 'xai-key', mockXaiModel, '@ai-sdk/xai'],
  ] as const)(
    'routes %s through its native %s adapter',
    async (providerId, protocol, modelId, apiKey, expected, specifier) => {
      const { createNativeLanguageModel } = await import('../../src/main/providers/drivers/native');
      const model = await createNativeLanguageModel({ providerId, protocol, modelId, apiKey });

      expect(model).toBe(expected);
      expect(importESM).toHaveBeenCalledWith(specifier);
    },
  );

  it('uses code-owned API origins and never turns a named provider into OpenAI-compatible transport', async () => {
    const { createNativeLanguageModel, BUILTIN_PROVIDER_ORIGINS } = await import('../../src/main/providers/drivers/native');

    await createNativeLanguageModel({
      providerId: 'anthropic',
      protocol: 'anthropic-messages',
      modelId: 'claude-opus-4-5',
      apiKey: 'anthropic-key',
    });

    expect(mockCreateAnthropic).toHaveBeenCalledWith({
      apiKey: 'anthropic-key',
      baseURL: BUILTIN_PROVIDER_ORIGINS.anthropic,
    });
    expect(mockCreateOpenAI).not.toHaveBeenCalled();
  });
});
