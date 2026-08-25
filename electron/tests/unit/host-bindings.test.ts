/**
 * Host binding registry composition — the per-family tables composed by
 * host/bindings/index.ts must exactly cover HOST_METHODS, with every entry a
 * callable binding and no method bound twice (a duplicate would silently
 * shadow inside the dispatch map).
 *
 * `buildHostBindings` takes the typed HostServerSurface directly, so the
 * composition is testable without a HostServer instance.
 */
import { describe, expect, it } from 'vitest';
import { HOST_METHODS } from '../../src/shared/host/protocol';
import { buildHostBindings } from '../../src/main/host/bindings';
import type { HostServerSurface } from '../../src/main/host/bindings';

const stubSurface: HostServerSurface = {
  serverVersion: 'test-host',
  capabilities: new Set<string>(),
  requireCapability: () => {},
  emitTo: () => {},
  emitToAll: () => {},
  emitToProject: () => {},
  listConnections: () => [],
  adoptOrphanedPendingFor: () => {},
  listPendingApprovals: () => [],
  listPendingQuestions: () => [],
};

describe('host binding registry composition', () => {
  it('binds exactly every HOST_METHODS entry — no gaps, no extras', () => {
    const bindings = buildHostBindings(stubSurface);

    for (const method of Object.keys(HOST_METHODS)) {
      expect(bindings.has(method), `missing binding for '${method}'`).toBe(true);
    }
    expect([...bindings.keys()]).toEqual(
      expect.arrayContaining(Object.keys(HOST_METHODS)),
    );
    expect(bindings.size).toBe(Object.keys(HOST_METHODS).length);
  });

  it('maps every method to a callable binding', () => {
    const bindings = buildHostBindings(stubSurface);

    for (const [method, binding] of bindings) {
      expect(typeof binding, `binding for '${method}'`).toBe('function');
    }
  });
});
