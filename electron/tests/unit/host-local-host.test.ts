/**
 * Embedded local host — the lazy provider-runtime ensure's retry semantics.
 *
 * Real under test: ensureProviderRuntime's memoization. A failed composition
 * is swallowed non-fatally, but it must not poison the memo: the next call has
 * to re-attempt (degraded-startup lazy retry) instead of replaying a
 * resolved-but-failed promise forever. The composition itself is swapped for a
 * counting stub through the module's test seam; no HostServer is constructed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _ensureProviderRuntimeForTests,
  _setProviderRuntimeComposeForTests,
} from '../../src/main/host/local-host';

afterEach(() => {
  _setProviderRuntimeComposeForTests(null);
});

describe('ensureProviderRuntime memo (embedded local host)', () => {
  it('re-attempts after a failed composition instead of caching the failure', async () => {
    let attempts = 0;
    _setProviderRuntimeComposeForTests(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('catalog trust failure');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // First attempt fails; the catch swallows (non-fatal) and resets the memo.
      await _ensureProviderRuntimeForTests();
      expect(attempts).toBe(1);

      // The retry must run the composition again and now succeed.
      await _ensureProviderRuntimeForTests();
      expect(attempts).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a single shared promise while a composition attempt is in flight', async () => {
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    _setProviderRuntimeComposeForTests(async () => {
      attempts += 1;
      await gate;
    });
    const first = _ensureProviderRuntimeForTests();
    const second = _ensureProviderRuntimeForTests();
    release();
    await Promise.all([first, second]);
    expect(attempts).toBe(1);
  });
});
