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
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IPC_CHANNELS,
  type ProviderModelOption,
  type ProviderMutationResult,
  type ProviderOverview,
} from '../../src/shared/types/ipc';
import type { ProviderDefinition } from '../../src/shared/types/provider';
import type { FrozenProviderRequestSnapshot } from '../../src/shared/types/accounting';

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

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: async (specifier: string) => {
    if (specifier === '@ai-sdk/openai-compatible') {
      return {
        createOpenAICompatible: () => (modelId: string) => ({ modelId }),
      };
    }
    if (specifier === '@ai-sdk/anthropic') {
      return {
        createAnthropic: () => ({ messages: (modelId: string) => ({ modelId }) }),
      };
    }
    throw new Error(`Unexpected acceptance adapter import '${specifier}'`);
  },
}));

// The provider IPC test seam below supplies every runtime service. Avoiding
// Electron startup keeps this deterministic while preserving the public IPC
// handler contract.
vi.mock('../../src/main/providers/runtime-context', () => ({
  getProviderCatalogStore: vi.fn(),
  getProviderConnectionStore: vi.fn(),
  getProviderCredentialVault: vi.fn(),
  getProviderStatusService: vi.fn(),
}));

import * as providerIpc from '../../src/main/ipc/providers';
import { ProviderRuntime } from '../../src/main/providers';
import { calculateAttemptCost } from '../../src/main/providers/accounting/cost';
import { ProviderAccountingStore } from '../../src/main/providers/accounting/store';
import { ProviderCatalogStore, type ProviderCatalogSnapshot } from '../../src/main/providers/catalog/store';
import { ProviderCatalogUpdater } from '../../src/main/providers/catalog/updater';
import type { CatalogKeyring } from '../../src/main/providers/catalog/trust';
import {
  ConnectionStore,
  _clearConnectionStoreWriteChains,
} from '../../src/main/providers/connection-store';
import {
  CredentialVault,
  _clearCredentialVaultWriteChains,
} from '../../src/main/providers/credentials/vault';
import { createCompatibleLanguageModel } from '../../src/main/providers/drivers/compatible';
import { createOpenCodeGoLanguageModel } from '../../src/main/providers/drivers/opencode-go';
import { ProviderDriverRegistry } from '../../src/main/providers/drivers/registry';
import { fetchLilacStatus } from '../../src/main/providers/drivers/lilac';
import { resolveModelSelection } from '../../src/main/providers/resolver';
import { ProviderStatusCache } from '../../src/main/providers/status/cache';
import {
  ProviderStatusService,
  type ProviderStatusSource,
} from '../../src/main/providers/status/service';
import {
  CATALOG_NOW,
  createCatalogFixture,
} from '../fixtures/provider-catalog/catalog-fixture';

const FIXTURE_NOW = new Date('2026-07-13T12:00:00.000Z');
const LILAC_MODEL_ID = 'moonshotai/kimi-k2.6';

const LILAC_DEFINITION: ProviderDefinition = {
  id: 'lilac',
  displayName: 'Lilac',
  supportedAuthMethods: ['api-key', 'environment'],
  supportedProtocols: ['openai-compatible'],
  allowsCustomModels: true,
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

function emptyCatalogSnapshot(): ProviderCatalogSnapshot {
  return {
    source: 'bundled',
    stale: false,
    catalog: {
      schemaVersion: 1,
      catalogVersion: 1,
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-12-31T00:00:00.000Z',
      compatibleApp: { minimum: '0.1.0' },
      provenance: {
        source: 'models.dev',
        sourceUrl: 'https://example.com/catalog.json',
        capturedAt: '2026-01-01T00:00:00.000Z',
        contentHash: `sha256:${'0'.repeat(64)}`,
      },
      providers: [],
    },
  };
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
      catalog: { getProviderDefinitions: () => [LILAC_DEFINITION], load: () => emptyCatalogSnapshot() },
      connections,
      vault,
      status,
      registry,
      clearConfigReferences: vi.fn(async () => ({
        config: {
          default_model: null,
          tier_models: { seed: null, sprout: null, bloom: null, crown: null },
          rag: { embedding_api_model: null },
        },
        clearedConfigReferences: {
          defaultModel: false,
          tierModels: [],
          ragEmbeddingModel: false,
        },
      })) as never,
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
  it('AE1/AE2 moves a local-only persisted home through redacted setup, restart, typed execution, and immutable attribution', async () => {
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
      modelDisplayName: 'Kimi K2.6',
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
    expect(restartedLedger.getSessionTotals('provider-e2e-session')).toEqual({
      currencies: [
        {
          currency: 'USD',
          amount: '0.0012',
          recordCount: 1,
        },
      ],
      unknownCount: 0,
    });
  });

  it('AE9 passes Lilac supply-discount data through a local fixture status contract without affecting typed send eligibility', async () => {
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

  it('AE3 isolates stored credentials so disconnecting one connection cannot affect another', async () => {
    const root = makeTempDirectory();
    const connections = new ConnectionStore({ providersPath: path.join(root, 'providers.json') });
    const vault = new CredentialVault({
      credentialsPath: path.join(root, 'credentials.json'),
      safeStorage: electron.safeStorage,
      now: () => FIXTURE_NOW,
    });
    const work = await connections.create({
      providerId: 'openai',
      name: 'Work OpenAI',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'none' },
      modelIds: ['gpt-5.2-pro'],
      health: 'ready',
    });
    const personal = await connections.create({
      providerId: 'openai',
      name: 'Personal OpenAI',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'none' },
      modelIds: ['gpt-5.2-pro'],
      health: 'ready',
    });
    const workBinding = {
      connectionId: work.id,
      driverId: work.providerId,
      authMethod: 'api-key' as const,
      origin: 'https://api.openai.com',
    };
    const personalBinding = {
      connectionId: personal.id,
      driverId: personal.providerId,
      authMethod: 'api-key' as const,
      origin: 'https://api.openai.com',
    };
    const workHandle = await vault.storeApiKey(workBinding, 'sk-work-key-123456');
    const personalHandle = await vault.storeApiKey(personalBinding, 'sk-personal-key-123456');
    await connections.update(work.id, { credential: { kind: 'stored', handle: workHandle } });
    await connections.update(personal.id, { credential: { kind: 'stored', handle: personalHandle } });

    await vault.deleteConnectionCredentials(personal.id);
    await connections.update(personal.id, {
      health: 'disconnected',
      credential: { kind: 'none' },
    });

    await expect(vault.readSecret(personalHandle, personalBinding)).rejects.toThrow(/unknown/i);
    await expect(vault.readSecret(workHandle, workBinding)).resolves.toEqual({
      kind: 'api-key',
      apiKey: 'sk-work-key-123456',
    });
    expect(await connections.get(work.id)).toMatchObject({ health: 'ready' });
    expect(await connections.get(personal.id)).toMatchObject({
      health: 'disconnected',
      credential: { kind: 'none' },
    });
    expect(JSON.stringify(await connections.list())).not.toMatch(/sk-work-key|sk-personal-key/);
  });

  it('AE4/AE5 rejects tampering and keeps a frozen price immutable across catalog promotion', async () => {
    const root = makeTempDirectory();
    const bundledCatalogPath = path.join(root, 'catalog.json');
    const cachePath = path.join(root, 'cache', 'catalog.json');
    fs.writeFileSync(bundledCatalogPath, JSON.stringify(createCatalogFixture(1)), 'utf8');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyring = {
      acceptance: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    } satisfies CatalogKeyring;
    const store = new ProviderCatalogStore({
      bundledCatalogPath,
      cachePath,
      appVersion: '0.1.0',
      keyring,
      now: () => new Date(CATALOG_NOW),
    });
    const catalog2 = createCatalogFixture(2);
    const bytes2 = Buffer.from(JSON.stringify(catalog2), 'utf8');
    const signed2 = {
      bytes: bytes2,
      signature: sign(null, bytes2, privateKey),
      keyId: 'acceptance',
    };
    await new ProviderCatalogUpdater(store, {
      fetchCatalog: async () => signed2,
    }).refresh();
    const frozenPricing = structuredClone(store.load().catalog.providers[0]!.models[0]!.pricing);

    await expect(new ProviderCatalogUpdater(store, {
      fetchCatalog: async () => ({ ...signed2, signature: Buffer.from('tampered') }),
    }).refresh()).rejects.toThrow();
    expect(store.load().catalog.catalogVersion).toBe(2);

    const catalog3 = createCatalogFixture(3);
    catalog3.providers[0]!.models[0]!.pricing.rates.input!.amount = '999';
    const bytes3 = Buffer.from(JSON.stringify(catalog3), 'utf8');
    store.promote({
      bytes: bytes3,
      signature: sign(null, bytes3, privateKey),
      keyId: 'acceptance',
    });
    expect(frozenPricing?.rates.input?.amount).toBe('1.250000');
    expect(store.load().catalog.providers[0]!.models[0]!.pricing.rates.input!.amount).toBe('999');
  });

  it('AE6/AE7/AE10 calculates only authoritative formulas and keeps unknown money separate from zero', () => {
    const root = makeTempDirectory();
    const tokenSnapshot = accountingSnapshot();
    expect(calculateAttemptCost({
      snapshot: tokenSnapshot,
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 100,
        cacheWriteTokens: 10,
      },
      evidence: {},
    })).toMatchObject({ state: 'calculated', source: 'token-formula', amount: '0.0096125' });

    const energySnapshot = accountingSnapshot({
      providerId: 'neuralwatt',
      providerDisplayName: 'Neuralwatt',
      pricing: {
        currency: 'USD',
        effectiveAt: FIXTURE_NOW.toISOString(),
        rates: { energy: { amount: '5', per: 1, unit: 'energy' } },
        inclusion: { cacheRead: 'unknown', cacheWrite: 'unknown', reasoning: 'unknown' },
        provenance: { source: 'provider-fixture' },
      },
    });
    expect(calculateAttemptCost({
      snapshot: energySnapshot,
      usage: {
        energyKwhConsumed: '0.02',
        energyKwhCharged: '0.013',
        pricingMultiplier: '0.65',
      },
      evidence: { accountingMethod: 'energy', energyRateUsdPerKwh: '5', currency: 'USD' },
    })).toMatchObject({ state: 'calculated', source: 'energy-formula', amount: '0.065' });
    expect(calculateAttemptCost({
      snapshot: energySnapshot,
      usage: { energyKwhCharged: '0.013', pricingMultiplier: '0.65' },
      evidence: { accountingMethod: 'energy', energyRateUsdPerKwh: '5', currency: 'USD' },
    })).toMatchObject({ state: 'unknown' });

    const ledger = new ProviderAccountingStore({
      dbPath: path.join(root, 'accounting.db'),
      now: () => FIXTURE_NOW,
    });
    ledgers.push(ledger);
    const knownAttemptId = '00000000-0000-4000-8000-000000000500';
    ledger.insertPending({
      attemptId: knownAttemptId,
      sessionId: 'unknown-cost-session',
      chainId: 'unknown-cost-chain',
      turnId: 'known-cost-turn',
      sdkCallId: null,
      snapshot: tokenSnapshot,
    });
    ledger.finalize(knownAttemptId, {
      outcome: 'succeeded',
      usage: { inputTokens: 1 },
      providerEvidence: {},
      cost: {
        state: 'reported',
        source: 'provider-reported',
        currency: 'USD',
        amount: '0.25',
      },
    });
    const attemptId = '00000000-0000-4000-8000-000000000501';
    ledger.insertPending({
      attemptId,
      sessionId: 'unknown-cost-session',
      chainId: 'unknown-cost-chain',
      turnId: 'unknown-cost-turn',
      sdkCallId: null,
      snapshot: tokenSnapshot,
    });
    ledger.finalize(attemptId, {
      outcome: 'succeeded',
      usage: { inputTokens: 1 },
      providerEvidence: { quotaUsed: 1, quotaLimit: 10 },
      cost: { state: 'unknown', source: 'unknown' },
    });
    expect(ledger.getSessionTotals('unknown-cost-session')).toEqual({
      currencies: [{
        currency: 'USD',
        amount: '0.25',
        recordCount: 1,
      }],
      unknownCount: 1,
    });
  });

  it('AE8/AE11 constructs each declared compatible protocol without parsing slash-containing model IDs', async () => {
    const openAiCompatible = await createOpenCodeGoLanguageModel({
      protocol: 'openai-compatible',
      modelId: 'deepseek/v4-flash',
      apiKey: 'fixture-opencode-key',
    });
    const anthropicMessages = await createOpenCodeGoLanguageModel({
      protocol: 'anthropic-messages',
      modelId: 'minimax/m3',
      apiKey: 'fixture-opencode-key',
    });
    const customAnthropic = await createCompatibleLanguageModel({
      providerId: 'generic-anthropic-compatible',
      protocol: 'anthropic-messages',
      modelId: 'custom/team/model-v1',
      apiKey: 'fixture-generic-key',
      endpoint: 'http://127.0.0.1:41415/v1',
    });

    expect(openAiCompatible.modelId).toBe('deepseek/v4-flash');
    expect(anthropicMessages.modelId).toBe('minimax/m3');
    expect(customAnthropic.modelId).toBe('custom/team/model-v1');
  });
});

function accountingSnapshot(
  overrides: Partial<FrozenProviderRequestSnapshot> = {},
): FrozenProviderRequestSnapshot {
  return {
    providerId: 'anthropic',
    providerDisplayName: 'Anthropic',
    connectionId: '00000000-0000-4000-8000-000000000401',
    connectionName: 'Acceptance connection',
    modelId: 'claude/acceptance',
    protocol: 'anthropic-messages',
    modelSource: 'catalog',
    catalogVersion: 1,
    catalogSource: 'bundled',
    catalogObservedAt: FIXTURE_NOW.toISOString(),
    fieldProvenance: {},
    statusObservation: null,
    pricing: {
      currency: 'USD',
      effectiveAt: FIXTURE_NOW.toISOString(),
      rates: {
        input: { amount: '5', per: 1_000_000, unit: 'tokens' },
        output: { amount: '25', per: 1_000_000, unit: 'tokens' },
        cacheRead: { amount: '0.5', per: 1_000_000, unit: 'tokens' },
        cacheWrite: { amount: '6.25', per: 1_000_000, unit: 'tokens' },
      },
      inclusion: {
        cacheRead: 'subset-of-input',
        cacheWrite: 'additional',
        reasoning: 'subset-of-output',
      },
      provenance: { source: 'catalog-fixture' },
    },
    ...overrides,
  };
}
