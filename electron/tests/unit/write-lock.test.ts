/**
 * Unit tests for per-path write serialization and scoped clears.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  withSerializedWrite,
  _clearSerializedWriteChains,
} from '../../src/main/utils/write-lock';

afterEach(() => {
  _clearSerializedWriteChains();
});

describe('withSerializedWrite', () => {
  it('serializes concurrent tasks on the same path', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withSerializedWrite('/tmp/a.json', async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
      return 1;
    });

    let secondStarted = false;
    const second = withSerializedWrite('/tmp/a.json', async () => {
      secondStarted = true;
      order.push('second');
      return 2;
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('allows concurrent tasks on different paths', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    let resolveBStarted!: () => void;
    const bStarted = new Promise<void>((resolve) => {
      resolveBStarted = resolve;
    });

    const a = withSerializedWrite('/tmp/a.json', async () => {
      await gateA;
      return 'a';
    });

    const b = withSerializedWrite('/tmp/b.json', async () => {
      resolveBStarted();
      return 'b';
    });

    // B must start while A is still gated (different paths are independent).
    await expect(bStarted).resolves.toBeUndefined();
    releaseA();
    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b']);
  });

  it('continues the chain after a rejected task', async () => {
    await expect(
      withSerializedWrite('/tmp/a.json', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(
      withSerializedWrite('/tmp/a.json', async () => 'ok'),
    ).resolves.toBe('ok');
  });
});

describe('_clearSerializedWriteChains', () => {
  it('path-scoped clear does not drop unrelated in-flight chains', async () => {
    let releaseKeep!: () => void;
    const keepGate = new Promise<void>((resolve) => {
      releaseKeep = resolve;
    });

    const keep = withSerializedWrite('/tmp/keep.json', async () => {
      await keepGate;
      return 'kept';
    });

    const drop = withSerializedWrite('/tmp/drop.json', async () => 'dropped');
    await drop;

    _clearSerializedWriteChains('/tmp/drop.json');

    let interloperStarted = false;
    const interloper = withSerializedWrite('/tmp/keep.json', async () => {
      interloperStarted = true;
      return 'interloper';
    });

    await Promise.resolve();
    expect(interloperStarted).toBe(false);

    releaseKeep();
    await expect(Promise.all([keep, interloper])).resolves.toEqual([
      'kept',
      'interloper',
    ]);
  });

  it('array clear drops only listed paths', async () => {
    let releaseKeep!: () => void;
    const keepGate = new Promise<void>((resolve) => {
      releaseKeep = resolve;
    });

    const keep = withSerializedWrite('/tmp/keep.json', async () => {
      await keepGate;
      return 'kept';
    });

    await withSerializedWrite('/tmp/a.json', async () => 'a');
    await withSerializedWrite('/tmp/b.json', async () => 'b');

    _clearSerializedWriteChains(['/tmp/a.json', '/tmp/b.json']);

    let interloperStarted = false;
    const interloper = withSerializedWrite('/tmp/keep.json', async () => {
      interloperStarted = true;
      return 'interloper';
    });

    await Promise.resolve();
    expect(interloperStarted).toBe(false);
    releaseKeep();
    await expect(Promise.all([keep, interloper])).resolves.toEqual([
      'kept',
      'interloper',
    ]);
  });

  it('full clear (no args) drops every path', async () => {
    let releaseKeep!: () => void;
    const keepGate = new Promise<void>((resolve) => {
      releaseKeep = resolve;
    });

    const keep = withSerializedWrite('/tmp/keep.json', async () => {
      await keepGate;
      return 'kept';
    });

    _clearSerializedWriteChains();

    let resolveInterloperStarted!: () => void;
    const interloperStarted = new Promise<void>((resolve) => {
      resolveInterloperStarted = resolve;
    });

    const interloper = withSerializedWrite('/tmp/keep.json', async () => {
      resolveInterloperStarted();
      return 'interloper';
    });

    // After a full clear the interloper must not wait on the prior chain.
    await expect(interloperStarted).resolves.toBeUndefined();
    releaseKeep();
    await expect(Promise.all([keep, interloper])).resolves.toEqual([
      'kept',
      'interloper',
    ]);
  });
});
