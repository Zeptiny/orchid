import { randomUUID } from 'node:crypto';
import type { LanguageModelMiddleware } from 'ai';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import type {
  FrozenProviderRequestSnapshot,
  NormalizedProviderUsage,
} from '../../../shared/types/accounting';
import type { DriverPricingFacet } from '../drivers/types';
import { extractServedTier } from '../facets/tiers';
import {
  emptyReasoningChars,
  estimateReasoningTokens,
  type ReasoningChars,
} from '../../llm/reasoning-tokens';
import { calculateAttemptCost, type AttemptCostEvidence } from './cost';
import { ProviderAccountingStore } from './store';

export interface ProviderAttemptAccountingContext {
  readonly store: ProviderAccountingStore;
  readonly sessionId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly snapshot: FrozenProviderRequestSnapshot;
  readonly agentScope?: string | null;
  readonly agentName?: string | null;
  readonly agentType?: string | null;
  readonly agentTier?: string | null;
  /** Mutable holder — the middleware writes the per-call attemptId here so the orchestrator can link context snapshots. */
  readonly attemptIdHolder?: { value: string | null };
  /** Driver pricing facet that owns provider-specific cost evidence extraction. */
  readonly pricingFacet?: DriverPricingFacet;
  /** Driver tier mechanism for served-tier evidence capture (R22). */
  readonly tierMechanism?: import('../../../shared/types/provider-facets').TierMechanism;
}

function normalizeUsage(usage: LanguageModelV4Usage | undefined): NormalizedProviderUsage | null {
  if (!usage) return null;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const result: NormalizedProviderUsage = {
    ...(input.total === undefined ? {} : { inputTokens: input.total }),
    ...(output.total === undefined ? {} : { outputTokens: output.total }),
    ...(input.cacheRead === undefined ? {} : { cacheReadTokens: input.cacheRead }),
    ...(input.cacheWrite === undefined ? {} : { cacheWriteTokens: input.cacheWrite }),
    ...(output.reasoning === undefined ? {} : { reasoningTokens: output.reasoning }),
  };
  const total = (input.total ?? 0) + (output.total ?? 0);
  return Object.keys(result).length === 0 && total === 0
    ? null
    : { ...result, totalTokens: total };
}

function emptyOutputChars(): ReasoningChars {
  return emptyReasoningChars();
}

function serializedLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function trackStreamChars(chars: ReasoningChars, part: LanguageModelV4StreamPart): void {
  if (part.type === 'reasoning-delta') chars.reasoning += part.delta.length;
  else if (part.type === 'text-delta') chars.text += part.delta.length;
  else if (part.type === 'tool-input-delta') chars.tool += part.delta.length;
}

function trackContentChars(chars: ReasoningChars, content: readonly LanguageModelV4Content[]): void {
  for (const part of content) {
    if (part.type === 'reasoning') chars.reasoning += part.text.length;
    else if (part.type === 'text') chars.text += part.text.length;
    else if (part.type === 'tool-call') chars.tool += serializedLength(part.input);
  }
}

/**
 * Attach the reasoning estimate to the persisted ledger usage only. Cost is
 * calculated from the provider-reported usage before this runs, so estimates
 * never influence billing.
 */
function withEstimatedReasoning(
  usage: NormalizedProviderUsage | null,
  chars: ReasoningChars,
  outputTokens: number | undefined,
): NormalizedProviderUsage | null {
  if (!usage) return usage;
  // A positive provider-reported count is authoritative. A zero or missing count
  // falls back to the character estimate: models can stream visible reasoning yet
  // report reasoningTokens = 0, which would otherwise record no reasoning at all.
  if (typeof usage.reasoningTokens === 'number' && usage.reasoningTokens > 0) return usage;
  const estimated = estimateReasoningTokens(chars, outputTokens);
  return estimated === undefined ? usage : { ...usage, reasoningTokens: estimated };
}

function allowlistedHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const allowed = new Set([
    'x-request-cost-usd',
    'x-cache-savings-usd',
    'x-allowance-remaining-usd',
    'x-session-spent-usd',
    'x-session-allowance-remaining-usd',
  ]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (allowed.has(name.toLowerCase())) result[name.toLowerCase()] = value;
  }
  return result;
}

/**
 * The header allowlist applies to every provider; a driver pricing facet may
 * replace the derived evidence with its own typed extraction (R4).
 */
function evidenceFor(
  context: ProviderAttemptAccountingContext,
  usage: NormalizedProviderUsage | null,
  headers: Record<string, string> | undefined,
  rawUsage: unknown,
  finishMetadata?: Readonly<Record<string, unknown>>,
): { evidence: AttemptCostEvidence; providerEvidence: Record<string, unknown>; usage: NormalizedProviderUsage | null } {
  const allowedHeaders = allowlistedHeaders(headers);
  let normalizedUsage = usage;
  let evidence: AttemptCostEvidence = {
    ...(allowedHeaders['x-request-cost-usd'] ? {
      reportedCostAmount: allowedHeaders['x-request-cost-usd'],
      reportedCurrency: 'USD',
    } : {}),
  };
  const providerEvidence: Record<string, unknown> = {
    headers: allowedHeaders,
    ...(rawUsage === undefined ? {} : { rawUsage }),
  };

  const extracted = context.pricingFacet?.costEvidence?.({ headers: allowedHeaders, rawUsage, finishMetadata });
  if (extracted) {
    normalizedUsage = {
      ...(usage ?? {}),
      ...(extracted.energyKwhConsumed ? { energyKwhConsumed: extracted.energyKwhConsumed } : {}),
      ...(extracted.energyKwhCharged ? { energyKwhCharged: extracted.energyKwhCharged } : {}),
      ...(extracted.pricingMultiplier ? { pricingMultiplier: extracted.pricingMultiplier } : {}),
    };
    evidence = {
      ...(extracted.reportedCostAmount ? {
        reportedCostAmount: extracted.reportedCostAmount,
        ...(extracted.reportedCurrency ? { reportedCurrency: extracted.reportedCurrency } : {}),
      } : {}),
      ...(extracted.accountingMethod ? { accountingMethod: extracted.accountingMethod } : {}),
      ...(extracted.energyRateUsdPerKwh ? { energyRateUsdPerKwh: extracted.energyRateUsdPerKwh } : {}),
      ...(extracted.currency ? { currency: extracted.currency } : {}),
    };
    if (extracted.providerEvidence) {
      providerEvidence[context.snapshot.providerId] = extracted.providerEvidence;
    }
  }

  // Served tier (R22): the provider-reported tier (parameter mechanism) or
  // the served variant id (variant mechanism) lands in attempt evidence so
  // billing selects the served tier's rates.
  const snapshot = context.snapshot;
  const servedTier = extractServedTier({
    mechanism: context.tierMechanism,
    servedModelId: snapshot.tier?.servedModelId ?? snapshot.modelId,
    baseModelId: snapshot.tier?.baseModelId,
    requestedTier: snapshot.tier?.requestedTier,
    finishMetadata,
  });
  if (servedTier) providerEvidence.servedTier = servedTier;

  return { evidence, providerEvidence, usage: normalizedUsage };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Middleware inserted immediately inside retry middleware. Each doStream or
 * doGenerate invocation gets its own pending ledger row, including retries and
 * AI SDK tool-loop steps. Failure to create that row aborts transport before I/O.
 */
export function createAttemptAccountingMiddleware(
  context: ProviderAttemptAccountingContext,
): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({
      doGenerate,
      params,
    }: {
      doGenerate: () => PromiseLike<LanguageModelV4GenerateResult>;
      doStream: () => PromiseLike<LanguageModelV4StreamResult>;
      params: LanguageModelV4CallOptions;
      model: LanguageModelV4;
    }): Promise<LanguageModelV4GenerateResult> => {
      const attemptId = randomUUID();
      if (context.attemptIdHolder) context.attemptIdHolder.value = attemptId;
      context.store.insertPending({ ...context, attemptId, sdkCallId: attemptId });
      try {
        const result = await doGenerate();
        const chars = emptyOutputChars();
        trackContentChars(chars, result.content);
        const extracted = evidenceFor(
          context,
          normalizeUsage(result.usage),
          result.response?.headers,
          result.usage.raw,
          result.providerMetadata as Readonly<Record<string, unknown>> | undefined,
        );
        context.store.finalize(attemptId, {
          outcome: 'succeeded',
          usage: withEstimatedReasoning(extracted.usage, chars, result.usage.outputTokens.total),
          providerEvidence: extracted.providerEvidence,
          cost: calculateAttemptCost({ snapshot: context.snapshot, usage: extracted.usage, evidence: extracted.evidence }),
        });
        return result;
      } catch (error) {
        context.store.finalize(attemptId, {
          outcome: params.abortSignal?.aborted ? 'interrupted' : 'failed',
          usage: null,
          providerEvidence: {},
          cost: { state: 'unknown', source: 'unknown', reason: 'Provider attempt failed before authoritative usage completed' },
          error: errorMessage(error),
        });
        throw error;
      }
    },

    wrapStream: async ({
      doStream,
      params,
    }: {
      doGenerate: () => PromiseLike<LanguageModelV4GenerateResult>;
      doStream: () => PromiseLike<LanguageModelV4StreamResult>;
      params: LanguageModelV4CallOptions;
      model: LanguageModelV4;
    }): Promise<LanguageModelV4StreamResult> => {
      const attemptId = randomUUID();
      if (context.attemptIdHolder) context.attemptIdHolder.value = attemptId;
      context.store.insertPending({ ...context, attemptId, sdkCallId: attemptId });
      let result: LanguageModelV4StreamResult;
      try {
        result = await doStream();
      } catch (error) {
        context.store.finalize(attemptId, {
          outcome: params.abortSignal?.aborted ? 'interrupted' : 'failed',
          usage: null,
          providerEvidence: {},
          cost: { state: 'unknown', source: 'unknown', reason: 'Provider stream failed before authoritative usage completed' },
          error: errorMessage(error),
        });
        throw error;
      }

      let finalized = false;
      const chars = emptyOutputChars();
      const finalize = (outcome: 'succeeded' | 'failed' | 'interrupted', part?: LanguageModelV4StreamPart, error?: unknown) => {
        if (finalized) return;
        finalized = true;
        const finish = part?.type === 'finish' ? part : undefined;
        const extracted = evidenceFor(
          context,
          normalizeUsage(finish?.usage),
          result.response?.headers,
          finish?.usage.raw,
          finish?.providerMetadata as Readonly<Record<string, unknown>> | undefined,
        );
        context.store.finalize(attemptId, {
          outcome,
          usage: withEstimatedReasoning(extracted.usage, chars, finish?.usage.outputTokens.total),
          providerEvidence: extracted.providerEvidence,
          cost: outcome === 'succeeded'
            ? calculateAttemptCost({ snapshot: context.snapshot, usage: extracted.usage, evidence: extracted.evidence })
            : { state: 'unknown', source: 'unknown', reason: 'Provider stream did not complete with authoritative cost' },
          ...(error === undefined ? {} : { error: errorMessage(error) }),
        });
      };

      const reader = result.stream.getReader();
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              finalize('succeeded');
              controller.close();
              return;
            }
            trackStreamChars(chars, next.value);
            if (next.value.type === 'finish') finalize('succeeded', next.value);
            if (next.value.type === 'error') {
              finalize(params.abortSignal?.aborted ? 'interrupted' : 'failed', next.value, next.value.error);
            }
            controller.enqueue(next.value);
          } catch (error) {
            finalize(params.abortSignal?.aborted ? 'interrupted' : 'failed', undefined, error);
            controller.error(error);
          }
        },
        async cancel(reason) {
          // Mark terminal state before cancelling the upstream reader: some
          // implementations resolve a pending read as `done` during cancel.
          finalize('interrupted', undefined, reason);
          try {
            await reader.cancel(reason);
          } catch {
            // The interrupted row is already durable and idempotent.
          }
        },
      });
      return { ...result, stream };
    },
  };
}
