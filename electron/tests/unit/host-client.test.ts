/**
 * U5 — HostClient over the in-process transport.
 *
 * Real under test: HostClient (request correlation, handshake gating, event
 * fan-out with per-connection seq, close semantics) and
 * InProcessHostTransport against a real HostServer — the same composition the
 * embedded local host uses.
 *
 * Mocked: session/singleton (the per-window active-session maps) and the
 * working-set bootstrap (which would otherwise touch the real ~/.orchid).
 * A scripted fake transport covers the wire-shaped (JSON line) transport path
 * and close/timeout semantics without a server.
 */
import { describe, expect, expectTypeOf, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => ({
    getActive: vi.fn(() => null),
    getSession: vi.fn(() => null),
  }),
  resolveWindowWorkspace: () => ({ cwd: null, source: 'unbound', status: 'unbound' }),
  resolveBoundProjectPath: () => null,
}));

vi.mock('../../src/main/session/working-set-live', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/main/session/working-set-live')
  >();
  return {
    ...actual,
    bootstrapWorkingSet: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    setWorkingSetBroadcast: vi.fn(),
  };
});

import {
  HOST_ERROR_CODES,
  HOST_ORIGINAL_ERROR_KEY,
  HostProtocolError,
  attachHostOriginalError,
  type HostHelloResult,
} from '../../src/shared/host/protocol';
import { createHostServer, type HostServer } from '../../src/main/host/server';
import { createInProcessTransport } from '../../src/main/host/transport-inprocess';
import {
  createHostClient,
  HostClient,
  type HostClientOptions,
} from '../../src/main/host/client';
import type { HostTransport } from '../../src/main/host/transport';

const CLIENT_ID = '4242';

let server: HostServer;

beforeEach(() => {
  server = createHostServer({ serverVersion: 'test-agent' });
});

afterEach(() => {
  server.dispose();
});

function makeClient(clientId = CLIENT_ID, options: Partial<HostClientOptions> = {}): HostClient {
  return createHostClient(
    createInProcessTransport({ server, clientId }),
    { clientId, ...options },
  );
}

describe('HostClient over the in-process transport', () => {
  it('round-trips a request through the handshake', async () => {
    const client = makeClient();
    const hello = await client.request<{ protocolVersion: number; capabilities: string[] }>(
      'host.hello',
      { protocolVersion: 1 },
    );
    expect(hello.protocolVersion).toBeGreaterThan(0);
    expect(Array.isArray(hello.capabilities)).toBe(true);
    expect(client.isAlive()).toBe(true);
    client.close();
  });

  it('rejects an unknown method with HostProtocolError METHOD_NOT_FOUND', async () => {
    const client = makeClient();
    const error = await client.request('no.such.method').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostProtocolError);
    expect((error as HostProtocolError).code).toBe(HOST_ERROR_CODES.METHOD_NOT_FOUND);
    client.close();
  });

  it('preserves the original error object thrown by a binding (identity)', async () => {
    const client = makeClient();
    const expectedMessage = 'Cannot create session: no project folder selected. Choose a folder first.';
    // session.create throws exactly this for an unbound workspace; assert the
    // client rejects with the same *instance*, not a serialized copy.
    const error: unknown = await client.request('session.create').catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(expectedMessage);
    expect(error).not.toBeInstanceOf(HostProtocolError);
    // The identity guarantee: the server attached the very same object.
    const serverSide = await server
      .handleRequest({ id: 999, method: 'session.create' }, CLIENT_ID)
      .then((response) => (response.ok ? null : response.error));
    expect(serverSide && HOST_ORIGINAL_ERROR_KEY in serverSide).toBe(true);
    client.close();
  });

  it('keeps an in-process result object identical (no JSON round-trip)', async () => {
    const client = makeClient();
    const payload = { nested: { live: true } };
    server.emitTo(CLIENT_ID, 'session:renamed', payload);
    client.close();
    const second = makeClient();
    const received: unknown[] = [];
    second.subscribe('session:renamed', (params) => received.push(params));
    server.emitTo(CLIENT_ID, 'session:renamed', payload);
    await Promise.resolve();
    expect(received[0]).toBe(payload);
    second.close();
  });

  it('tracks the per-connection event sequence', async () => {
    const client = makeClient();
    const seen: Array<{ params: unknown; seq: number }> = [];
    client.subscribe('session:renamed', (params, seq) => seen.push({ params, seq }));
    expect(client.lastSeq()).toBe(-1);
    server.emitTo(CLIENT_ID, 'session:renamed', { id: 's1', name: 'One' });
    server.emitTo(CLIENT_ID, 'session:renamed', { id: 's1', name: 'Two' });
    server.emitTo(CLIENT_ID, 'session:renamed', { id: 's1', name: 'Three' });
    expect(seen.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(client.lastSeq()).toBe(3);
    client.close();
  });

  it('rejects subscriptions to unknown events', () => {
    const client = makeClient();
    expect(() => client.subscribe('not:an:event', () => {})).toThrow(/Unknown host event/);
    client.close();
  });

  it('gates methods behind a successful handshake with a typed mismatch', async () => {
    const client = makeClient('4243', { protocolVersion: 9999 });
    const error = await client.request('host.hello').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostProtocolError);
    expect((error as HostProtocolError).code).toBe(HOST_ERROR_CODES.PROTOCOL_MISMATCH);
    client.close();
  });

  it('delivers events only to the connection that owns them', () => {
    const a = makeClient('1111');
    const b = makeClient('2222');
    const seenByA: unknown[] = [];
    const seenByB: unknown[] = [];
    a.subscribe('session:renamed', (params) => seenByA.push(params));
    b.subscribe('session:renamed', (params) => seenByB.push(params));
    server.emitTo('1111', 'session:renamed', { id: 's1', name: 'Only A' });
    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(0);
    a.close();
    b.close();
  });

  it('stops delivering after close and reports the client as not alive', () => {
    const client = makeClient();
    const seen: unknown[] = [];
    client.subscribe('session:renamed', (params) => seen.push(params));
    let closed = false;
    client.onClose(() => {
      closed = true;
    });
    client.close();
    expect(closed).toBe(true);
    expect(client.isAlive()).toBe(false);
    server.emitTo(CLIENT_ID, 'session:renamed', { id: 's1', name: 'After' });
    expect(seen).toHaveLength(0);
  });
});

// ── Wire-shaped (JSON line) transport ────────────────────────────────────────

/** Scripted transport: a peer that answers on the line protocol. */
class ScriptedTransport implements HostTransport {
  private dataCallback: ((line: string) => void) | null = null;
  private readonly closeCallbacks: Array<() => void> = [];
  written: string[] = [];
  closed = false;

  /** Install the peer behavior for the next incoming request line. */
  respondWith(handler: (frame: { id: number; method: string }) => unknown): void {
    this.handler = handler;
  }

  private handler: ((frame: { id: number; method: string }) => unknown) | null = null;

  write(line: string): void {
    this.written.push(line);
    const frame = JSON.parse(line) as { id: number; method: string };
    if (frame.method === 'host.hello') {
      this.dataCallback?.(JSON.stringify({
        id: frame.id,
        ok: true,
        result: { protocolVersion: 1, capabilities: [] },
      }));
      return;
    }
    if (!this.handler) return;
    const answer = this.handler(frame);
    if (answer !== undefined) this.dataCallback?.(JSON.stringify(answer));
  }

  onData(cb: (line: string) => void): void {
    this.dataCallback = cb;
  }

  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const callback of this.closeCallbacks.splice(0)) callback();
  }

  /** Simulate the peer pushing an event frame. */
  push(frame: unknown): void {
    this.dataCallback?.(JSON.stringify(frame));
  }
}

describe('HostClient over a JSON-line transport', () => {
  it('correlates responses by auto-incrementing request id', async () => {
    const transport = new ScriptedTransport();
    transport.respondWith((frame) => ({ id: frame.id, ok: true, result: { echoed: frame.method } }));
    const client = createHostClient(transport, { clientId: 'w1' });
    await expect(client.request('config.get')).resolves.toEqual({ echoed: 'config.get' });
    await expect(client.request('config.get_home')).resolves.toEqual({ echoed: 'config.get_home' });
    const second = transport.written.map((line) => JSON.parse(line) as { id: number });
    expect(second[1].id).toBeGreaterThan(second[0].id);
    client.close();
  });

  it('rejects pending requests when the transport closes', async () => {
    const transport = new ScriptedTransport();
    transport.respondWith(() => undefined); // never answers
    const client = createHostClient(transport, { clientId: 'w2' });
    const pending = client.request('config.get').catch((error: unknown) => error);
    await new Promise((resolve) => setImmediate(resolve));
    transport.close();
    const error = await pending;
    expect(error).toBeInstanceOf(HostProtocolError);
    expect((error as HostProtocolError).code).toBe(HOST_ERROR_CODES.HOST_UNAVAILABLE);
    expect(client.isAlive()).toBe(false);
  });

  it('rethrows an original error a structured carrier put on the error leg', async () => {
    // A structured transport (not JSON) can carry the very same Error object
    // on `data`; the client must rethrow it verbatim.
    const original = new Error('binding exploded');
    const frames: Array<(frame: unknown) => void> = [];
    const transport: HostTransport = {
      write: (line: string) => {
        const frame = JSON.parse(line) as { id: number; method: string };
        frames.shift()?.(frame);
      },
      onData: () => {},
      onClose: () => {},
      close: () => {},
    };
    const structured = transport as HostTransport & {
      onFrame: (cb: (frame: unknown) => void) => void;
      writeFrame: (frame: unknown) => void;
    };
    const listeners: Array<(frame: unknown) => void> = [];
    structured.onFrame = (cb) => {
      listeners.push(cb);
    };
    structured.writeFrame = (frame) => {
      const request = frame as { id: number; method: string };
      const respond = (answer: unknown) => {
        for (const listener of listeners) listener(answer);
      };
      if (request.method === 'host.hello') {
        respond({ id: request.id, ok: true, result: { protocolVersion: 1, capabilities: [] } });
        return;
      }
      respond({
        id: request.id,
        ok: false,
        error: {
          code: HOST_ERROR_CODES.INTERNAL,
          message: original.message,
          data: { [HOST_ORIGINAL_ERROR_KEY]: original },
        },
      });
    };
    const client = createHostClient(transport, { clientId: 'w3' });
    await expect(client.request('config.get')).rejects.toBe(original);
    client.close();
  });

  it('maps a plain error payload to a typed HostProtocolError', async () => {
    const transport = new ScriptedTransport();
    transport.respondWith((frame) => ({
      id: frame.id,
      ok: false,
      error: { code: HOST_ERROR_CODES.INVALID_PARAMS, message: 'bad payload' },
    }));
    const client = createHostClient(transport, { clientId: 'w4' });
    const error = await client.request('config.get').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostProtocolError);
    expect((error as HostProtocolError).code).toBe(HOST_ERROR_CODES.INVALID_PARAMS);
    client.close();
  });

  it('drops a wire-mangled original error and surfaces the typed payload', async () => {
    const transport = new ScriptedTransport();
    const original = new Error('binding exploded');
    // Simulate a real transport: the Error serializes to {} inside data.
    const encoded = JSON.parse(JSON.stringify({
      code: HOST_ERROR_CODES.INTERNAL,
      message: original.message,
      data: { [HOST_ORIGINAL_ERROR_KEY]: original },
    }));
    transport.respondWith((frame) => ({ id: frame.id, ok: false, error: encoded }));
    const client = createHostClient(transport, { clientId: 'w7' });
    const error = await client.request('config.get').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostProtocolError);
    expect((error as HostProtocolError).message).toBe('binding exploded');
    client.close();
  });

  it('rejects a smuggled non-Error original error with the typed payload', async () => {
    // A hostile/buggy peer can put the non-enumerable key INTO the JSON error
    // payload itself; the deserialized value is a plain object, which must
    // never become the rejection value — only real Error instances rethrow.
    const transport = new ScriptedTransport();
    const smuggled = { evil: true };
    transport.respondWith((frame) => ({
      id: frame.id,
      ok: false,
      error: {
        code: HOST_ERROR_CODES.INTERNAL,
        message: 'binding exploded',
        [HOST_ORIGINAL_ERROR_KEY]: smuggled,
      },
    }));
    const client = createHostClient(transport, { clientId: 'w8' });
    const error = await client.request('config.get').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostProtocolError);
    expect(error).not.toBe(smuggled);
    expect((error as HostProtocolError).code).toBe(HOST_ERROR_CODES.INTERNAL);
    expect((error as HostProtocolError).message).toBe('binding exploded');
    client.close();
  });

  it('attaches original errors without serializing them onto the payload', () => {
    const payload = attachHostOriginalError({ code: HOST_ERROR_CODES.INTERNAL, message: 'x' }, new Error('boom'));
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ code: 'INTERNAL', message: 'x' });
  });

  it('expires a request when a deadline is configured', async () => {
    const transport = new ScriptedTransport();
    transport.respondWith(() => undefined);
    const client = createHostClient(transport, {
      clientId: 'w5',
      requestTimeoutMs: 5,
    });
    const error = await client.request('config.get').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostProtocolError);
    expect((error as HostProtocolError).code).toBe(HOST_ERROR_CODES.TIMEOUT);
    client.close();
  });

  it('dispatches event frames and tracks their sequence', () => {
    const transport = new ScriptedTransport();
    const client = createHostClient(transport, { clientId: 'w6' });
    const seen: number[] = [];
    client.subscribe('session:todos_changed', (_params, seq) => seen.push(seq));
    transport.push({ ev: 'session:todos_changed', params: { sessionId: 's' }, seq: 4 });
    transport.push({ ev: 'session:todos_changed', params: { sessionId: 's' }, seq: 9 });
    expect(seen).toEqual([4, 9]);
    expect(client.lastSeq()).toBe(9);
    client.close();
  });
});

// ── Per-method request deadlines (#24) ───────────────────────────────────────

describe('HostClient per-method request deadlines', () => {
  it('rejects a wedged request with TIMEOUT while the transport stays open', async () => {
    const transport = new ScriptedTransport();
    transport.respondWith(() => undefined); // wedged: never answers
    const client = createHostClient(transport, { clientId: 't1', requestTimeoutMs: 5 });
    const error = await client.request('config.get').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostProtocolError);
    expect((error as HostProtocolError).code).toBe(HOST_ERROR_CODES.TIMEOUT);
    expect((error as HostProtocolError).message).toContain('config.get');
    // The deadline rejects the request; it never kills the transport.
    expect(client.isAlive()).toBe(true);
    expect(transport.closed).toBe(false);
    client.close();
  });

  it('keeps serving requests on the same open transport after a timeout', async () => {
    const transport = new ScriptedTransport();
    let calls = 0;
    transport.respondWith((frame) => {
      calls += 1;
      // First request wedges; the second is answered.
      return calls === 1 ? undefined : { id: frame.id, ok: true, result: { ok: true } };
    });
    const client = createHostClient(transport, { clientId: 't2', requestTimeoutMs: 5 });
    const first = await client.request('config.get').catch((e: unknown) => e);
    expect((first as HostProtocolError).code).toBe(HOST_ERROR_CODES.TIMEOUT);
    await expect(client.request('config.save', { updates: {} })).resolves.toEqual({ ok: true });
    expect(client.isAlive()).toBe(true);
    client.close();
  });

  it('exempts a long-running method from the deadline via the resolver', async () => {
    vi.useFakeTimers();
    try {
      const transport = new ScriptedTransport();
      transport.respondWith(() => undefined); // never answers
      const client = createHostClient(transport, {
        clientId: 't3',
        requestTimeoutMs: 5,
        methodTimeoutMs: (method) => (method === 'rag.index' ? 0 : undefined),
      });
      const pending = client.request('rag.index', { force: true });
      const outcome = await Promise.race([
        pending.then(
          () => 'settled',
          (error: unknown) => `rejected:${(error as HostProtocolError).code}`,
        ),
        vi.advanceTimersByTimeAsync(50).then(() => 'still-pending'),
      ]);
      expect(outcome).toBe('still-pending');
      // Cleanup settles the exempt request through the close path instead.
      transport.close();
      await expect(pending).rejects.toMatchObject({ code: HOST_ERROR_CODES.HOST_UNAVAILABLE });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the per-method resolver shorten the default deadline', async () => {
    const transport = new ScriptedTransport();
    transport.respondWith(() => undefined);
    const client = createHostClient(transport, {
      clientId: 't4',
      requestTimeoutMs: 60_000,
      methodTimeoutMs: (method) => (method === 'config.get' ? 5 : undefined),
    });
    const error = await client.request('config.get').catch((e: unknown) => e);
    expect((error as HostProtocolError).code).toBe(HOST_ERROR_CODES.TIMEOUT);
    expect((error as HostProtocolError).message).toContain('5ms');
    client.close();
  });

  it('keeps the disabled (0) default deadline for the local in-process client', async () => {
    // local-host.ts creates its client without deadline options; a method that
    // never answers must stay pending (fake timers prove no timer is armed).
    vi.useFakeTimers();
    try {
      const transport = new ScriptedTransport();
      transport.respondWith(() => undefined);
      const client = createHostClient(transport, { clientId: 't5' });
      const pending = client.request('config.get');
      const outcome = await Promise.race([
        pending.then(
          () => 'settled',
          (error: unknown) => `rejected:${(error as HostProtocolError).code}`,
        ),
        vi.advanceTimersByTimeAsync(120_000).then(() => 'still-pending'),
      ]);
      expect(outcome).toBe('still-pending');
      client.close();
      await expect(pending).rejects.toMatchObject({ code: HOST_ERROR_CODES.HOST_UNAVAILABLE });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Inbound registry validation (#16) ────────────────────────────────────────

describe('HostClient inbound validation', () => {
  const VALID_SUMMARY = {
    id: 's1',
    name: 'One',
    modelLabel: null,
    cwd: null,
    chainCount: 0,
    updatedAt: 123,
  };

  it('drops a malformed event payload with a warning and never throws', () => {
    const transport = new ScriptedTransport();
    const client = createHostClient(transport, { clientId: 'v1', validateInbound: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const seen: unknown[] = [];
      client.subscribe('session:renamed', (params) => seen.push(params));
      expect(() => {
        transport.push({ ev: 'session:renamed', params: { nope: true }, seq: 7 });
      }).not.toThrow();
      expect(seen).toHaveLength(0);
      // The seq still advances so reconnect resync keeps its gap detection.
      expect(client.lastSeq()).toBe(7);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0])).toContain('session:renamed');
    } finally {
      warn.mockRestore();
      client.close();
    }
  });

  it('drops frames for event names outside the registry with a warning', () => {
    const transport = new ScriptedTransport();
    const client = createHostClient(transport, { clientId: 'v2', validateInbound: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => {
        transport.push({ ev: 'made:up:event', params: { evil: true }, seq: 1 });
      }).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0])).toContain('made:up:event');
    } finally {
      warn.mockRestore();
      client.close();
    }
  });

  it('rejects a malformed ok-result with a typed protocol error', async () => {
    const transport = new ScriptedTransport();
    transport.respondWith((frame) => ({ id: frame.id, ok: true, result: [{ missing: 'fields' }] }));
    const client = createHostClient(transport, { clientId: 'v3', validateInbound: true });
    const error = await client.request('session.list').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostProtocolError);
    expect((error as HostProtocolError).code).toBe(HOST_ERROR_CODES.INTERNAL);
    expect((error as HostProtocolError).message).toContain('session.list');
    expect((error as HostProtocolError).message).toContain('malformed result');
    client.close();
  });

  it('accepts the null wire encoding of a void result', async () => {
    const transport = new ScriptedTransport();
    transport.respondWith((frame) => ({ id: frame.id, ok: true, result: null }));
    const client = createHostClient(transport, { clientId: 'v4', validateInbound: true });
    await expect(client.request('chat.queue_next', { sessionId: 'abc' })).resolves.toBeNull();
    client.close();
  });

  it('passes well-formed events and results through unchanged', async () => {
    const transport = new ScriptedTransport();
    transport.respondWith((frame) => ({ id: frame.id, ok: true, result: [VALID_SUMMARY] }));
    const client = createHostClient(transport, { clientId: 'v5', validateInbound: true });
    await expect(client.request('session.list')).resolves.toEqual([VALID_SUMMARY]);
    const events: unknown[] = [];
    client.subscribe('session:renamed', (params) => events.push(params));
    const payload = { id: 's1', name: 'Renamed' };
    transport.push({ ev: 'session:renamed', params: payload, seq: 2 });
    expect(events).toEqual([payload]);
    client.close();
  });

  it('does not validate inbound frames when the option is off (local default)', async () => {
    const transport = new ScriptedTransport();
    transport.respondWith((frame) => ({ id: frame.id, ok: true, result: { echoed: frame.method } }));
    const client = createHostClient(transport, { clientId: 'v6' });
    await expect(client.request('config.get')).resolves.toEqual({ echoed: 'config.get' });
    client.close();
  });
});

// ── Registry-typed request overloads (#10) ────────────────────────────────────

describe('HostClient registry-typed request', () => {
  it('pins the result type to the HOST_METHODS registry entry', async () => {
    const client = makeClient();
    // No caller-side generic: the registry-typed overload resolves
    // HostMethodResult<'host.hello'> from the method literal alone. (Under
    // the old single generic signature this resolved to Promise<unknown> and
    // the assertion below would not compile.)
    const hello = client.request('host.hello', { protocolVersion: 1, clientId: 'typed' });
    expectTypeOf(hello).resolves.toEqualTypeOf<HostHelloResult>();
    // The generic string overload stays available for dynamic call sites
    // (routing.ts, resync.ts) with caller-asserted results. Type-only probe:
    // the closure is never invoked, so no request is sent.
    const _dynamicOverload: (method: string) => Promise<Array<{ id: string }>> = (method) =>
      client.request<Array<{ id: string }>>(method);
    void _dynamicOverload;
    await hello; // settle against the real in-process server
    client.close();
  });
});
