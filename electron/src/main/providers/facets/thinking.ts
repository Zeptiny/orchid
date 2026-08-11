/**
 * Thinking facet — per-driver thinking policy resolution and replay decision.
 *
 * One persisted THINKING message replays according to the policy of the
 * model about to be called, never the model that produced it (R15, R16):
 *
 * - mandatory-in-tool-loop: replay signed/encrypted artifacts unmodified so
 *   tool loops keep their required context (Anthropic signed thinking,
 *   Responses encrypted reasoning items). Without a matching artifact there
 *   is nothing safe to send: providers reject unsigned thinking with tool
 *   use, and the AI SDK drops plain reasoning parts for these adapters.
 * - recommended: replay artifacts when present; legacy messages without a
 *   payload still replay as plain reasoning text (open models).
 * - impossible: omit thinking entirely (opaque/no-exposure protocols).
 *
 * Replayable artifacts from a prior provider/model are stripped at replay
 * time (strip-on-switch); plain readable text degrades gracefully across
 * models while opaque/encrypted artifacts never cross a model boundary.
 */
import type { ThinkingPolicy } from '../../../shared/types/provider-facets';
import {
  ThinkingArtifactKind,
  THINKING_BLOB_MAX_LENGTH,
  THINKING_DISPLAY_TEXT_MAX_LENGTH,
  THINKING_ITEM_ID_MAX_LENGTH,
  type ThinkingReplayPayload,
} from '../../../shared/types/message';
import type { EffectiveModel } from '../../../shared/types/provider';
import type { ProviderDriver, ReasoningProviderOptions } from '../drivers/types';

/**
 * Drivers without a thinkingPolicy hook keep the historical behavior:
 * readable text exposure, recommended replay, plain-text artifacts.
 */
export const DEFAULT_THINKING_POLICY: ThinkingPolicy = {
  exposure: 'readable',
  replay: 'recommended',
};

/**
 * Anthropic extended thinking: readable text, signed blocks replayed
 * unmodified (unsigned thinking with tool use is rejected), display choice
 * declared for adaptive mode (R18).
 */
export const ANTHROPIC_THINKING_POLICY: ThinkingPolicy = {
  exposure: 'readable',
  replay: 'mandatory-in-tool-loop',
  knobs: { displayModes: ['summarized', 'omitted'] },
};

/**
 * Responses-protocol reasoning: the API returns summaries plus (opt-in)
 * encrypted items; replay rides persisted item ids and encrypted content.
 */
export const OPENAI_RESPONSES_THINKING_POLICY: ThinkingPolicy = {
  exposure: 'summary',
  replay: 'recommended',
  knobs: {
    summaryProfiles: ['auto', 'detailed', 'concise'],
    encryptedContentOption: true,
  },
};

/**
 * OpenAI Chat Completions: reasoning is opaque — no readable text persists
 * and replay is impossible, so each turn reasons from scratch.
 */
export const OPENAI_OPAQUE_THINKING_POLICY: ThinkingPolicy = {
  exposure: 'opaque',
  replay: 'impossible',
};

/** Resolve the effective policy for one model; absent hooks mean the default. */
export function resolveThinkingPolicy(
  driver: Pick<ProviderDriver, 'thinkingPolicy'> | undefined,
  model: EffectiveModel,
): ThinkingPolicy {
  return driver?.thinkingPolicy?.(model) ?? DEFAULT_THINKING_POLICY;
}

export interface ThinkingReplayIdentity {
  readonly providerId: string;
  readonly modelId: string;
}

/** What one THINKING message contributes to the replayed request. */
export type ThinkingReplayDecision =
  | { readonly emit: 'artifact'; readonly payload: ThinkingReplayPayload }
  | { readonly emit: 'text'; readonly text: string }
  | { readonly emit: 'none' };

/** Strip-on-switch: an artifact replays only for the exact producing selection. */
export function thinkingArtifactMatchesSelection(
  payload: ThinkingReplayPayload,
  selection: ThinkingReplayIdentity,
): boolean {
  return payload.providerId === selection.providerId
    && payload.modelId === selection.modelId;
}

/** Size guard: replay artifacts feed request bodies, so oversized fields never replay. */
export function thinkingReplayPayloadWithinLimits(payload: ThinkingReplayPayload): boolean {
  return (
    (payload.blob === null || payload.blob.length <= THINKING_BLOB_MAX_LENGTH)
    && (payload.displayText === null
      || payload.displayText.length <= THINKING_DISPLAY_TEXT_MAX_LENGTH)
    && (payload.itemId === undefined
      || payload.itemId.length <= THINKING_ITEM_ID_MAX_LENGTH)
  );
}

/** Decide how one persisted THINKING message reaches the current model. */
export function decideThinkingReplay(input: {
  readonly policy: ThinkingPolicy;
  readonly selection: ThinkingReplayIdentity;
  readonly content: string;
  readonly payload: ThinkingReplayPayload | undefined;
}): ThinkingReplayDecision {
  const { policy, selection, content, payload } = input;

  if (policy.replay === 'impossible') return { emit: 'none' };

  const boundedPayload =
    payload && thinkingReplayPayloadWithinLimits(payload) ? payload : undefined;

  if (
    boundedPayload &&
    thinkingArtifactMatchesSelection(boundedPayload, selection) &&
    (boundedPayload.blob !== null || boundedPayload.displayText !== null)
  ) {
    return { emit: 'artifact', payload: boundedPayload };
  }

  if (policy.replay === 'mandatory-in-tool-loop') {
    return { emit: 'none' };
  }

  // Recommended: a mismatched artifact is stripped, but its readable text (or
  // a legacy payload-free message) still replays as plain reasoning.
  const text = boundedPayload?.displayText ?? content;
  return text.length > 0 ? { emit: 'text', text } : { emit: 'none' };
}

/**
 * Provider options for one replayed artifact, keyed by the producing
 * provider's adapter namespace (AI SDK `providerOptions` on reasoning parts).
 * Unknown kinds intentionally produce no options so plain-text replay keeps
 * its historical shape.
 */
export function buildThinkingProviderOptions(
  payload: ThinkingReplayPayload,
): ReasoningProviderOptions | undefined {
  if (!thinkingReplayPayloadWithinLimits(payload)) return undefined;
  switch (payload.kind) {
    case ThinkingArtifactKind.SIGNED:
      return payload.blob !== null
        ? { anthropic: { signature: payload.blob } }
        : undefined;
    case ThinkingArtifactKind.REDACTED:
      return payload.blob !== null
        ? { anthropic: { redactedData: payload.blob } }
        : undefined;
    case ThinkingArtifactKind.ENCRYPTED:
    case ThinkingArtifactKind.OPAQUE: {
      if (payload.blob === null && !payload.itemId) return undefined;
      const openai: Record<string, string> = {};
      if (payload.itemId) openai.itemId = payload.itemId;
      if (payload.blob !== null) openai.reasoningEncryptedContent = payload.blob;
      return { openai };
    }
    default:
      return undefined;
  }
}

/** Driver-declared request knobs for the active model (R18). */
export interface ThinkingKnobSelection {
  readonly displayMode?: string;
  readonly summaryProfile?: string;
  readonly encryptedContent?: boolean;
}

function declaredValue(
  values: readonly string[] | undefined,
  candidate: string | undefined,
): string | undefined {
  return candidate && values?.includes(candidate) ? candidate : undefined;
}

/**
 * Translate declared thinking knobs into provider-native request options.
 * Only options the driver's policy declares are emitted, and selections are
 * validated against the declared lists: catalog and user data select among
 * driver-declared options but never construct requests (R2, R18).
 */
export function buildThinkingRequestOptions(
  policy: ThinkingPolicy,
  providerId: string,
  selection: ThinkingKnobSelection = {},
): ReasoningProviderOptions | undefined {
  const knobs = policy.knobs;
  if (!knobs) return undefined;

  const displayMode =
    declaredValue(knobs.displayModes, selection.displayMode) ??
    declaredValue(knobs.displayModes, knobs.defaultDisplayMode);
  const summaryProfile =
    declaredValue(knobs.summaryProfiles, selection.summaryProfile) ??
    declaredValue(knobs.summaryProfiles, knobs.defaultSummaryProfile);
  const encryptedContent = knobs.encryptedContentOption === true
    && selection.encryptedContent === true;

  if (providerId === 'anthropic') {
    if (!displayMode) return undefined;
    return { anthropic: { thinking: { type: 'adaptive', display: displayMode } } };
  }
  if (providerId === 'openai') {
    if (!summaryProfile && !encryptedContent) return undefined;
    return {
      openai: {
        ...(summaryProfile ? { reasoningSummary: summaryProfile } : {}),
        ...(encryptedContent ? { include: ['reasoning.encrypted_content'] } : {}),
      },
    };
  }
  return undefined;
}

/** Merge provider options per namespace: thinking knobs, tier, cache, effort. */
export function mergeProviderOptions(
  base: ReasoningProviderOptions | undefined,
  extra: ReasoningProviderOptions | undefined,
): ReasoningProviderOptions | undefined {
  if (!base) return extra;
  if (!extra) return base;
  const merged: ReasoningProviderOptions = { ...base };
  for (const [namespace, values] of Object.entries(extra)) {
    merged[namespace] = { ...(merged[namespace] ?? {}), ...values };
  }
  return merged;
}
