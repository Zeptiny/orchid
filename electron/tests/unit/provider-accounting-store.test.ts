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

    expect(store.getSessionTotals('session-1')).toEqual([{
      currency: 'USD', amount: '0.3', recordCount: 2, unknownCount: 1,
    }]);
    expect(store.getChainTotals('chain-1')).toEqual([{
      currency: 'USD', amount: '0.3', recordCount: 2, unknownCount: 1,
    }]);
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
});
