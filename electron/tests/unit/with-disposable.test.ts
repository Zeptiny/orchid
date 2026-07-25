import { describe, expect, it, vi } from 'vitest';
import {
  withDisposable,
  withDisposableAsync,
} from '../../src/main/utils/with-disposable';

describe('withDisposable', () => {
  it('disposes after synchronous success and failure', () => {
    const successful = { dispose: vi.fn() };
    expect(withDisposable(successful, () => 'result')).toBe('result');
    expect(successful.dispose).toHaveBeenCalledOnce();

    const failing = { dispose: vi.fn() };
    expect(() => withDisposable(failing, () => {
      throw new Error('sync failure');
    })).toThrow('sync failure');
    expect(failing.dispose).toHaveBeenCalledOnce();
  });

  it('waits for asynchronous success and failure before disposing', async () => {
    const successful = { dispose: vi.fn() };
    await expect(withDisposableAsync(successful, async () => 'result'))
      .resolves.toBe('result');
    expect(successful.dispose).toHaveBeenCalledOnce();

    const failing = { dispose: vi.fn() };
    await expect(withDisposableAsync(failing, async () => {
      throw new Error('async failure');
    })).rejects.toThrow('async failure');
    expect(failing.dispose).toHaveBeenCalledOnce();
  });
});
