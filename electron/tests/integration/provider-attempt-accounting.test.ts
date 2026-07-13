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
});
