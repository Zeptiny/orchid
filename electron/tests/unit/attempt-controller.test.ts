import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  combineAbortSignals,
  StreamAttemptController,
} from '../../src/main/llm/stream/attempt-controller';

describe('StreamAttemptController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('idle-aborts after an armed watchdog expires', () => {
    vi.useFakeTimers();
    const attempt = new StreamAttemptController({ idleTimeoutMs: 50 });

    attempt.armIdleTimer();
    vi.advanceTimersByTime(50);

    expect(attempt.didIdleTimeout).toBe(true);
    expect(attempt.signal.aborted).toBe(true);
  });

  it('resets the idle watchdog when it is re-armed', () => {
    vi.useFakeTimers();
    const attempt = new StreamAttemptController({ idleTimeoutMs: 50 });

    attempt.armIdleTimer();
    vi.advanceTimersByTime(40);
    attempt.armIdleTimer();
    vi.advanceTimersByTime(40);

    expect(attempt.signal.aborted).toBe(false);
    vi.advanceTimersByTime(10);
    expect(attempt.signal.aborted).toBe(true);
  });

  it('pauses for one tool and resumes when it settles', () => {
    vi.useFakeTimers();
    const attempt = new StreamAttemptController({ idleTimeoutMs: 50 });

    attempt.armIdleTimer();
    attempt.pauseIdleForTool();
    vi.advanceTimersByTime(100);
    expect(attempt.signal.aborted).toBe(false);

    attempt.resumeIdleAfterTool();
    vi.advanceTimersByTime(50);
    expect(attempt.signal.aborted).toBe(true);
  });

  it('waits for every overlapping tool before resuming idle timing', () => {
    vi.useFakeTimers();
    const attempt = new StreamAttemptController({ idleTimeoutMs: 50 });

    attempt.pauseIdleForTool();
    attempt.pauseIdleForTool();
    attempt.resumeIdleAfterTool();
    vi.advanceTimersByTime(100);
    expect(attempt.signal.aborted).toBe(false);

    attempt.resumeIdleAfterTool();
    vi.advanceTimersByTime(50);
    expect(attempt.signal.aborted).toBe(true);
  });

  it('propagates user cancellation without classifying it as idle', () => {
    const user = new AbortController();
    const attempt = new StreamAttemptController({
      userAbortSignal: user.signal,
      idleTimeoutMs: 50,
    });

    user.abort();

    expect(attempt.signal.aborted).toBe(true);
    expect(attempt.didUserAbort).toBe(true);
    expect(attempt.didIdleTimeout).toBe(false);
  });

  it('disposal clears a pending idle watchdog', () => {
    vi.useFakeTimers();
    const attempt = new StreamAttemptController({ idleTimeoutMs: 50 });

    attempt.armIdleTimer();
    attempt.dispose();
    vi.advanceTimersByTime(50);

    expect(attempt.didIdleTimeout).toBe(false);
    expect(attempt.signal.aborted).toBe(false);
  });

  it('retries only idle failures before output, user cancellation, and the final attempt', () => {
    vi.useFakeTimers();
    const retryable = new StreamAttemptController({ idleTimeoutMs: 50 });
    retryable.armIdleTimer();
    vi.advanceTimersByTime(50);
    expect(retryable.canRetryIdle(0, 2)).toBe(true);

    const delivered = new StreamAttemptController({ idleTimeoutMs: 50 });
    delivered.armIdleTimer();
    delivered.markDeliveredOutput();
    vi.advanceTimersByTime(50);
    expect(delivered.canRetryIdle(0, 2)).toBe(false);

    const user = new AbortController();
    const cancelled = new StreamAttemptController({
      userAbortSignal: user.signal,
      idleTimeoutMs: 50,
    });
    cancelled.armIdleTimer();
    vi.advanceTimersByTime(50);
    user.abort();
    expect(cancelled.canRetryIdle(0, 2)).toBe(false);

    expect(retryable.canRetryIdle(1, 2)).toBe(false);
    expect(new StreamAttemptController({ idleTimeoutMs: 50 }).canRetryIdle(0, 2)).toBe(false);
  });
});

describe('combineAbortSignals', () => {
  it('aborts when either signal aborts and dispose is safe', () => {
    const user = new AbortController();
    const idle = new AbortController();
    const { signal, dispose } = combineAbortSignals(user.signal, idle.signal);

    expect(signal.aborted).toBe(false);
    idle.abort();
    expect(signal.aborted).toBe(true);
    dispose();
  });
});
