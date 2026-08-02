import { randomUUID } from 'node:crypto';
import type { LanguageModelMiddleware } from 'ai';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import type {
  FrozenProviderRequestSnapshot,
  NormalizedProviderUsage,
} from '../../../shared/types/accounting';
import { extractNeuralwattBillingEvidence } from '../drivers/neuralwatt';
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

function evidenceFor(
  snapshot: FrozenProviderRequestSnapshot,
  usage: NormalizedProviderUsage | null,
  headers: Record<string, string> | undefined,
  rawUsage: unknown,
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

  if (snapshot.providerId === 'neuralwatt') {
    const neural = extractNeuralwattBillingEvidence(new Headers(allowedHeaders), rawUsage);
    normalizedUsage = {
      ...(usage ?? {}),
      ...(neural.energyKwhConsumed ? { energyKwhConsumed: neural.energyKwhConsumed } : {}),
      ...(neural.energyKwhCharged ? { energyKwhCharged: neural.energyKwhCharged } : {}),
      ...(neural.pricingMultiplier ? { pricingMultiplier: neural.pricingMultiplier } : {}),
    };
    evidence = {
      ...(neural.reportedCostUsd ? { reportedCostAmount: neural.reportedCostUsd, reportedCurrency: 'USD' } : {}),
      ...(neural.accountingMethod ? { accountingMethod: neural.accountingMethod } : {}),
      ...(neural.energyRateUsdPerKwh ? { energyRateUsdPerKwh: neural.energyRateUsdPerKwh } : {}),
      ...(neural.accountingMethod ? { currency: 'USD' } : {}),
    };
    providerEvidence.neuralwatt = neural;
  }
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
      context.store.insertPending({ ...context, attemptId, sdkCallId: attemptId });
      try {
        const result = await doGenerate();
        const extracted = evidenceFor(
          context.snapshot,
          normalizeUsage(result.usage),
          result.response?.headers,
          result.usage.raw,
        );
        context.store.finalize(attemptId, {
          outcome: 'succeeded',
          usage: extracted.usage,
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
      const finalize = (outcome: 'succeeded' | 'failed' | 'interrupted', part?: LanguageModelV4StreamPart, error?: unknown) => {
        if (finalized) return;
        finalized = true;
        const finish = part?.type === 'finish' ? part : undefined;
        const extracted = evidenceFor(
          context.snapshot,
          normalizeUsage(finish?.usage),
          result.response?.headers,
          finish?.usage.raw,
        );
        context.store.finalize(attemptId, {
          outcome,
          usage: extracted.usage,
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
