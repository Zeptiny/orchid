/**
 * Thinking render metadata (R17): decide whether a THINKING message renders
 * as readable text, a provider summary, or an opaque "thinking (N tokens)"
 * indicator. The renderer consumes the same rule through the message shape;
 * this module is the main-process source of truth for tests and producers.
 */
import {
  ThinkingArtifactKind,
  type ThinkingReplayPayload,
} from '../../../shared/types/message';
import type {
  ThinkingExposure,
  ThinkingPolicy,
} from '../../../shared/types/provider-facets';

export type ThinkingRenderMetadata =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'indicator'; readonly tokenCount?: number };

/**
 * Resolve how one THINKING message should render. Readable text and provider
 * summaries render as text; opaque thinking (OpenAI) persists no readable
 * text and renders an indicator carrying the reported reasoning token count.
 */
export function thinkingRenderMetadata(input: {
  readonly exposure: ThinkingExposure;
  readonly content: string;
  readonly payload: ThinkingReplayPayload | undefined;
}): ThinkingRenderMetadata {
  const { exposure, content, payload } = input;
  if (exposure === 'readable' || exposure === 'summary') {
    const text = content || payload?.displayText || '';
    if (text) return { kind: 'text', text };
  }
  return {
    kind: 'indicator',
    ...(payload?.reasoningTokenCount !== undefined
      ? { tokenCount: payload.reasoningTokenCount }
      : {}),
  };
}

/**
 * Payload-free convenience form for the policy default: plain-text reasoning
 * renders as text unless the policy hides thinking entirely.
 */
export function thinkingRenderMetadataForPolicy(
  policy: ThinkingPolicy,
  content: string,
  payload: ThinkingReplayPayload | undefined,
): ThinkingRenderMetadata {
  return thinkingRenderMetadata({ exposure: policy.exposure, content, payload });
}

/** True when a payload kind never carries provider-readable thinking text. */
export function isOpaqueThinkingPayload(payload: ThinkingReplayPayload): boolean {
  return payload.kind === ThinkingArtifactKind.OPAQUE
    || (payload.kind === ThinkingArtifactKind.ENCRYPTED && payload.displayText === null);
}
