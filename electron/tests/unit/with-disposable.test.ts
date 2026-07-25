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
    let resolveSuccessful!: () => void;
    let successfulCompleted = false;
    const successfulResult = withDisposableAsync(successful, async () => {
      await new Promise<void>((resolve) => {
        resolveSuccessful = resolve;
      });
      successfulCompleted = true;
      return 'result';
    });

    expect(successfulCompleted).toBe(false);
    expect(successful.dispose).not.toHaveBeenCalled();
    resolveSuccessful();

    await expect(successfulResult).resolves.toBe('result');
    expect(successfulCompleted).toBe(true);
    expect(successful.dispose).toHaveBeenCalledOnce();

    const failing = { dispose: vi.fn() };
    let rejectFailing!: (reason: Error) => void;
    let failingCompleted = false;
    const failingResult = withDisposableAsync(failing, async () => {
      try {
        await new Promise<void>((_resolve, reject) => {
          rejectFailing = reject;
        });
      } finally {
        failingCompleted = true;
      }
    });

    expect(failingCompleted).toBe(false);
    expect(failing.dispose).not.toHaveBeenCalled();
    rejectFailing(new Error('async failure'));

    await expect(failingResult).rejects.toThrow('async failure');
    expect(failingCompleted).toBe(true);
    expect(failing.dispose).toHaveBeenCalledOnce();
  });
});
