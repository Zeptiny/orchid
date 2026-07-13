/**
 * U9 deterministic public-contract coverage.
 *
 * This suite deliberately uses only an in-process IPC bridge and a local
 * response fixture. It exercises the same persistent connection, vault, resolver,
 * status, and ledger boundaries used by the Electron main process without
 * contacting a real provider or retaining a reusable credential in a result.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IPC_CHANNELS,
  type ProviderModelOption,
  type ProviderMutationResult,
  type ProviderOverview,
} from '../../src/shared/types/ipc';
import type { ProviderDefinition } from '../../src/shared/types/provider';

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'fixture-secure-store',
      encryptString: (value: string) => Buffer.from(`sealed:${value}`, 'utf8'),
      decryptString: (value: Buffer) => value.toString('utf8').replace(/^sealed:/, ''),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: electron.ipcMain,
  safeStorage: electron.safeStorage,
}));

// The provider IPC test seam below supplies every runtime service. Avoiding
// Electron startup keeps this deterministic while preserving the public IPC
// handler contract.
vi.mock('../../src/main/index', () => ({
  getProviderCatalogStore: vi.fn(),
  getProviderConnectionStore: vi.fn(),
  getProviderCredentialVault: vi.fn(),
  getProviderStatusService: vi.fn(),
}));

import * as providerIpc from '../../src/main/ipc/providers';
import { ProviderRuntime } from '../../src/main/providers';
import { ProviderAccountingStore } from '../../src/main/providers/accounting/store';
import {
  ConnectionStore,
  _clearConnectionStoreWriteChains,
} from '../../src/main/providers/connection-store';
import {
  CredentialVault,
  _clearCredentialVaultWriteChains,
} from '../../src/main/providers/credentials/vault';
import { ProviderDriverRegistry } from '../../src/main/providers/drivers/registry';
import { fetchLilacStatus } from '../../src/main/providers/drivers/lilac';
import { resolveModelSelection } from '../../src/main/providers/resolver';
import { ProviderStatusCache } from '../../src/main/providers/status/cache';
import {
  ProviderStatusService,
  type ProviderStatusSource,
} from '../../src/main/providers/status/service';

const FIXTURE_NOW = new Date('2026-07-13T12:00:00.000Z');
const LILAC_MODEL_ID = 'moonshotai/kimi-k2.6';

const LILAC_DEFINITION: ProviderDefinition = {
  id: 'lilac',
  displayName: 'Lilac',
  supportedAuthMethods: ['api-key', 'environment'],
  supportedProtocols: ['openai-compatible'],
  allowsCustomModels: false,
  lifecycle: 'active',
  models: [
    {
      id: LILAC_MODEL_ID,
      displayName: 'Kimi K2.6',
      protocol: 'openai-compatible',
      lifecycle: 'active',
      capabilities: {
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        tools: true,
        reasoning: true,
      },
      limits: { contextTokens: 262_144, outputTokens: 32_768 },
    },
  ],
};

let tempDirectories: string[] = [];
let ledgers: ProviderAccountingStore[] = [];

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-provider-e2e-'));
  tempDirectories.push(directory);
  return directory;
}

function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`Missing provider IPC handler '${channel}'`);
  return Promise.resolve(handler({ sender: null }, payload) as T);
}

function createServices(root: string) {
  let sequence = 1;
  const connections = new ConnectionStore({
    providersPath: path.join(root, 'providers.json'),
    idFactory: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
  });
  const vault = new CredentialVault({
    credentialsPath: path.join(root, 'credentials.json'),
    safeStorage: electron.safeStorage,
    now: () => FIXTURE_NOW,
  });
  const status = new ProviderStatusService({
    cache: new ProviderStatusCache({ filePath: path.join(root, 'provider-status.json') }),
    now: () => FIXTURE_NOW,
  });
  const createLanguageModel = vi.fn(async () => ({ kind: 'fixture-lilac-model' }) as never);
  const registry = new ProviderDriverRegistry([
    {
      id: 'lilac',
      supportedAuthMethods: ['api-key', 'environment'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: 'https://api.getlilac.com/v1',
      createLanguageModel,
    },
  ]);
  return {
    connections,
    vault,
    status,
    registry,
    createLanguageModel,
    services: {
      catalog: { getProviderDefinitions: () => [LILAC_DEFINITION] },
      connections,
      vault,
      status,
      registry,
    },
  };
}

async function createReadyConnection(name: string): Promise<{
  readonly connectionId: string;
  readonly response: ProviderMutationResult;
}> {
  const created = await invoke<ProviderMutationResult>(IPC_CHANNELS.PROVIDERS_CREATE, {
    providerId: 'lilac',
    name,
    protocol: 'openai-compatible',
    authMethod: 'api-key',
    modelIds: [LILAC_MODEL_ID],
  });
  const response = await invoke<ProviderMutationResult>(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY, {
    connectionId: created.connection.id,
    // Test-only value: it is asserted absent from disk and public responses.
    apiKey: `fixture-api-key-${name.toLowerCase().replace(/\s+/g, '-')}`,
  });
  return { connectionId: created.connection.id, response };
}

function createLilacFixtureFetch(): {
  readonly fetch: typeof globalThis.fetch;
  readonly authorizationHeaders: string[];
} {
  const authorizationHeaders: string[] = [];
  return {
    authorizationHeaders,
    fetch: async (_input, init) => {
      const authorization = new Headers(init?.headers ?? {}).get('authorization');
      if (typeof authorization === 'string') authorizationHeaders.push(authorization);
      return new Response(
        JSON.stringify({
          window: '5m',
          window_secs: 300,
          updated_at: FIXTURE_NOW.toISOString(),
          current_subscription_supply_updated_at: FIXTURE_NOW.toISOString(),
          models: [
            {
              id: LILAC_MODEL_ID,
              name: 'Kimi K2.6',
              tps: 84.2,
              ttfb_seconds: 0.19,
              uptime_pct: 99.98,
              current_subscription_supply_state: 'surplus',
              current_subscription_discount_percent: 35,
              current_subscription_credit_multiplier: 0.65,
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  };
}

afterEach(() => {
  providerIpc.unregisterProviderIPC();
  providerIpc._setProviderIPCServicesForTests(null);
  electron.handlers.clear();
  for (const ledger of ledgers) ledger.close();
  ledgers = [];
  for (const directory of tempDirectories) fs.rmSync(directory, { recursive: true, force: true });
  tempDirectories = [];
  _clearConnectionStoreWriteChains();
  _clearCredentialVaultWriteChains();
  vi.restoreAllMocks();
});

describe('provider end-to-end public contracts', () => {
  it('moves a local-only persisted home through redacted IPC setup, restart, typed execution, and immutable attribution', async () => {
    const root = makeTempDirectory();
    const fixture = createServices(root);
    providerIpc._setProviderIPCServicesForTests(fixture.services);
    providerIpc.registerProviderIPC();

    const freshOverview = await invoke<ProviderOverview>(IPC_CHANNELS.PROVIDERS_LIST);
    expect(freshOverview.connections).toEqual([]);
    expect(resolveModelSelection(null, [], [LILAC_DEFINITION])).toEqual({
      kind: 'provider-required',
      reason: 'no-usable-connection',
    });

    const work = await createReadyConnection('Work Lilac');
    const personal = await createReadyConnection('Personal Lilac');
    expect(work.response.connection.health).toBe('ready');
    expect(personal.response.connection.health).toBe('ready');

    const modelOptions = await invoke<readonly ProviderModelOption[]>(
      IPC_CHANNELS.PROVIDERS_MODEL_LIST,
    );
    const workOption = modelOptions.find(
      (option) => option.selection.connectionId === work.connectionId,
    );
    const personalOption = modelOptions.find(
      (option) => option.selection.connectionId === personal.connectionId,
    );
    expect(workOption).toMatchObject({
      selection: { connectionId: work.connectionId, modelId: LILAC_MODEL_ID },
      connectionName: 'Work Lilac',
      available: true,
    });
    expect(personalOption).toMatchObject({
      selection: { connectionId: personal.connectionId, modelId: LILAC_MODEL_ID },
      connectionName: 'Personal Lilac',
      available: true,
    });

    const publicOverview = await invoke<ProviderOverview>(IPC_CHANNELS.PROVIDERS_LIST);
    const publicJson = JSON.stringify(publicOverview);
    const storedWork = await fixture.connections.get(work.connectionId);
    if (!storedWork || storedWork.credential.kind !== 'stored')
      throw new Error('Expected a stored work credential');
    expect(publicJson).not.toContain('fixture-api-key-work-lilac');
    expect(publicJson).not.toContain('fixture-api-key-personal-lilac');
    expect(publicJson).not.toContain(storedWork.credential.handle);

    const providerFile = fs.readFileSync(path.join(root, 'providers.json'), 'utf8');
    const credentialsFile = fs.readFileSync(path.join(root, 'credentials.json'), 'utf8');
    expect(providerFile).not.toContain('fixture-api-key-work-lilac');
    expect(providerFile).not.toContain('fixture-api-key-personal-lilac');
    expect(credentialsFile).not.toContain('fixture-api-key-work-lilac');
    expect(credentialsFile).not.toContain('fixture-api-key-personal-lilac');

    const restartedConnections = new ConnectionStore({
      providersPath: path.join(root, 'providers.json'),
    });
    const reloadedConnections = await restartedConnections.list();
    const resolution = resolveModelSelection(
      { connectionId: work.connectionId, modelId: LILAC_MODEL_ID },
      reloadedConnections,
      [LILAC_DEFINITION],
    );
    expect(resolution).toMatchObject({
      kind: 'resolved',
      selection: { connectionId: work.connectionId, modelId: LILAC_MODEL_ID },
      connection: { name: 'Work Lilac' },
    });

    const runtime = new ProviderRuntime({
      catalog: { getProviderDefinitions: () => [LILAC_DEFINITION] },
      connections: restartedConnections,
      vault: fixture.vault,
      registry: fixture.registry,
    });
    const execution = await runtime.resolveExecution({
      connectionId: work.connectionId,
      modelId: LILAC_MODEL_ID,
    });
    expect(execution.snapshot).toMatchObject({
      providerId: 'lilac',
      connectionId: work.connectionId,
      connectionName: 'Work Lilac',
      modelId: LILAC_MODEL_ID,
      protocol: 'openai-compatible',
    });
    expect(fixture.createLanguageModel).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({ id: work.connectionId }),
        model: expect.objectContaining({ id: LILAC_MODEL_ID, source: 'catalog' }),
      }),
    );

    const ledger = new ProviderAccountingStore({
      dbPath: path.join(root, 'accounting.db'),
      now: () => FIXTURE_NOW,
    });
    ledgers.push(ledger);
    const attemptId = '00000000-0000-4000-8000-000000000099';
    ledger.insertPending({
      attemptId,
      sessionId: 'provider-e2e-session',
      chainId: 'provider-e2e-chain',
      turnId: 'provider-e2e-turn',
      sdkCallId: null,
      snapshot: execution.snapshot,
    });
    expect(
      ledger.finalize(attemptId, {
        outcome: 'succeeded',
        usage: { inputTokens: 120, outputTokens: 30 },
        providerEvidence: { responseId: 'fixture-response' },
        cost: {
          state: 'reported',
          source: 'provider-reported',
          currency: 'USD',
          amount: '0.0012',
        },
      }),
    ).toBe(true);
    ledger.close();

    const restartedLedger = new ProviderAccountingStore({
      dbPath: path.join(root, 'accounting.db'),
      now: () => FIXTURE_NOW,
    });
    ledgers.push(restartedLedger);
    expect(restartedLedger.getAttempt(attemptId)).toMatchObject({
      attemptId,
      outcome: 'succeeded',
      snapshot: { connectionId: work.connectionId, modelId: LILAC_MODEL_ID },
      costState: 'reported',
      costAmount: '0.0012',
    });
    expect(restartedLedger.getSessionTotals('provider-e2e-session')).toEqual([
      {
        currency: 'USD',
        amount: '0.0012',
        recordCount: 1,
        unknownCount: 0,
      },
    ]);
  });

  it('passes Lilac supply-discount data through a local fixture status contract without affecting typed send eligibility', async () => {
    const root = makeTempDirectory();
    const fixture = createServices(root);
    providerIpc._setProviderIPCServicesForTests(fixture.services);
    providerIpc.registerProviderIPC();
    const ready = await createReadyConnection('Status Lilac');
    const transport = createLilacFixtureFetch();
    const source: ProviderStatusSource = {
      providerId: 'lilac',
      ttlMs: 5 * 60_000,
      minimumManualRefreshMs: 30_000,
      fetchStatus: () => fetchLilacStatus({ fetch: transport.fetch, now: () => FIXTURE_NOW }),
    };
    const refreshed = await fixture.status.refresh(source, { manual: true });
    expect(refreshed).toMatchObject({
      source: 'network',
      observation: {
        providerId: 'lilac',
        stale: false,
        data: {
          models: [
            expect.objectContaining({
              modelId: LILAC_MODEL_ID,
              subscription: {
                availability: 'available',
                supplyState: 'surplus',
                discountPercent: 35,
                creditMultiplier: 0.65,
              },
            }),
          ],
        },
      },
    });
    expect(transport.authorizationHeaders).toEqual([]);

    const overview = await invoke<ProviderOverview>(IPC_CHANNELS.PROVIDERS_LIST);
    expect(overview.statuses).toEqual([
      expect.objectContaining({
        providerId: 'lilac',
        stale: false,
        data: expect.objectContaining({
          models: [
            expect.objectContaining({
              subscription: expect.objectContaining({
                discountPercent: 35,
                creditMultiplier: 0.65,
              }),
            }),
          ],
        }),
      }),
    ]);
    const options = await invoke<readonly ProviderModelOption[]>(
      IPC_CHANNELS.PROVIDERS_MODEL_LIST,
      {
        connectionId: ready.connectionId,
      },
    );
    expect(options).toEqual([
      expect.objectContaining({
        selection: { connectionId: ready.connectionId, modelId: LILAC_MODEL_ID },
        available: true,
      }),
    ]);
  });
});
