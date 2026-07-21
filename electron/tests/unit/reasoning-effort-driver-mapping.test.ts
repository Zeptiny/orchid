import { describe, expect, it } from 'vitest';
import type { EffectiveModel } from '../../src/shared/types/provider';
import type { ProviderDriver } from '../../src/main/providers/drivers/types';
import { createNativeProviderDrivers } from '../../src/main/providers/drivers/native';
import { createCompatibleProviderDrivers } from '../../src/main/providers/drivers/compatible';

const model: EffectiveModel = {
  id: 'test-model',
  displayName: 'Test Model',
  protocol: 'openai-compatible',
  source: 'catalog',
};

function driverById(drivers: readonly ProviderDriver[], id: string): ProviderDriver {
  const driver = drivers.find((d) => d.id === id);
  if (!driver) throw new Error(`Driver not found: ${id}`);
  return driver;
}

describe('reasoning effort driver mapping', () => {
  const nativeDrivers = createNativeProviderDrivers();
  const compatibleDrivers = createCompatibleProviderDrivers();

  describe('OpenAI driver', () => {
    const openai = driverById(nativeDrivers, 'openai');

    it('maps text effort to reasoningEffort', () => {
      expect(openai.buildReasoningOptions!('high', model)).toEqual({
        openai: { reasoningEffort: 'high' },
      });
    });

    it('maps numeric effort to maxReasoningTokens', () => {
      expect(openai.buildReasoningOptions!(8192, model)).toEqual({
        openai: { maxReasoningTokens: 8192 },
      });
    });
  });

  describe('Anthropic driver', () => {
    const anthropic = driverById(nativeDrivers, 'anthropic');

    it('maps numeric effort to thinking budget', () => {
      expect(anthropic.buildReasoningOptions!(8192, model)).toEqual({
        anthropic: { thinking: { type: 'enabled', budgetTokens: 8192 } },
      });
    });

    it('maps text effort to reasoningEffort', () => {
      expect(anthropic.buildReasoningOptions!('high', model)).toEqual({
        anthropic: { reasoningEffort: 'high' },
      });
    });
  });

  describe('Google driver', () => {
    const google = driverById(nativeDrivers, 'google-gemini');

    it('maps numeric effort to thinkingBudget', () => {
      expect(google.buildReasoningOptions!(4096, model)).toEqual({
        google: { thinkingConfig: { thinkingBudget: 4096 } },
      });
    });

    it('maps text effort to thinkingLevel', () => {
      expect(google.buildReasoningOptions!('high', model)).toEqual({
        google: { thinkingConfig: { thinkingLevel: 'high' } },
      });
    });
  });

  describe('xAI driver', () => {
    const xai = driverById(nativeDrivers, 'xai');

    it('does not define buildReasoningOptions', () => {
      expect(xai.buildReasoningOptions).toBeUndefined();
    });
  });

  describe('generic OpenAI-compatible driver', () => {
    const generic = driverById(compatibleDrivers, 'generic-openai-compatible');

    it('maps text effort to openaiCompatible reasoningEffort', () => {
      expect(generic.buildReasoningOptions!('high', model)).toEqual({
        openaiCompatible: { reasoningEffort: 'high' },
      });
    });

    it('returns undefined for numeric effort', () => {
      expect(generic.buildReasoningOptions!(8192, model)).toBeUndefined();
    });
  });

  describe('driver without buildReasoningOptions', () => {
    it('returns undefined when method is absent', () => {
      const bare: ProviderDriver = {
        id: 'bare',
        supportedAuthMethods: ['api-key'],
        supportedProtocols: ['openai-compatible'],
        allowsCustomEndpoint: false,
        origin: null,
        createLanguageModel: async () => { throw new Error('not implemented'); },
      };
      expect(bare.buildReasoningOptions?.('high', model)).toBeUndefined();
    });
  });
});
