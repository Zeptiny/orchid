import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FrozenProviderRequestSnapshot } from '../../src/shared/types/accounting';
import { createAttemptAccountingMiddleware } from '../../src/main/providers/accounting/middleware';
import { ProviderAccountingStore } from '../../src/main/providers/accounting/store';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function snapshot(): FrozenProviderRequestSnapshot {
  return {
    providerId: 'anthropic', providerDisplayName: 'Anthropic',
    connectionId: '11111111-1111-4111-8111-111111111111', connectionName: 'Work',
    modelId: 'claude-test', protocol: 'anthropic-messages', modelSource: 'catalog',
    catalogVersion: 1, catalogSource: 'bundled', catalogObservedAt: '2026-07-12T00:00:00.000Z',
    fieldProvenance: {}, statusObservation: null,
    pricing: {
      currency: 'USD', effectiveAt: '2026-07-12T00:00:00.000Z',
      rates: {
        input: { amount: '5', per: 1_000_000, unit: 'tokens' },
        output: { amount: '25', per: 1_000_000, unit: 'tokens' },
      },
      inclusion: { cacheRead: 'subset-of-input', cacheWrite: 'unknown', reasoning: 'unknown' },
      provenance: {},
    },
  };
}

function store(): ProviderAccountingStore {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-attempt-accounting-'));
  return new ProviderAccountingStore({ dbPath: path.join(tempDir, 'accounting.db') });
}

async function consume(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // drain
  }
}

describe('provider attempt accounting middleware', () => {
  it('inserts and finalizes one immutable attempt for each provider stream invocation', async () => {
    const ledger = store();
    const middleware = createAttemptAccountingMiddleware({
      store: ledger, sessionId: 'session-1', chainId: 'chain-1', turnId: 'turn-1', snapshot: snapshot(),
    });
    const wrapStream = middleware.wrapStream! as unknown as (input: Record<string, unknown>) => Promise<{ stream: ReadableStream<unknown> }>;
    const result = await wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'finish', finishReason: 'stop',
              usage: {
                inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 100, text: 100, reasoning: undefined },
              },
            });
            controller.close();
          },
        }),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params: {}, model: {},
    });
    await consume(result.stream);

    expect(ledger.listAttempts('session-1')).toHaveLength(1);
    expect(ledger.listAttempts('session-1')[0]).toMatchObject({
      outcome: 'succeeded', costState: 'calculated', costAmount: '0.0075',
      snapshot: { connectionId: '11111111-1111-4111-8111-111111111111' },
    });
  });

  it('estimates reasoning tokens from output characters when the provider does not report them', async () => {
    const ledger = store();
    const middleware = createAttemptAccountingMiddleware({
      store: ledger, sessionId: 'session-1', chainId: 'chain-1', turnId: 'turn-1', snapshot: snapshot(),
    });
    const wrapStream = middleware.wrapStream! as unknown as (input: Record<string, unknown>) => Promise<{ stream: ReadableStream<unknown> }>;
    const result = await wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'reasoning-delta', id: '0', delta: 'r'.repeat(300) });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 't'.repeat(100) });
            controller.enqueue({
              type: 'finish', finishReason: 'stop',
              usage: {
                inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 100, text: undefined, reasoning: undefined },
              },
            });
            controller.close();
          },
        }),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params: {}, model: {},
    });
    await consume(result.stream);

    const attempt = ledger.listAttempts('session-1')[0];
    expect(attempt.usage?.reasoningTokens).toBe(75);
    // Cost stays calculated from provider-reported usage only.
    expect(attempt).toMatchObject({ costState: 'calculated', costAmount: '0.0075' });
  });

  it('keeps provider-reported reasoning tokens instead of estimating', async () => {
    const ledger = store();
    const middleware = createAttemptAccountingMiddleware({
      store: ledger, sessionId: 'session-1', chainId: 'chain-1', turnId: 'turn-1', snapshot: snapshot(),
    });
    const wrapStream = middleware.wrapStream! as unknown as (input: Record<string, unknown>) => Promise<{ stream: ReadableStream<unknown> }>;
    const result = await wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'reasoning-delta', id: '0', delta: 'r'.repeat(300) });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 't'.repeat(100) });
            controller.enqueue({
              type: 'finish', finishReason: 'stop',
              usage: {
                inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 100, text: 60, reasoning: 40 },
              },
            });
            controller.close();
          },
        }),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params: {}, model: {},
    });
    await consume(result.stream);

    expect(ledger.listAttempts('session-1')[0].usage?.reasoningTokens).toBe(40);
  });

  it('estimates reasoning tokens for non-streaming generation from content parts', async () => {
    const ledger = store();
    const middleware = createAttemptAccountingMiddleware({
      store: ledger, sessionId: 'session-1', chainId: 'chain-1', turnId: 'turn-1', snapshot: snapshot(),
    });
    const wrapGenerate = middleware.wrapGenerate! as unknown as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    await wrapGenerate({
      doGenerate: async () => ({
        content: [
          { type: 'reasoning', text: 'r'.repeat(300) },
          { type: 'text', text: 't'.repeat(100) },
        ],
        response: { headers: {} },
        usage: {
          inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 100, text: undefined, reasoning: undefined },
          raw: undefined,
        },
      }),
      doStream: async () => { throw new Error('not used'); },
      params: {}, model: {},
    });

    const attempt = ledger.listAttempts('session-1')[0];
    expect(attempt.usage?.reasoningTokens).toBe(75);
    expect(attempt).toMatchObject({ costState: 'calculated', costAmount: '0.0075' });
  });

  it('records a distinct failed attempt for each retryable transport invocation', async () => {
    const ledger = store();
    const middleware = createAttemptAccountingMiddleware({
      store: ledger, sessionId: 'session-1', chainId: 'chain-1', turnId: 'turn-1', snapshot: snapshot(),
    });
    const wrapStream = middleware.wrapStream! as unknown as (input: Record<string, unknown>) => Promise<unknown>;
    const input = {
      doStream: async () => { throw new Error('temporary network failure'); },
      doGenerate: async () => { throw new Error('not used'); }, params: {}, model: {},
    };
    await expect(wrapStream(input)).rejects.toThrow(/temporary network/i);
    await expect(wrapStream(input)).rejects.toThrow(/temporary network/i);

    expect(ledger.listAttempts('session-1')).toHaveLength(2);
    expect(ledger.listAttempts('session-1').map((attempt) => attempt.outcome)).toEqual(['failed', 'failed']);
  });

  it('finalizes a cancelled provider stream as interrupted without synthesizing usage or cost', async () => {
    const ledger = store();
    const middleware = createAttemptAccountingMiddleware({
      store: ledger, sessionId: 'session-1', chainId: 'chain-1', turnId: 'turn-1', snapshot: snapshot(),
    });
    const wrapStream = middleware.wrapStream! as unknown as (input: Record<string, unknown>) => Promise<{ stream: ReadableStream<unknown> }>;
    const result = await wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: new ReadableStream({ start() { /* wait until cancellation */ } }),
      }),
      doGenerate: async () => { throw new Error('not used'); }, params: { abortSignal: new AbortController().signal }, model: {},
    });
    await result.stream.getReader().cancel('user cancelled');

    expect(ledger.listAttempts('session-1')[0]).toMatchObject({
      outcome: 'interrupted', usage: null, costState: 'unknown', costAmount: null,
    });
  });

  it('refuses transport when the required pending ledger row cannot be committed', async () => {
    let transportCalls = 0;
    const doStream = async () => {
      transportCalls += 1;
      return { stream: new ReadableStream(), response: { headers: {} } };
    };
    const middleware = createAttemptAccountingMiddleware({
      store: { insertPending: () => { throw new Error('ledger unavailable'); } } as never,
      sessionId: 'session-1', chainId: 'chain-1', turnId: 'turn-1', snapshot: snapshot(),
    });
    const wrapStream = middleware.wrapStream! as unknown as (input: Record<string, unknown>) => Promise<unknown>;

    await expect(wrapStream({
      doStream,
      doGenerate: async () => { throw new Error('not used'); }, params: {}, model: {},
    })).rejects.toThrow(/ledger unavailable/);
    expect(transportCalls).toBe(0);
  });

  it('routes evidence through the driver pricing facet and records the rate rung', async () => {
    const ledger = store();
    const energySnapshot: FrozenProviderRequestSnapshot = {
      ...snapshot(),
      providerId: 'neuralwatt',
      pricing: {
        currency: 'USD', effectiveAt: '2026-07-12T00:00:00.000Z',
        rates: {
          energy: {
            amount: '5', per: 1, unit: 'energy',
            provenance: { source: 'provider-api', observedAt: '2026-07-12T00:00:00.000Z' },
          },
        },
        inclusion: { cacheRead: 'unknown', cacheWrite: 'unknown', reasoning: 'unknown' },
        provenance: { source: 'provider-api' },
      },
    };
    const middleware = createAttemptAccountingMiddleware({
      store: ledger, sessionId: 'session-1', chainId: 'chain-1', turnId: 'turn-1', snapshot: energySnapshot,
      pricingFacet: {
        costEvidence: () => ({
          accountingMethod: 'energy',
          currency: 'USD',
          energyKwhConsumed: '0.02',
          energyKwhCharged: '0.013',
          pricingMultiplier: '0.65',
          providerEvidence: { accountingMethod: 'energy', measurementAvailable: true },
        }),
      },
    });
    const wrapStream = middleware.wrapStream! as unknown as (input: Record<string, unknown>) => Promise<{ stream: ReadableStream<unknown> }>;
    const result = await wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'finish', finishReason: 'stop',
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
                raw: { accounting_method: 'energy' },
              },
            });
            controller.close();
          },
        }),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params: {}, model: {},
    });
    await consume(result.stream);

    expect(ledger.listAttempts('session-1')[0]).toMatchObject({
      outcome: 'succeeded',
      costState: 'calculated',
      costSource: 'energy-formula',
      costRung: 'provider-api',
      costAmount: '0.065',
      usage: { energyKwhConsumed: '0.02', energyKwhCharged: '0.013', pricingMultiplier: '0.65' },
      // The ledger sanitizer redacts account-shaped keys before persistence.
      providerEvidence: { neuralwatt: { accountingMethod: '[REDACTED]', measurementAvailable: true } },
    });
    ledger.close();
  });
  it('records the served tier from finish metadata and bills the served variant rates (R22)', async () => {
    const ledger = store();
    const tiered = snapshot();
    // Variant-mechanism snapshot: the served variant id + base are frozen at
    // request start, and pricing freezes the variant's (discounted) rates.
    tiered.providerId = 'neuralwatt';
    tiered.modelId = 'glm-5.2-flex';
    tiered.pricing = {
      currency: 'USD', effectiveAt: '2026-07-12T00:00:00.000Z',
      rates: {
        input: { amount: '0.725', per: 1_000_000, unit: 'tokens' },
        output: { amount: '2.25', per: 1_000_000, unit: 'tokens' },
      },
      inclusion: { cacheRead: 'subset-of-input', cacheWrite: 'unknown', reasoning: 'unknown' },
      provenance: {},
    };
    tiered.tier = {
      mechanism: 'model-name-variants',
      requestedTier: 'flex',
      servedModelId: 'glm-5.2-flex',
      baseModelId: 'glm-5.2',
    };
    const middleware = createAttemptAccountingMiddleware({
      store: ledger, sessionId: 'session-1', chainId: 'chain-1', turnId: 'turn-1', snapshot: tiered,
      tierMechanism: {
        kind: 'model-name-variants',
        tiers: [{ id: 'flex', modelIdSuffix: '-flex' }],
      },
    });
    const wrapStream = middleware.wrapStream! as unknown as (input: Record<string, unknown>) => Promise<{ stream: ReadableStream<unknown> }>;
    const result = await wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'finish', finishReason: 'stop',
              usage: {
                inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 100, text: 100, reasoning: undefined },
              },
            });
            controller.close();
          },
        }),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params: {}, model: {},
    });
    await consume(result.stream);

    const attempt = ledger.listAttempts('session-1')[0];
    // Billed at the served variant's flex rates: 1000*0.725/M + 100*2.25/M.
    expect(attempt).toMatchObject({ outcome: 'succeeded', costState: 'calculated', costAmount: '0.00095' });
    expect(attempt.providerEvidence.servedTier).toMatchObject({
      tier: 'flex', servedModelId: 'glm-5.2-flex', baseModelId: 'glm-5.2', requestedTier: 'flex',
    });
    ledger.close();
  });

  it('captures the provider-reported service tier for parameter mechanisms (R22)', async () => {
    const ledger = store();
    const tiered = snapshot();
    tiered.providerId = 'openai';
    tiered.modelId = 'gpt-5.6';
    tiered.tier = { mechanism: 'request-parameter', requestedTier: 'flex' };
    const middleware = createAttemptAccountingMiddleware({
      store: ledger, sessionId: 'session-1', chainId: 'chain-1', turnId: 'turn-1', snapshot: tiered,
      tierMechanism: {
        kind: 'request-parameter',
        parameter: 'serviceTier',
        tiers: [{ id: 'flex' }],
      },
    });
    const wrapStream = middleware.wrapStream! as unknown as (input: Record<string, unknown>) => Promise<{ stream: ReadableStream<unknown> }>;
    const result = await wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'finish', finishReason: 'stop',
              providerMetadata: { openai: { serviceTier: 'flex' } },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
            });
            controller.close();
          },
        }),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params: {}, model: {},
    });
    await consume(result.stream);

    expect(ledger.listAttempts('session-1')[0].providerEvidence.servedTier).toMatchObject({
      tier: 'flex', requestedTier: 'flex',
    });
    ledger.close();
  });
});
