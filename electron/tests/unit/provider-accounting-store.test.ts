import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FrozenProviderRequestSnapshot } from '../../src/shared/types/accounting';
import { ProviderAccountingStore } from '../../src/main/providers/accounting/store';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function snapshot(): FrozenProviderRequestSnapshot {
  return {
    providerId: 'anthropic',
    providerDisplayName: 'Anthropic',
    connectionId: '11111111-1111-4111-8111-111111111111',
    connectionName: 'Work',
    modelId: 'claude-test',
    protocol: 'anthropic-messages',
    modelSource: 'catalog',
    catalogVersion: 1,
    catalogSource: 'bundled',
    catalogObservedAt: '2026-07-12T00:00:00.000Z',
    pricing: null,
    fieldProvenance: { source: 'catalog' },
    statusObservation: null,
  };
}

function createStore() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-accounting-'));
  return new ProviderAccountingStore({ dbPath: path.join(tempDir, 'accounting.db') });
}

describe('ProviderAccountingStore', () => {
  it('inserts a durable pending attempt before finalizing an immutable reported-cost record', () => {
    const store = createStore();
    const frozen = snapshot();
    store.insertPending({
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      chainId: 'chain-1',
      turnId: 'turn-1',
      sdkCallId: 'sdk-1',
      snapshot: frozen,
    });
    (frozen as { connectionName: string }).connectionName = 'mutated outside store';

    expect(store.finalize('attempt-1', {
      outcome: 'succeeded',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      providerEvidence: { request_cost_usd: '0.001', api_key: 'must-not-persist' },
      cost: { state: 'reported', source: 'provider-reported', currency: 'USD', amount: '0.001' },
    })).toBe(true);
    store.close();

    const restored = new ProviderAccountingStore({ dbPath: path.join(tempDir!, 'accounting.db') });
    const row = restored.getAttempt('attempt-1');
    expect(row).toMatchObject({
      outcome: 'succeeded',
      costState: 'reported',
      costAmount: '0.001',
      snapshot: { connectionName: 'Work' },
    });
    expect(JSON.stringify(row)).not.toContain('must-not-persist');
    expect(restored.finalize('attempt-1', {
      outcome: 'failed',
      usage: null,
      providerEvidence: {},
      cost: { state: 'unknown', source: 'unknown', reason: 'must not overwrite' },
      error: 'late callback',
    })).toBe(false);
    restored.close();
  });

  it('derives exact per-currency totals and unknown counts from immutable rows', () => {
    const store = createStore();
    for (const [id, cost] of [
      ['attempt-a', { state: 'calculated' as const, source: 'token-formula' as const, currency: 'USD', amount: '0.1' }],
      ['attempt-b', { state: 'calculated' as const, source: 'token-formula' as const, currency: 'USD', amount: '0.2' }],
      ['attempt-c', { state: 'unknown' as const, source: 'unknown' as const, reason: 'subscription quota only' }],
    ] as const) {
      store.insertPending({ attemptId: id, sessionId: 'session-1', chainId: 'chain-1', turnId: 'turn-1', sdkCallId: null, snapshot: snapshot() });
      store.finalize(id, { outcome: 'succeeded', usage: null, providerEvidence: {}, cost });
    }

    expect(store.getSessionTotals('session-1')).toEqual({
      currencies: [{ currency: 'USD', amount: '0.3', recordCount: 2 }],
      unknownCount: 1,
    });
    expect(store.getChainTotals('chain-1')).toEqual({
      currencies: [{ currency: 'USD', amount: '0.3', recordCount: 2 }],
      unknownCount: 1,
    });
    store.close();
  });

  it('attaches unknownCount once at the summary level across multiple currencies', () => {
    const store = createStore();
    for (const [id, cost] of [
      ['a', { state: 'calculated' as const, source: 'token-formula' as const, currency: 'USD', amount: '0.1' }],
      ['b', { state: 'calculated' as const, source: 'token-formula' as const, currency: 'EUR', amount: '0.2' }],
      ['c', { state: 'unknown' as const, source: 'unknown' as const, reason: 'quota only' }],
      ['d', { state: 'unknown' as const, source: 'unknown' as const, reason: 'subscription' }],
    ] as const) {
      store.insertPending({ attemptId: id, sessionId: 'session-2', chainId: 'chain-2', turnId: 'turn-1', sdkCallId: null, snapshot: snapshot() });
      store.finalize(id, { outcome: 'succeeded', usage: null, providerEvidence: {}, cost });
    }

    const totals = store.getSessionTotals('session-2');
    expect(totals.unknownCount).toBe(2);
    expect(totals.currencies).toEqual([
      { currency: 'USD', amount: '0.1', recordCount: 1 },
      { currency: 'EUR', amount: '0.2', recordCount: 1 },
    ]);
    expect(totals.currencies.every((row) => !('unknownCount' in row))).toBe(true);
    store.close();
  });

  it('marks abandoned pending rows interrupted exactly once on restart recovery', () => {
    const store = createStore();
    store.insertPending({ attemptId: 'pending-1', sessionId: 'session-1', chainId: null, turnId: null, sdkCallId: null, snapshot: snapshot() });
    expect(store.recoverPending()).toBe(1);
    expect(store.recoverPending()).toBe(0);
    expect(store.getAttempt('pending-1')).toMatchObject({
      outcome: 'interrupted', costState: 'unknown', costSource: 'unknown',
    });
    store.close();
  });

  it('finalizes only one connection pending attempts before destructive disconnect', () => {
    const store = createStore();
    const own = snapshot();
    const sibling = { ...snapshot(), connectionId: '22222222-2222-4222-8222-222222222222' };
    store.insertPending({ attemptId: 'disconnect-own', sessionId: 'session-1', chainId: null, turnId: null, sdkCallId: null, snapshot: own });
    store.insertPending({ attemptId: 'disconnect-sibling', sessionId: 'session-2', chainId: null, turnId: null, sdkCallId: null, snapshot: sibling });

    expect(store.interruptPendingForConnection(own.connectionId)).toBe(1);
    expect(store.getAttempt('disconnect-own')).toMatchObject({ outcome: 'interrupted' });
    expect(store.getAttempt('disconnect-sibling')).toMatchObject({ outcome: 'pending' });
    store.close();
  });

  it('fails closed when persisted accounting JSON is corrupt or structurally incomplete', () => {
    const store = createStore();
    const dbPath = path.join(tempDir!, 'accounting.db');
    store.insertPending({
      attemptId: 'corrupt-snapshot',
      sessionId: 'session-1',
      chainId: null,
      turnId: null,
      sdkCallId: null,
      snapshot: snapshot(),
    });
    store.close();

    const db = new Database(dbPath);
    db.prepare('UPDATE provider_attempts SET snapshot_json = ? WHERE attempt_id = ?')
      .run('{"providerId":"anthropic"}', 'corrupt-snapshot');
    db.close();

    const restored = new ProviderAccountingStore({ dbPath });
    expect(() => restored.getAttempt('corrupt-snapshot')).toThrow(/invalid snapshot/i);
    restored.close();
  });

  it('persists the pricing ladder rung on calculated attempts and null otherwise', () => {
    const store = createStore();
    store.insertPending({ attemptId: 'rung-user', sessionId: 'session-1', chainId: null, turnId: null, sdkCallId: null, snapshot: snapshot() });
    store.insertPending({ attemptId: 'rung-reported', sessionId: 'session-1', chainId: null, turnId: null, sdkCallId: null, snapshot: snapshot() });
    store.finalize('rung-user', {
      outcome: 'succeeded',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      providerEvidence: {},
      cost: {
        state: 'calculated', source: 'token-formula', currency: 'USD', amount: '0.001',
        rateRung: 'user', rateRungStale: true,
      },
    });
    store.finalize('rung-reported', {
      outcome: 'succeeded',
      usage: null,
      providerEvidence: {},
      cost: { state: 'reported', source: 'provider-reported', currency: 'USD', amount: '0.002' },
    });
    store.close();

    const restored = new ProviderAccountingStore({ dbPath: path.join(tempDir!, 'accounting.db') });
    const calculated = restored.getAttempt('rung-user');
    expect(calculated).toMatchObject({ costRung: 'user', costState: 'calculated' });
    expect(calculated?.providerEvidence.costRungStale).toBe(true);
    expect(restored.getAttempt('rung-reported')).toMatchObject({ costRung: null, costState: 'reported' });
    restored.close();
  });

  it('round-trips frozen pricing with ladder provenance, TTL variants, tiers, and native units', () => {
    const store = createStore();
    const frozen: FrozenProviderRequestSnapshot = {
      ...snapshot(),
      pricing: {
      currency: 'kWh',
      currencyUnit: { kind: 'non-fiat', unit: 'kWh', displayName: 'kilowatt-hour' },
      effectiveAt: '2026-07-12T00:00:00.000Z',
      rates: {
        input: {
          amount: '5', per: 1_000_000, unit: 'tokens',
          provenance: { source: 'provider-api', observedAt: '2026-07-12T00:00:00.000Z', stale: true },
        },
        cacheWriteByTtl: {
          '1h': {
            amount: '6', per: 1_000_000, unit: 'tokens',
            provenance: { source: 'user', observedAt: null },
          },
        },
        perRequest: { amount: '0.01', per: 1, unit: 'requests' },
        energy: { amount: '1.5', per: 1, unit: 'energy' },
      },
      contextTiers: [{
        overContextTokens: 100_000,
        rates: { input: { amount: '10', per: 1_000_000, unit: 'tokens' } },
      }],
        inclusion: { cacheRead: 'subset-of-input', cacheWrite: 'additional', reasoning: 'unknown' },
        provenance: { source: 'provider-api', dynamic: { state: 'stale' } },
      },
    };
    store.insertPending({ attemptId: 'rich-snapshot', sessionId: 'session-1', chainId: null, turnId: null, sdkCallId: null, snapshot: frozen });
    store.finalize('rich-snapshot', {
      outcome: 'succeeded',
      usage: { energyKwhConsumed: '0.02', energyKwhCharged: '0.013', pricingMultiplier: '0.65' },
      providerEvidence: {},
      cost: {
        state: 'calculated', source: 'energy-formula', currency: 'kWh', amount: '0.0195',
        rateRung: 'provider-api', rateRungStale: true,
      },
    });
    store.close();

    const restored = new ProviderAccountingStore({ dbPath: path.join(tempDir!, 'accounting.db') });
    const attempt = restored.getAttempt('rich-snapshot');
    expect(attempt).toMatchObject({
      costRung: 'provider-api',
      currency: 'kWh',
      costAmount: '0.0195',
      usage: { energyKwhConsumed: '0.02', energyKwhCharged: '0.013', pricingMultiplier: '0.65' },
      snapshot: {
        pricing: {
          currency: 'kWh',
          currencyUnit: { kind: 'non-fiat', unit: 'kWh' },
          rates: {
            input: { provenance: { source: 'provider-api', stale: true } },
            cacheWriteByTtl: { '1h': { amount: '6' } },
            perRequest: { amount: '0.01', unit: 'requests' },
          },
          contextTiers: [{ overContextTokens: 100_000 }],
        },
      },
    });
    restored.close();
  });

  it('migrates a legacy provider_attempts table without a cost_rung column', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-accounting-'));
    const dbPath = path.join(tempDir, 'accounting.db');
    const legacy = new Database(dbPath);
    legacy.prepare(`
      CREATE TABLE provider_attempts (
        attempt_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        chain_id TEXT,
        turn_id TEXT,
        sdk_call_id TEXT,
        provider_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        protocol TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        outcome TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        usage_json TEXT,
        provider_evidence_json TEXT NOT NULL DEFAULT '{}',
        cost_state TEXT NOT NULL,
        cost_source TEXT NOT NULL,
        currency TEXT,
        cost_amount TEXT,
        error TEXT,
        agent_scope TEXT,
        agent_name TEXT,
        agent_tier TEXT,
        agent_type TEXT
      )
    `).run();
    legacy.prepare(`
      INSERT INTO provider_attempts (
        attempt_id, session_id, provider_id, connection_id, model_id, protocol,
        snapshot_json, outcome, started_at, cost_state, cost_source
      ) VALUES ('legacy-row', 'session-1', 'anthropic', '11111111-1111-4111-8111-111111111111',
        'claude-test', 'anthropic-messages', ?, 'succeeded', '2026-07-12T00:00:00.000Z', 'calculated', 'token-formula')
    `).run(JSON.stringify(snapshot()));
    legacy.close();

    const store = new ProviderAccountingStore({ dbPath });
    expect(store.getAttempt('legacy-row')).toMatchObject({ costRung: null, costState: 'calculated' });
    store.insertPending({ attemptId: 'after-migration', sessionId: 'session-1', chainId: null, turnId: null, sdkCallId: null, snapshot: snapshot() });
    store.finalize('after-migration', {
      outcome: 'succeeded',
      usage: null,
      providerEvidence: {},
      cost: { state: 'calculated', source: 'token-formula', currency: 'USD', amount: '0.1', rateRung: 'catalog' },
    });
    expect(store.getAttempt('after-migration')).toMatchObject({ costRung: 'catalog' });
    store.close();
  });
});
