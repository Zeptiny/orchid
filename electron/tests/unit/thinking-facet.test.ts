/**
 * Unit tests for the thinking facet (U3): policy resolution, replay decision,
 * request knobs, render metadata, and driver hook wiring (R15, R17, R18).
 */
import { describe, it, expect } from 'vitest';
import {
  ANTHROPIC_THINKING_POLICY,
  DEFAULT_THINKING_POLICY,
  OPENAI_OPAQUE_THINKING_POLICY,
  OPENAI_RESPONSES_THINKING_POLICY,
  buildThinkingProviderOptions,
  buildThinkingRequestOptions,
  decideThinkingReplay,
  mergeThinkingProviderOptions,
  resolveThinkingPolicy,
  thinkingArtifactMatchesSelection,
} from '../../src/main/providers/facets/thinking';
import {
  isOpaqueThinkingPayload,
  thinkingRenderMetadata,
} from '../../src/main/providers/facets/thinking-ui';
import { createNativeProviderDrivers } from '../../src/main/providers/drivers/native';
import { createCompatibleProviderDrivers } from '../../src/main/providers/drivers/compatible';
import { createOpenCodeGoProviderDriver } from '../../src/main/providers/drivers/opencode-go';
import type { ProviderDriver } from '../../src/main/providers/drivers/types';
import type { EffectiveModel, ProviderProtocol } from '../../src/shared/types/provider';
import { ThinkingArtifactKind, type ThinkingReplayPayload } from '../../src/shared/types/message';

function model(protocol: ProviderProtocol, id = 'model-1'): EffectiveModel {
  return { id, displayName: id, protocol, source: 'catalog' } as EffectiveModel;
}

function payload(overrides: Partial<ThinkingReplayPayload> = {}): ThinkingReplayPayload {
  return {
    providerId: 'anthropic',
    modelId: 'claude-1',
    kind: ThinkingArtifactKind.SIGNED,
    blob: 'sig-1',
    displayText: 'Let me analyze',
    ...overrides,
  };
}

const ANTHROPIC_SELECTION = { providerId: 'anthropic', modelId: 'claude-1' };

describe('resolveThinkingPolicy', () => {
  it('returns the default policy when the driver or hook is absent', () => {
    expect(resolveThinkingPolicy(undefined, model('openai-compatible'))).toBe(DEFAULT_THINKING_POLICY);
    const hookless = { id: 'hookless' } as ProviderDriver;
    expect(resolveThinkingPolicy(hookless, model('openai-compatible'))).toBe(DEFAULT_THINKING_POLICY);
    expect(DEFAULT_THINKING_POLICY).toEqual({ exposure: 'readable', replay: 'recommended' });
  });

  it('returns the driver-declared policy when the hook provides one', () => {
    const driver = {
      id: 'test',
      thinkingPolicy: () => ANTHROPIC_THINKING_POLICY,
    } as unknown as ProviderDriver;
    expect(resolveThinkingPolicy(driver, model('anthropic-messages'))).toBe(ANTHROPIC_THINKING_POLICY);
  });
});

describe('driver thinkingPolicy hooks', () => {
  const native = createNativeProviderDrivers();
  const nativeOpenai = native.find((driver) => driver.id === 'openai')!;
  const nativeAnthropic = native.find((driver) => driver.id === 'anthropic')!;
  const compatible = createCompatibleProviderDrivers();
  const genericOpenai = compatible.find((driver) => driver.id === 'generic-openai-compatible')!;
  const genericAnthropic = compatible.find((driver) => driver.id === 'generic-anthropic-compatible')!;
  const opencodeGo = createOpenCodeGoProviderDriver();

  it('openai declares opaque/impossible for chat and summary/recommended for responses', () => {
    expect(nativeOpenai.thinkingPolicy?.(model('openai-compatible'))).toBe(OPENAI_OPAQUE_THINKING_POLICY);
    expect(nativeOpenai.thinkingPolicy?.(model('openai-responses'))).toBe(OPENAI_RESPONSES_THINKING_POLICY);
  });

  it('anthropic declares readable exposure with mandatory tool-loop replay', () => {
    expect(nativeAnthropic.thinkingPolicy?.(model('anthropic-messages'))).toBe(ANTHROPIC_THINKING_POLICY);
    expect(ANTHROPIC_THINKING_POLICY.replay).toBe('mandatory-in-tool-loop');
  });

  it('google-gemini and xai stay on the default policy', () => {
    const gemini = native.find((driver) => driver.id === 'google-gemini')!;
    expect(gemini.thinkingPolicy).toBeUndefined();
  });

  it('generic drivers declare policies only for signed/encrypted protocols', () => {
    expect(genericOpenai.thinkingPolicy?.(model('openai-responses'))).toBe(OPENAI_RESPONSES_THINKING_POLICY);
    expect(genericOpenai.thinkingPolicy?.(model('openai-compatible'))).toBeUndefined();
    expect(genericAnthropic.thinkingPolicy?.(model('anthropic-messages'))).toBe(ANTHROPIC_THINKING_POLICY);
  });

  it('opencode-go resolves the policy from the frozen per-model protocol', () => {
    expect(opencodeGo.thinkingPolicy?.(model('anthropic-messages'))).toBe(ANTHROPIC_THINKING_POLICY);
    expect(opencodeGo.thinkingPolicy?.(model('openai-responses'))).toBe(OPENAI_RESPONSES_THINKING_POLICY);
    expect(opencodeGo.thinkingPolicy?.(model('openai-compatible'))).toBeUndefined();
  });
});

describe('thinkingArtifactMatchesSelection', () => {
  it('matches only the exact producing provider and model', () => {
    expect(thinkingArtifactMatchesSelection(payload(), ANTHROPIC_SELECTION)).toBe(true);
    expect(thinkingArtifactMatchesSelection(payload(), { providerId: 'openai', modelId: 'claude-1' })).toBe(false);
    expect(thinkingArtifactMatchesSelection(payload(), { providerId: 'anthropic', modelId: 'claude-2' })).toBe(false);
  });
});

describe('decideThinkingReplay', () => {
  it('replays a matching artifact under a mandatory policy', () => {
    expect(decideThinkingReplay({
      policy: ANTHROPIC_THINKING_POLICY,
      selection: ANTHROPIC_SELECTION,
      content: 'Let me analyze',
      payload: payload(),
    })).toEqual({ emit: 'artifact', payload: payload() });
  });

  it('drops thinking under a mandatory policy when no matching artifact exists', () => {
    for (const input of [
      // Switched provider/model: the artifact is stripped, and plain text is
      // never substituted (providers reject unsigned thinking with tool use).
      { content: 'Let me analyze', payload: payload({ modelId: 'claude-2' }) },
      { content: 'Let me analyze', payload: payload({ providerId: 'openai' }) },
      // Legacy message without any payload.
      { content: 'Let me analyze', payload: undefined },
    ]) {
      expect(decideThinkingReplay({
        policy: ANTHROPIC_THINKING_POLICY,
        selection: ANTHROPIC_SELECTION,
        ...input,
      })).toEqual({ emit: 'none' });
    }
  });

  it('replays matching artifacts and degrades mismatched ones to text under recommended', () => {
    const policy = OPENAI_RESPONSES_THINKING_POLICY;
    const encrypted = payload({
      providerId: 'openai',
      modelId: 'gpt-5',
      kind: ThinkingArtifactKind.ENCRYPTED,
      blob: 'enc-1',
      itemId: 'rs_1',
      displayText: 'summary',
    });
    expect(decideThinkingReplay({
      policy,
      selection: { providerId: 'openai', modelId: 'gpt-5' },
      content: 'summary',
      payload: encrypted,
    })).toEqual({ emit: 'artifact', payload: encrypted });

    expect(decideThinkingReplay({
      policy,
      selection: { providerId: 'openai', modelId: 'gpt-5-mini' },
      content: 'summary',
      payload: encrypted,
    })).toEqual({ emit: 'text', text: 'summary' });
  });

  it('replays legacy plain-text thinking under recommended', () => {
    expect(decideThinkingReplay({
      policy: DEFAULT_THINKING_POLICY,
      selection: ANTHROPIC_SELECTION,
      content: 'old reasoning',
      payload: undefined,
    })).toEqual({ emit: 'text', text: 'old reasoning' });
  });

  it('omits everything under an impossible policy', () => {
    for (const input of [
      { content: 'text', payload: payload() },
      { content: 'text', payload: undefined },
      { content: '', payload: payload() },
    ]) {
      expect(decideThinkingReplay({
        policy: OPENAI_OPAQUE_THINKING_POLICY,
        selection: { providerId: 'openai', modelId: 'gpt-5' },
        ...input,
      })).toEqual({ emit: 'none' });
    }
  });

  it('omits artifact-only messages with no replayable content under recommended', () => {
    expect(decideThinkingReplay({
      policy: DEFAULT_THINKING_POLICY,
      selection: ANTHROPIC_SELECTION,
      content: '',
      payload: payload({ modelId: 'other-model', displayText: null }),
    })).toEqual({ emit: 'none' });
  });
});

describe('buildThinkingProviderOptions', () => {
  it('maps signed and redacted artifacts to the anthropic namespace', () => {
    expect(buildThinkingProviderOptions(payload())).toEqual({ anthropic: { signature: 'sig-1' } });
    expect(buildThinkingProviderOptions(payload({
      kind: ThinkingArtifactKind.REDACTED,
      blob: 'red-1',
      displayText: null,
    }))).toEqual({ anthropic: { redactedData: 'red-1' } });
  });

  it('maps encrypted artifacts to the openai namespace with item id', () => {
    expect(buildThinkingProviderOptions(payload({
      providerId: 'openai',
      kind: ThinkingArtifactKind.ENCRYPTED,
      blob: 'enc-1',
      itemId: 'rs_1',
    }))).toEqual({ openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-1' } });
    expect(buildThinkingProviderOptions(payload({
      providerId: 'openai',
      kind: ThinkingArtifactKind.OPAQUE,
      blob: null,
      itemId: 'rs_2',
      displayText: null,
    }))).toEqual({ openai: { itemId: 'rs_2' } });
  });

  it('returns undefined for blob-less artifacts and plain text', () => {
    expect(buildThinkingProviderOptions(payload({ blob: null, displayText: 'text' }))).toBeUndefined();
    expect(buildThinkingProviderOptions(payload({
      kind: ThinkingArtifactKind.TEXT,
      blob: null,
    }))).toBeUndefined();
  });
});

describe('buildThinkingRequestOptions', () => {
  it('emits the anthropic display knob only for declared selections (R18)', () => {
    expect(buildThinkingRequestOptions(ANTHROPIC_THINKING_POLICY, 'anthropic', {
      displayMode: 'omitted',
    })).toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'omitted' } } });
    // Nothing declared as default: no selection means no option.
    expect(buildThinkingRequestOptions(ANTHROPIC_THINKING_POLICY, 'anthropic')).toBeUndefined();
    // Undeclared values are ignored rather than sent.
    expect(buildThinkingRequestOptions(ANTHROPIC_THINKING_POLICY, 'anthropic', {
      displayMode: 'verbose',
    })).toBeUndefined();
  });

  it('emits the responses summary profile and encrypted-content opt-in', () => {
    expect(buildThinkingRequestOptions(OPENAI_RESPONSES_THINKING_POLICY, 'openai', {
      summaryProfile: 'detailed',
      encryptedContent: true,
    })).toEqual({
      openai: {
        reasoningSummary: 'detailed',
        include: ['reasoning.encrypted_content'],
      },
    });
    expect(buildThinkingRequestOptions(OPENAI_RESPONSES_THINKING_POLICY, 'openai')).toBeUndefined();
    expect(buildThinkingRequestOptions(OPENAI_RESPONSES_THINKING_POLICY, 'openai', {
      summaryProfile: 'bogus',
      encryptedContent: false,
    })).toBeUndefined();
  });

  it('emits nothing for policies without knobs or unknown providers', () => {
    expect(buildThinkingRequestOptions(DEFAULT_THINKING_POLICY, 'glm')).toBeUndefined();
    expect(buildThinkingRequestOptions(OPENAI_OPAQUE_THINKING_POLICY, 'openai')).toBeUndefined();
    expect(buildThinkingRequestOptions(ANTHROPIC_THINKING_POLICY, 'other-provider', {
      displayMode: 'omitted',
    })).toBeUndefined();
  });
});

describe('mergeThinkingProviderOptions', () => {
  it('merges per namespace without dropping the reasoning effort options', () => {
    expect(mergeThinkingProviderOptions(
      { openai: { reasoningEffort: 'high' } },
      { openai: { reasoningSummary: 'auto', include: ['reasoning.encrypted_content'] } },
    )).toEqual({
      openai: {
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
        include: ['reasoning.encrypted_content'],
      },
    });
    expect(mergeThinkingProviderOptions(undefined, { openai: { reasoningSummary: 'auto' } }))
      .toEqual({ openai: { reasoningSummary: 'auto' } });
    expect(mergeThinkingProviderOptions({ openai: { reasoningEffort: 'high' } }, undefined))
      .toEqual({ openai: { reasoningEffort: 'high' } });
  });
});

describe('thinkingRenderMetadata', () => {
  it('renders readable exposure as text', () => {
    expect(thinkingRenderMetadata({
      exposure: 'readable',
      content: 'full reasoning',
      payload: payload(),
    })).toEqual({ kind: 'text', text: 'full reasoning' });
  });

  it('renders summaries from the payload display text', () => {
    expect(thinkingRenderMetadata({
      exposure: 'summary',
      content: '',
      payload: payload({ kind: ThinkingArtifactKind.ENCRYPTED, displayText: 'summary text' }),
    })).toEqual({ kind: 'text', text: 'summary text' });
  });

  it('renders opaque thinking as an indicator with the token count (R17)', () => {
    expect(thinkingRenderMetadata({
      exposure: 'opaque',
      content: '',
      payload: payload({
        kind: ThinkingArtifactKind.OPAQUE,
        blob: null,
        displayText: null,
        reasoningTokenCount: 936,
      }),
    })).toEqual({ kind: 'indicator', tokenCount: 936 });
    expect(thinkingRenderMetadata({ exposure: 'none', content: '', payload: undefined }))
      .toEqual({ kind: 'indicator' });
  });

  it('classifies opaque payloads', () => {
    expect(isOpaqueThinkingPayload(payload({ kind: ThinkingArtifactKind.OPAQUE, blob: null, displayText: null }))).toBe(true);
    expect(isOpaqueThinkingPayload(payload({ kind: ThinkingArtifactKind.ENCRYPTED, displayText: null }))).toBe(true);
    expect(isOpaqueThinkingPayload(payload({ kind: ThinkingArtifactKind.ENCRYPTED }))).toBe(false);
    expect(isOpaqueThinkingPayload(payload())).toBe(false);
  });
});
