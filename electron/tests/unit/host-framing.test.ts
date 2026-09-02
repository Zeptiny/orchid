/**
 * Host protocol framing tests (plan U2): newline-delimited JSON round-trips,
 * chunk-split streams, byte-level size caps, invalid-JSON rejection with a
 * bounded excerpt, decoder reuse across chunks, and a throughput smoke test
 * that rules out per-character pathologies.
 */
import { describe, expect, it } from 'vitest';
import {
  FrameDecodeError,
  FrameError,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  createFrameDecoder,
  encodeMessage,
} from '../../src/shared/host/framing';

describe('encodeMessage', () => {
  it('appends exactly one trailing newline to the JSON document', () => {
    const frame = encodeMessage({ id: 1, method: 'host.hello', params: {} });
    expect(frame).toBe('{"id":1,"method":"host.hello","params":{}}\n');
    expect(frame.endsWith('\n')).toBe(true);
    expect(frame.indexOf('\n')).toBe(frame.length - 1);
  });
});

describe('createFrameDecoder', () => {
  it('round-trips a single-line frame', () => {
    const message = { id: 1, method: 'host.hello', params: { protocolVersion: 1 } };
    const decoder = createFrameDecoder();
    expect(decoder.push(encodeMessage(message))).toEqual([message]);
  });

  it('decodes multiple frames delivered in one chunk', () => {
    const first = { ev: 'chat:chunk', params: { data: 'he' }, seq: 1 };
    const second = { ev: 'chat:chunk', params: { data: 'llo' }, seq: 2 };
    const third = { id: 'req-1', method: 'chat.send', params: { message: 'hi' } };
    const decoder = createFrameDecoder();
    const frames = decoder.push(
      encodeMessage(first) + encodeMessage(second) + encodeMessage(third),
    );
    expect(frames).toEqual([first, second, third]);
  });

  it('reassembles frames split at arbitrary chunk boundaries', () => {
    const first = { id: 1, method: 'chat.send', params: { message: 'hello world' } };
    const second = { ev: 'session:renamed', params: { id: 's', name: 'n' }, seq: 9 };
    const stream = encodeMessage(first) + encodeMessage(second);
    const decoder = createFrameDecoder();
    const frames: unknown[] = [];
    for (const character of stream) {
      frames.push(...decoder.push(character));
    }
    decoder.finish();
    expect(frames).toEqual([first, second]);
  });

  it('splits frames on every chunk boundary, not per message', () => {
    const decoder = createFrameDecoder();
    expect(decoder.push('{"id":1,')).toEqual([]);
    expect(decoder.push('"metho')).toEqual([]);
    const frames = decoder.push('d":"host.hello"}\n');
    expect(frames).toEqual([{ id: 1, method: 'host.hello' }]);
    decoder.finish();
  });

  it('rejects an oversized frame with FrameTooLargeError', () => {
    const decoder = createFrameDecoder({ maxFrameBytes: 32 });
    expect(decoder.push('{"a":1}\n')).toEqual([{ a: 1 }]);
    const oversized = `{"pad":"${'x'.repeat(64)}"}`;
    expect(() => decoder.push(encodeMessage(oversized))).toThrow(FrameTooLargeError);
    try {
      decoder.push(encodeMessage(oversized));
    } catch (error) {
      const tooLarge = error as FrameTooLargeError;
      expect(tooLarge).toBeInstanceOf(FrameError);
      expect(tooLarge.maxFrameBytes).toBe(32);
      expect(tooLarge.frameBytes).toBeGreaterThan(32);
    }
  });

  it('rejects an unterminated line that grows past the cap', () => {
    const decoder = createFrameDecoder({ maxFrameBytes: 32 });
    expect(() => decoder.push(`${'x'.repeat(33)}`)).toThrow(FrameTooLargeError);
  });

  it('defaults to the documented 32 MiB cap', () => {
    expect(MAX_FRAME_BYTES).toBe(32 * 1024 * 1024);
    const decoder = createFrameDecoder();
    expect(() => decoder.push(`${'y'.repeat(MAX_FRAME_BYTES + 1)}`)).toThrow(FrameTooLargeError);
  });

  it('rejects invalid JSON with a bounded excerpt of the raw line', () => {
    const decoder = createFrameDecoder();
    let caught: unknown;
    try {
      decoder.push('{"broken json\n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FrameDecodeError);
    const decodeError = caught as FrameDecodeError;
    expect(decodeError).toBeInstanceOf(FrameError);
    expect(decodeError.excerpt.startsWith('{"broken json')).toBe(true);
    expect(decodeError.excerpt.length).toBeLessThanOrEqual(200);
  });

  it('caps the excerpt at 200 characters for long garbage lines', () => {
    const decoder = createFrameDecoder();
    const longLine = `not-json-${'z'.repeat(500)}`;
    try {
      decoder.push(`${longLine}\n`);
      expect.unreachable('invalid JSON must throw');
    } catch (error) {
      expect((error as FrameDecodeError).excerpt.length).toBe(200);
    }
  });

  it('tolerates blank lines between frames', () => {
    const decoder = createFrameDecoder();
    const message = { ok: true, id: 2, result: null };
    expect(decoder.push(`\n\n${encodeMessage(message)}\n`)).toEqual([message]);
    decoder.finish();
  });

  it('is reusable across chunks for the whole connection lifetime', () => {
    const decoder = createFrameDecoder();
    const secondFrame = encodeMessage({ seq: 2, ev: 'chat:chunk' });
    const firstWave = decoder.push(`${encodeMessage({ seq: 1 })}${secondFrame.slice(0, 10)}`);
    expect(firstWave).toEqual([{ seq: 1 }]);
    const secondWave = decoder.push(
      `${secondFrame.slice(10)}${encodeMessage({ seq: 3 })}`,
    );
    expect(secondWave).toEqual([{ seq: 2, ev: 'chat:chunk' }, { seq: 3 }]);
    decoder.finish();
  });

  it('finish() rejects a dangling partial frame but accepts a drained one', () => {
    const drained = createFrameDecoder();
    drained.push(encodeMessage({ done: true }));
    expect(() => drained.finish()).not.toThrow();

    const dangling = createFrameDecoder();
    dangling.push('{"trunc');
    expect(() => dangling.finish()).toThrow(FrameDecodeError);
  });

  it('decodes 10k frames fast enough to rule out per-character pathologies', () => {
    const count = 10_000;
    const stream: string[] = [];
    for (let index = 0; index < count; index += 1) {
      stream.push(encodeMessage({ ev: 'chat:chunk', seq: index, params: { data: 'x' } }));
    }
    const wire = stream.join('');
    const decoder = createFrameDecoder();
    const decoded: unknown[] = [];
    const startedAt = performance.now();
    for (let offset = 0; offset < wire.length; offset += 64) {
      decoded.push(...decoder.push(wire.slice(offset, offset + 64)));
    }
    const elapsedMs = performance.now() - startedAt;
    decoder.finish();
    expect(decoded).toHaveLength(count);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
