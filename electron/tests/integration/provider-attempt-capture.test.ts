import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FrozenProviderRequestSnapshot } from '../../src/shared/types/accounting';
import { createAttemptAccountingMiddleware } from '../../src/main/providers/accounting/middleware';
import {
  DEBUG_CAPTURE_MAX_FIELD_BYTES,
  initializeProviderAttemptCaptureStore,
  ProviderAttemptCaptureStore,
  resetProviderAttemptCaptureStore,
} from '../../src/main/providers/accounting/capture-store';
import { ProviderAccountingStore } from '../../src/main/providers/accounting/store';

let tempDir: string | undefined;
let ledger: ProviderAccountingStore | undefined;

afterEach(() => {
  resetProviderAttemptCaptureStore();
  ledger?.close();
  ledger = undefined;
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

/**
 * The middleware reaches the capture store through its runtime singleton
 * (getProviderAttemptCaptureStore), so the tests point that singleton at the
 * same accounting.db file as the ledger — listForSession/getCapture join
 * provider_attempt_captures against provider_attempts.
 */
function setup(): { ledger: ProviderAccountingStore; capture: ProviderAttemptCaptureStore } {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-attempt-capture-'));
  const dbPath = path.join(tempDir, 'accounting.db');
  ledger = new ProviderAccountingStore({ dbPath });
  return { ledger, capture: initializeProviderAttemptCaptureStore({ dbPath }) };
}

interface Harness {
  readonly ledger: ProviderAccountingStore;
  readonly capture: ProviderAttemptCaptureStore;
  readonly wrapStream: (input: Record<string, unknown>) => Promise<{ stream: ReadableStream<unknown> }>;
  readonly wrapGenerate: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function harness(context: { sessionId: string; debugCapture?: boolean }): Harness {
  const { ledger: book, capture } = setup();
  const middleware = createAttemptAccountingMiddleware({
    store: book, sessionId: context.sessionId, chainId: 'chain-1', turnId: 'turn-1',
    snapshot: snapshot(), agentScope: 'subagent', agentName: 'explorer',
    debugCapture: context.debugCapture,
  });
  return {
    ledger: book,
    capture,
    wrapStream: middleware.wrapStream! as unknown as (
      input: Record<string, unknown>,
    ) => Promise<{ stream: ReadableStream<unknown> }>,
    wrapGenerate: middleware.wrapGenerate! as unknown as (
      input: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
  };
}

const USAGE = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 100, text: 100, reasoning: undefined },
};

/** Captured part types in arrival order, including the terminal part. */
const partTypes = (captured: unknown): string[] =>
  (captured as Array<{ type: string }>).map((part) => part.type);

function streamOf(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function consume(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // drain
  }
  // The response capture is deferred off the settle path via queueMicrotask.
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
}

describe('provider attempt debug capture (issue 146)', () => {
  it('writes the ledger row but no capture rows when the debug gate is off', async () => {
    const h = harness({ sessionId: 'session-off' });
    const result = await h.wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: streamOf([{ type: 'finish', finishReason: 'stop', usage: USAGE }]),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params: { prompt: [] }, model: {},
    });
    await consume(result.stream);

    const attempts = h.ledger.listAttempts('session-off');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe('succeeded');
    expect(h.capture.listForSession('session-off')).toEqual([]);
  });

  it('captures the request and the normalized stream parts in arrival order', async () => {
    const h = harness({ sessionId: 'session-stream', debugCapture: true });
    const params = { prompt: [{ role: 'user', content: 'hello' }], temperature: 0.2 };
    const result = await h.wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'text-delta', id: '0', delta: 'hello' },
          { type: 'finish', finishReason: 'stop', usage: USAGE },
        ]),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params, model: {},
    });
    await consume(result.stream);

    const summaries = h.capture.listForSession('session-stream');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      sessionId: 'session-stream', chainId: 'chain-1', turnId: 'turn-1',
      providerId: 'anthropic', connectionName: 'Work', modelId: 'claude-test',
      protocol: 'anthropic-messages', outcome: 'succeeded',
      agentScope: 'subagent', agentName: 'explorer',
      inputTokens: 1000, outputTokens: 100,
      truncated: false, rawAvailable: false,
    });

    const captured = h.capture.getCapture(summaries[0].attemptId);
    expect(captured).not.toBeNull();
    expect(captured!.request).toEqual({
      callOptions: params,
      identity: {
        providerId: 'anthropic',
        connectionId: '11111111-1111-4111-8111-111111111111',
        modelId: 'claude-test',
        protocol: 'anthropic-messages',
      },
    });
    // Arrival order, including the terminal finish part (usage/finishReason),
    // alongside the stream's HTTP response metadata.
    expect(captured!.response).toEqual({
      http: { headers: {} },
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-delta', id: '0', delta: 'hello' },
        { type: 'finish', finishReason: 'stop', usage: USAGE },
      ],
    });
    expect(partTypes((captured!.response as { parts: unknown[] }).parts))
      .toEqual(['stream-start', 'text-delta', 'finish']);
    expect(captured!.rawChunks).toEqual([]);
  });

  it('collects raw provider chunks separately from the normalized parts', async () => {
    const h = harness({ sessionId: 'session-raw', debugCapture: true });
    const result = await h.wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'raw', rawValue: { chunk: 'a' } },
          { type: 'text-delta', id: '0', delta: 'hi' },
          { type: 'raw', rawValue: { chunk: 'b' } },
          { type: 'finish', finishReason: 'stop', usage: USAGE },
        ]),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params: {}, model: {},
    });
    await consume(result.stream);

    const [summary] = h.capture.listForSession('session-raw');
    expect(summary.rawAvailable).toBe(true);
    const captured = h.capture.getCapture(summary.attemptId)!;
    // Raw parts never appear in the normalized response array…
    expect(captured.response).toEqual({
      http: { headers: {} },
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-delta', id: '0', delta: 'hi' },
        { type: 'finish', finishReason: 'stop', usage: USAGE },
      ],
    });
    expect(partTypes((captured.response as { parts: unknown[] }).parts))
      .toEqual(['stream-start', 'text-delta', 'finish']);
    // …they land in rawChunks, in arrival order.
    expect(captured.rawChunks).toEqual([{ chunk: 'a' }, { chunk: 'b' }]);
  });

  it('captures the partial response when the stream errors mid-way', async () => {
    const h = harness({ sessionId: 'session-err', debugCapture: true });
    const result = await h.wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'partial' });
            controller.enqueue({ type: 'error', error: new Error('boom') });
            controller.close();
          },
        }),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params: {}, model: {},
    });
    await consume(result.stream);

    expect(h.ledger.listAttempts('session-err')[0].outcome).toBe('failed');
    const [summary] = h.capture.listForSession('session-err');
    expect(summary.outcome).toBe('failed');
    expect(summary.responseBytes).not.toBeNull();
    const captured = h.capture.getCapture(summary.attemptId)!;
    // Parts up to and including the error part — the exact provider failure
    // is part of the debug record.
    expect(captured.response).toEqual({
      http: { headers: {} },
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-delta', id: '0', delta: 'partial' },
        { type: 'error', error: { name: 'Error', message: 'boom', stack: expect.any(String) } },
      ],
    });
  });

  it('leaves the response half empty when doStream throws before any part', async () => {
    const h = harness({ sessionId: 'session-throw', debugCapture: true });
    const params = { prompt: [{ role: 'user', content: 'hello' }] };
    await expect(h.wrapStream({
      doStream: async () => { throw new Error('temporary network failure'); },
      doGenerate: async () => { throw new Error('not used'); },
      params, model: {},
    })).rejects.toThrow(/temporary network/i);

    const summaries = h.capture.listForSession('session-throw');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].outcome).toBe('failed');
    const captured = h.capture.getCapture(summaries[0].attemptId)!;
    expect(captured.request).toMatchObject({ callOptions: params });
    expect(captured.response).toBeNull();
    expect(captured.rawChunks).toEqual([]);
  });

  it('captures generate-path request/response bodies with credential headers redacted', async () => {
    const h = harness({ sessionId: 'session-generate', debugCapture: true });
    await h.wrapGenerate({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'hi there' }],
        usage: { ...USAGE, raw: undefined },
        request: { body: { model: 'claude-test', messages: [{ role: 'user', content: 'hello' }] } },
        response: {
          headers: { authorization: 'Bearer sk-secret-123', 'content-type': 'application/json' },
          body: { id: 'msg_1', role: 'assistant' },
        },
      }),
      doStream: async () => { throw new Error('not used'); },
      params: { prompt: [{ role: 'user', content: 'hello' }] },
      model: {},
    });

    const summaries = h.capture.listForSession('session-generate');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ outcome: 'succeeded', rawAvailable: false });
    const captured = h.capture.getCapture(summaries[0].attemptId)!;
    expect(captured.response).toMatchObject({
      content: [{ type: 'text', text: 'hi there' }],
      request: { body: { model: 'claude-test', messages: [{ role: 'user', content: 'hello' }] } },
      response: {
        headers: { authorization: '[REDACTED]', 'content-type': 'application/json' },
        body: { id: 'msg_1', role: 'assistant' },
      },
    });
    const headers = (captured.response as { response: { headers: Record<string, string> } })
      .response.headers;
    expect(headers.authorization).toBe('[REDACTED]');
  });

  it('redacts set-cookie response headers before persistence', async () => {
    const h = harness({ sessionId: 'session-set-cookie', debugCapture: true });
    await h.wrapGenerate({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'hi' }],
        usage: { ...USAGE, raw: undefined },
        response: {
          headers: {
            'Set-Cookie': 'session=secret-cookie-token; Path=/; HttpOnly',
            'content-type': 'application/json',
          },
        },
      }),
      doStream: async () => { throw new Error('not used'); },
      params: { prompt: [] },
      model: {},
    });

    const [summary] = h.capture.listForSession('session-set-cookie');
    const captured = h.capture.getCapture(summary.attemptId)!;
    // What getCapture returns is exactly what the Requests inspector renders —
    // the credential must never survive into the persisted/read-back capture.
    const headers = ((captured.response as { response: { headers: Record<string, string> } })
      .response).headers;
    expect(headers['Set-Cookie']).toBe('[REDACTED]');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.stringify(captured)).not.toContain('secret-cookie-token');
  });

  it('redacts credential headers from the captured call options', async () => {
    const h = harness({ sessionId: 'session-headers', debugCapture: true });
    const result = await h.wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: streamOf([{ type: 'finish', finishReason: 'stop', usage: USAGE }]),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params: {
        prompt: [{ role: 'user', content: 'hello' }],
        headers: { authorization: 'Bearer x', 'x-api-key': 'k', 'content-type': 'application/json' },
        abortSignal: new AbortController().signal,
      },
      model: {},
    });
    await consume(result.stream);

    const [summary] = h.capture.listForSession('session-headers');
    const captured = h.capture.getCapture(summary.attemptId)!;
    const callOptions = (captured.request as { callOptions: Record<string, unknown> }).callOptions;
    expect(callOptions.headers).toEqual({
      authorization: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'content-type': 'application/json',
    });
    // Abort signals are runtime handles — never persisted.
    expect(callOptions).not.toHaveProperty('abortSignal');
  });

  it('keeps the first finalized response when finalizeResponse runs twice', () => {
    const { ledger: book, capture } = setup();
    book.insertPending({
      attemptId: 'cap-1', sessionId: 'session-idem', chainId: 'chain-1', turnId: 'turn-1',
      sdkCallId: 'cap-1', snapshot: snapshot(),
    });
    capture.insertRequest({
      attemptId: 'cap-1', sessionId: 'session-idem', request: { callOptions: { prompt: [] } },
    });
    capture.finalizeResponse('cap-1', { response: { first: true }, rawChunks: [] });
    // A replayed settle callback must not overwrite the first response.
    capture.finalizeResponse('cap-1', { response: { second: true }, rawChunks: [{ chunk: 'late' }] });

    const captured = capture.getCapture('cap-1')!;
    expect(captured.response).toEqual({ first: true });
    expect(captured.rawChunks).toEqual([]);
    expect(captured.summary.rawAvailable).toBe(false);
  });

  it('replaces over-cap fields with a truncation marker', () => {
    const { ledger: book, capture } = setup();
    book.insertPending({
      attemptId: 'cap-big', sessionId: 'session-big', chainId: 'chain-1', turnId: 'turn-1',
      sdkCallId: 'cap-big', snapshot: snapshot(),
    });
    capture.insertRequest({
      attemptId: 'cap-big', sessionId: 'session-big',
      request: { callOptions: { prompt: 'x'.repeat(DEBUG_CAPTURE_MAX_FIELD_BYTES + 1024) } },
    });

    const [summary] = capture.listForSession('session-big');
    expect(summary.truncated).toBe(true);
    const captured = capture.getCapture('cap-big')!;
    expect(captured.request).toEqual({
      __truncated: true,
      originalBytes: expect.any(Number),
      capBytes: DEBUG_CAPTURE_MAX_FIELD_BYTES,
    });
    const marker = captured.request as { originalBytes: number };
    expect(marker.originalBytes).toBeGreaterThan(DEBUG_CAPTURE_MAX_FIELD_BYTES);
  });

  it('never breaks the provider stream when the capture store is unavailable', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-attempt-capture-'));
    // A regular file where the capture DB's parent directory should be: every
    // capture write throws, exercising the middleware's best-effort try/catch.
    const blocker = path.join(tempDir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const book = new ProviderAccountingStore({ dbPath: path.join(tempDir, 'accounting.db') });
    ledger = book;
    initializeProviderAttemptCaptureStore({ dbPath: path.join(blocker, 'accounting.db') });
    const middleware = createAttemptAccountingMiddleware({
      store: book, sessionId: 'session-broken', chainId: 'chain-1', turnId: 'turn-1',
      snapshot: snapshot(), debugCapture: true,
    });
    const wrapStream = middleware.wrapStream! as unknown as (
      input: Record<string, unknown>,
    ) => Promise<{ stream: ReadableStream<unknown> }>;
    const result = await wrapStream({
      doStream: async () => ({
        response: { headers: {} },
        stream: streamOf([
          { type: 'text-delta', id: '0', delta: 'still streaming' },
          { type: 'finish', finishReason: 'stop', usage: USAGE },
        ]),
      }),
      doGenerate: async () => { throw new Error('not used'); },
      params: { prompt: [] }, model: {},
    });
    const parts: unknown[] = [];
    const reader = result.stream.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      parts.push(read.value);
    }
    expect(parts).toHaveLength(2);

    expect(book.listAttempts('session-broken')[0]).toMatchObject({
      outcome: 'succeeded', usage: { inputTokens: 1000, outputTokens: 100 },
    });
  });
});
