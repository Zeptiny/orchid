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
import {
  HOST_CAPABILITIES,
  HOST_ERROR_CODES,
  HostProtocolError,
} from '../../src/shared/host/protocol';
import { DAEMON_CAPABILITIES } from '../../src/main/host/server';
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

describe('provider credential-write capability gate', () => {
  const ctx = { clientId: 'client-1' } as const;

  function surfaceWith(capabilities: readonly string[]): HostServerSurface {
    return { ...stubSurface, capabilities: new Set<string>(capabilities) };
  }

  async function gateOutcome(
    method: string,
    params: unknown,
    capabilities: readonly string[],
  ): Promise<HostProtocolError | null> {
    const bindings = buildHostBindings(surfaceWith(capabilities));
    try {
      await bindings.get(method)!(ctx as never, params as never);
      return null;
    } catch (error) {
      if (error instanceof HostProtocolError) return error;
      // Non-gate failures (uninitialized services) mean the gate passed.
      return null;
    }
  }

  it('a daemon (no vault writes) rejects submit_api_key with the typed error', async () => {
    const error = await gateOutcome(
      'providers.submit_api_key',
      { connectionId: '00000000-0000-4000-8000-000000000041', apiKey: 'sk-x' },
      DAEMON_CAPABILITIES,
    );
    expect(error?.code).toBe(HOST_ERROR_CODES.UNSUPPORTED_ON_HOST);
    expect(error?.message).toMatch(/environment-variable/i);
  });

  it('a daemon rejects an api-key create intent before it can become a dead-end draft', async () => {
    const error = await gateOutcome(
      'providers.create',
      {
        providerId: 'openai',
        name: 'Would strand on a daemon',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
        modelIds: ['gpt-5/test'],
      },
      DAEMON_CAPABILITIES,
    );
    expect(error?.code).toBe(HOST_ERROR_CODES.UNSUPPORTED_ON_HOST);
  });

  it('a daemon rejects an update that would switch auth to a stored API key', async () => {
    const error = await gateOutcome(
      'providers.update',
      { connectionId: '00000000-0000-4000-8000-000000000042', authMethod: 'api-key' },
      DAEMON_CAPABILITIES,
    );
    expect(error?.code).toBe(HOST_ERROR_CODES.UNSUPPORTED_ON_HOST);
  });

  it('environment/none create and plain metadata updates pass the daemon gate', async () => {
    const environmentCreate = await gateOutcome(
      'providers.create',
      {
        providerId: 'openai',
        name: 'Env-auth connection',
        protocol: 'openai-compatible',
        authMethod: 'environment',
        modelIds: ['gpt-5/test'],
        environmentVariable: 'OPENAI_API_KEY',
      },
      DAEMON_CAPABILITIES,
    );
    expect(environmentCreate).toBeNull();

    const metadataUpdate = await gateOutcome(
      'providers.update',
      { connectionId: '00000000-0000-4000-8000-000000000043', name: 'Renamed' },
      DAEMON_CAPABILITIES,
    );
    expect(metadataUpdate).toBeNull();
  });

  it('a host declaring vault writes passes every credential gate', async () => {
    const withVault = [...DAEMON_CAPABILITIES, HOST_CAPABILITIES.PROVIDERS_VAULT_WRITES];
    for (const [method, params] of [
      ['providers.create', {
        providerId: 'openai',
        name: 'API-key connection',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
        modelIds: ['gpt-5/test'],
      }],
      ['providers.submit_api_key', {
        connectionId: '00000000-0000-4000-8000-000000000044',
        apiKey: 'sk-x',
      }],
    ] as const) {
      const error = await gateOutcome(method, params, withVault);
      expect(error, `${method} must not hit the capability gate`).toBeNull();
    }
  });
});
