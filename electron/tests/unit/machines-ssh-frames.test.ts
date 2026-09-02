/**
 * Review fix #18 — SSH transport structured frame seam.
 *
 * The framing decoder parses each NDJSON line into an object; before the fix
 * those objects were stringified back to a line for `onData` and re-parsed by
 * the HostClient — double serialization on the per-event streaming hot path.
 * The transport now implements the structured seam (writeFrame/onFrame) so
 * decoded frames flow straight into the client's handling.
 *
 * Real under test: spawnSshTransport's decoder → delivery path against a
 * fixture Node child standing in for the ssh bridge process (the same
 * fixtures/machines pattern the connection tests use), plus the HostClient
 * riding the structured seam end to end. The line path stays covered for its
 * one remaining consumer (the connection manager's handshake sniffer).
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSshTransport, type SshTransport } from '../../src/main/machines/ssh-transport';
import { createHostClient, type HostClient } from '../../src/main/host/client';
import { supportsStructuredFrames } from '../../src/main/host/transport';
import type { RemoteMachineRecord } from '../../src/shared/types/machine';

const STRUCTURED_FIXTURE = path.join(__dirname, '..', 'fixtures', 'machines', 'structured-bridge.cjs');
const ECHO_FIXTURE = path.join(__dirname, '..', 'fixtures', 'machines', 'echo-bridge.cjs');

const MACHINE: RemoteMachineRecord = {
  id: 'mach-frames',
  label: 'Frames Fixture',
  kind: 'ssh',
  host: 'frames.test',
  port: 22,
  user: '',
  agentCommand: 'orchid-agent',
  authMethod: 'key',
  created_at: '2026-08-24T00:00:00.000Z',
  updated_at: '2026-08-24T00:00:00.000Z',
};

const transports: SshTransport[] = [];
const clients: HostClient[] = [];

function bridgeTransport(fixturePath: string): SshTransport {
  const transport = spawnSshTransport(MACHINE, {
    spawnFn: (command, args, options) => spawn(command, args, options),
    commandFactory: () => [process.execPath, fixturePath],
  });
  transports.push(transport);
  return transport;
}

afterEach(() => {
  for (const client of clients.splice(0)) {
    try {
      client.close();
    } catch {
      // non-fatal
    }
  }
  for (const transport of transports.splice(0)) {
    try {
      transport.close();
    } catch {
      // non-fatal
    }
  }
});

describe('SSH transport structured frame seam (#18)', () => {
  it('implements the structured seam the host client looks for', () => {
    const transport = bridgeTransport(STRUCTURED_FIXTURE);
    expect(supportsStructuredFrames(transport)).toBe(true);
  });

  it('round-trips request → response → event through the seam with no double parse', async () => {
    const transport = bridgeTransport(STRUCTURED_FIXTURE);
    // A legacy line consumer (the connection manager's handshake sniffer)
    // stays registered: while the structured consumer owns the frames it must
    // receive nothing — proving the decoded objects were not re-encoded.
    const legacyLines: string[] = [];
    transport.onData((line) => legacyLines.push(line));

    const client = createHostClient(transport, { clientId: 'frames-1', label: 'frames' });
    clients.push(client);
    const events: Array<{ params: unknown; seq: number }> = [];
    client.subscribe('session:renamed', (params, seq) => events.push({ params, seq }));

    // Every inbound frame must be parsed exactly once (by the decoder). The
    // pre-fix path re-stringified each frame and parsed it again in the
    // client, which would double this count for the same three frames.
    const parseSpy = vi.spyOn(JSON, 'parse');
    let parseCount: number;
    try {
      const result = await client.request<{ emitted: boolean }>('test.emit', {});
      expect(result).toEqual({ emitted: true });
      await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 5000 });
      parseCount = parseSpy.mock.calls.length;
    } finally {
      parseSpy.mockRestore();
    }

    expect(events[0]?.params).toEqual({ id: 'sess-frames', name: 'Emitted' });
    expect(events[0]?.seq).toBe(1);
    expect(client.lastSeq()).toBe(1);
    // hello response + event + test.emit response — parsed once each.
    expect(parseCount).toBe(3);
    // The structured consumer owned every frame: no line was re-encoded.
    expect(legacyLines).toEqual([]);
  });

  it('delivers the decoded object itself through the seam (no re-encode identity break)', async () => {
    const transport = bridgeTransport(STRUCTURED_FIXTURE);
    const delivered: unknown[] = [];
    transport.onFrame((frame) => delivered.push(frame));
    transport.writeFrame({ id: 7, method: 'test.emit', params: {} });
    // The fixture pushes one event frame and then answers the request.
    await vi.waitFor(() => expect(delivered.length).toBe(2), { timeout: 5000 });
    // Every delivered value is the decoder's parsed object (a plain object,
    // never a string line): the event frame carries its fields structurally.
    const eventFrame = delivered.find(
      (frame) => typeof frame === 'object' && frame !== null && 'ev' in frame,
    ) as { ev?: unknown; params?: unknown; seq?: unknown };
    expect(eventFrame.ev).toBe('session:renamed');
    expect(eventFrame.params).toEqual({ id: 'sess-frames', name: 'Emitted' });
    expect(eventFrame.seq).toBe(1);
    expect(delivered.every((frame) => typeof frame !== 'string')).toBe(true);
  });

  it('keeps the line path for legacy consumers when no structured consumer is installed', async () => {
    const transport = bridgeTransport(ECHO_FIXTURE);
    const received: string[] = [];
    transport.onData((line) => received.push(line));
    transport.write(JSON.stringify({ probe: 1 }));
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
    expect(typeof received[0]).toBe('string');
    expect(JSON.parse(received[0] as string)).toEqual({ echoed: { probe: 1 } });
  });

  it('serializes writeFrame as exactly one newline-terminated line', async () => {
    const transport = bridgeTransport(STRUCTURED_FIXTURE);
    const received: string[] = [];
    transport.onData((line) => received.push(line));
    transport.writeFrame({ id: 1, method: 'probe.roundtrip' });
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
    // writeFrame went out as NDJSON: the fixture answered, and the single
    // decoded frame came back through the line path (no structured consumer).
    expect(JSON.parse(received[0] as string)).toEqual({
      id: 1,
      ok: true,
      result: { ack: true },
    });
  });
});
