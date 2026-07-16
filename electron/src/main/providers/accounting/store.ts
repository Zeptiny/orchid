import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import Decimal from 'decimal.js';
import { z } from 'zod';
import {
  type FrozenProviderRequestSnapshot,
  type CostTotalsSummary,
  type KnownCostTotals,
  type NormalizedProviderUsage,
  type ProviderAttemptRecord,
} from '../../../shared/types/accounting';
import { HOME_CONFIG_DIR } from '../../config/loader';
import { redactLogString } from '../../logging';
import { providerProtocolSchema } from '../../../shared/types/provider';
import { ACCOUNTING_SCHEMA_SQL, ACCOUNTING_SCHEMA_VERSION } from './schema';
import type { AttemptCostResolution } from './cost';

export const PROVIDER_ACCOUNTING_DB_PATH = path.join(HOME_CONFIG_DIR, 'accounting.db');

export interface ProviderAccountingStoreOptions {
  readonly dbPath?: string;
  readonly now?: () => Date;
}

export interface InsertPendingAttemptInput {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly sdkCallId: string | null;
  readonly snapshot: FrozenProviderRequestSnapshot;
}

export interface FinalizeAttemptInput {
  readonly outcome: Exclude<ProviderAttemptRecord['outcome'], 'pending'>;
  readonly usage: NormalizedProviderUsage | null;
  readonly providerEvidence: Readonly<Record<string, unknown>>;
  readonly cost: AttemptCostResolution;
  readonly error?: string;
}

const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|password|cookie|credential|request[_-]?body|(?:^|[_-])body$|account(?:[_-]?(?:id|identifier))?|org(?:anization)?[_-]?id|user[_-]?id)/i;

function sanitize(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactLogString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, undefined, seen));
  const result: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    result[nestedKey] = sanitize(nestedValue, nestedKey, seen);
  }
  return result;
}

function json(value: unknown): string {
  return JSON.stringify(sanitize(value));
}

const decimalTextSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const pricingRateSnapshotSchema = z.object({
  amount: decimalTextSchema,
  per: z.number().int().positive(),
  unit: z.enum(['tokens', 'requests', 'characters', 'energy']),
});
const frozenProviderRequestSnapshotSchema = z.object({
  providerId: z.string().min(1),
  providerDisplayName: z.string().min(1),
  connectionId: z.string().uuid(),
  connectionName: z.string().min(1),
  modelId: z.string().min(1),
  protocol: providerProtocolSchema,
  modelSource: z.enum(['catalog', 'connection']),
  catalogVersion: z.number().int().nonnegative().nullable(),
  catalogSource: z.enum(['bundled', 'cache', 'none']),
  catalogObservedAt: z.string().datetime().nullable(),
  pricing: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    effectiveAt: z.string().datetime(),
    rates: z.object({
      input: pricingRateSnapshotSchema.optional(),
      output: pricingRateSnapshotSchema.optional(),
      cacheRead: pricingRateSnapshotSchema.optional(),
      cacheWrite: pricingRateSnapshotSchema.optional(),
      reasoning: pricingRateSnapshotSchema.optional(),
      energy: pricingRateSnapshotSchema.optional(),
    }),
    inclusion: z.object({
      cacheRead: z.enum(['subset-of-input', 'additional', 'unknown']),
      cacheWrite: z.enum(['subset-of-input', 'additional', 'unknown']),
      reasoning: z.enum(['subset-of-output', 'additional', 'unknown']),
    }),
    provenance: z.record(z.unknown()),
  }).nullable(),
  fieldProvenance: z.record(z.unknown()),
  statusObservation: z.record(z.unknown()).nullable(),
});
const normalizedProviderUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  energyKwhConsumed: decimalTextSchema.optional(),
  energyKwhCharged: decimalTextSchema.optional(),
  pricingMultiplier: decimalTextSchema.optional(),
});
const providerEvidenceSchema = z.record(z.unknown());

function parseJson<TSchema extends z.ZodTypeAny>(
  value: string | null | undefined,
  label: string,
  schema: TSchema,
): z.infer<TSchema> {
  if (value == null) throw new Error(`Provider accounting row is missing ${label}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Provider accounting row contains invalid ${label} JSON`, { cause: error });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Provider accounting row contains invalid ${label}: ${result.error.message}`);
  }
  return result.data;
}

function ensureParentDirectory(dbPath: string): void {
  const directory = path.dirname(dbPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

type AttemptRow = {
  attempt_id: string;
  session_id: string;
  chain_id: string | null;
  turn_id: string | null;
  sdk_call_id: string | null;
  snapshot_json: string;
  outcome: ProviderAttemptRecord['outcome'];
  started_at: string;
  completed_at: string | null;
  usage_json: string | null;
  provider_evidence_json: string;
  cost_state: ProviderAttemptRecord['costState'];
  cost_source: ProviderAttemptRecord['costSource'];
  currency: string | null;
  cost_amount: string | null;
  error: string | null;
};

function rowToRecord(row: AttemptRow): ProviderAttemptRecord {
  return {
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    chainId: row.chain_id,
    turnId: row.turn_id,
    sdkCallId: row.sdk_call_id,
    snapshot: parseJson(row.snapshot_json, 'snapshot', frozenProviderRequestSnapshotSchema),
    outcome: row.outcome,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    usage: row.usage_json === null
      ? null
      : parseJson(row.usage_json, 'usage', normalizedProviderUsageSchema),
    providerEvidence: parseJson(row.provider_evidence_json, 'provider evidence', providerEvidenceSchema),
    costState: row.cost_state,
    costSource: row.cost_source,
    currency: row.currency,
    costAmount: row.cost_amount,
    error: row.error,
  };
}

/**
 * Required SQLite ledger for append-only provider attempts. A pending row is
 * inserted synchronously before network I/O and finalized idempotently.
 */
export class ProviderAccountingStore {
  private readonly dbPath: string;
  private readonly now: () => Date;
  private db: Database.Database | null = null;

  constructor(options: ProviderAccountingStoreOptions = {}) {
    this.dbPath = options.dbPath ?? PROVIDER_ACCOUNTING_DB_PATH;
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  insertPending(input: InsertPendingAttemptInput): void {
    const db = this.connection();
    const startedAt = this.now().toISOString();
    db.prepare(`
      INSERT INTO provider_attempts (
        attempt_id, session_id, chain_id, turn_id, sdk_call_id,
        provider_id, connection_id, model_id, protocol, snapshot_json,
        outcome, started_at, completed_at, usage_json, provider_evidence_json,
        cost_state, cost_source, currency, cost_amount, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, '{}', 'unknown', 'unknown', NULL, NULL, NULL)
    `).run(
      input.attemptId,
      input.sessionId,
      input.chainId,
      input.turnId,
      input.sdkCallId,
      input.snapshot.providerId,
      input.snapshot.connectionId,
      input.snapshot.modelId,
      input.snapshot.protocol,
      json(input.snapshot),
      startedAt,
    );
  }

  /** Returns false for an already-finalized/replayed completion callback. */
  finalize(attemptId: string, input: FinalizeAttemptInput): boolean {
    const db = this.connection();
    const evidence: Record<string, unknown> = { ...input.providerEvidence };
    if (input.cost.state === 'unknown') evidence.costReason = input.cost.reason;
    const result = db.prepare(`
      UPDATE provider_attempts
      SET outcome = ?, completed_at = ?, usage_json = ?, provider_evidence_json = ?,
          cost_state = ?, cost_source = ?, currency = ?, cost_amount = ?, error = ?
      WHERE attempt_id = ? AND outcome = 'pending'
    `).run(
      input.outcome,
      this.now().toISOString(),
      input.usage === null ? null : json(input.usage),
      json(evidence),
      input.cost.state,
      input.cost.source,
      input.cost.state === 'unknown' ? null : input.cost.currency,
      input.cost.state === 'unknown' ? null : input.cost.amount,
      input.error ? redactLogString(input.error) : null,
      attemptId,
    );
    return result.changes === 1;
  }

  /** Mark process-crash leftovers interrupted once, without mutating completed rows. */
  recoverPending(): number {
    const result = this.connection().prepare(`
      UPDATE provider_attempts
      SET outcome = 'interrupted', completed_at = ?, cost_state = 'unknown',
          cost_source = 'unknown', error = 'Application exited before provider attempt completed'
      WHERE outcome = 'pending'
    `).run(this.now().toISOString());
    return result.changes;
  }

  /**
   * Finish in-flight attempts for one connection before destructive disconnect.
   * Late stream callbacks remain safe because `finalize()` is idempotent and
   * updates only rows that are still pending.
   */
  interruptPendingForConnection(connectionId: string): number {
    const result = this.connection().prepare(`
      UPDATE provider_attempts
      SET outcome = 'interrupted', completed_at = ?, cost_state = 'unknown',
          cost_source = 'unknown', error = 'Connection disconnected by user before provider attempt completed'
      WHERE connection_id = ? AND outcome = 'pending'
    `).run(this.now().toISOString(), connectionId);
    return result.changes;
  }

  getAttempt(attemptId: string): ProviderAttemptRecord | null {
    const row = this.connection().prepare(
      'SELECT * FROM provider_attempts WHERE attempt_id = ?',
    ).get(attemptId) as AttemptRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listAttempts(sessionId?: string): readonly ProviderAttemptRecord[] {
    const rows = sessionId === undefined
      ? this.connection().prepare('SELECT * FROM provider_attempts ORDER BY started_at, attempt_id').all()
      : this.connection().prepare('SELECT * FROM provider_attempts WHERE session_id = ? ORDER BY started_at, attempt_id').all(sessionId);
    return (rows as AttemptRow[]).map(rowToRecord);
  }

  getSessionTotals(sessionId: string): CostTotalsSummary {
    return this.totals('session_id', sessionId);
  }

  getChainTotals(chainId: string): CostTotalsSummary {
    return this.totals('chain_id', chainId);
  }

  private totals(column: 'session_id' | 'chain_id', value: string): CostTotalsSummary {
    const rows = this.connection().prepare(
      `SELECT currency, cost_amount, cost_state FROM provider_attempts WHERE ${column} = ?`,
    ).all(value) as Array<{ currency: string | null; cost_amount: string | null; cost_state: string }>;
    const sums = new Map<string, { amount: Decimal; recordCount: number }>();
    let unknownCount = 0;
    for (const row of rows) {
      if (row.cost_state !== 'reported' && row.cost_state !== 'calculated') {
        unknownCount += 1;
        continue;
      }
      if (!row.currency || !row.cost_amount) {
        unknownCount += 1;
        continue;
      }
      try {
        const entry = sums.get(row.currency) ?? { amount: new Decimal(0), recordCount: 0 };
        entry.amount = entry.amount.add(new Decimal(row.cost_amount));
        entry.recordCount += 1;
        sums.set(row.currency, entry);
      } catch {
        unknownCount += 1;
      }
    }
    const currencies: KnownCostTotals[] = [...sums.entries()].map(([currency, entry]) => ({
      currency,
      amount: entry.amount.toFixed(),
      recordCount: entry.recordCount,
    }));
    return { currencies, unknownCount };
  }

  private connection(): Database.Database {
    if (this.db) return this.db;
    ensureParentDirectory(this.dbPath);
    const db = new Database(this.dbPath);
    try {
      fs.chmodSync(this.dbPath, 0o600);
    } catch {
      // Best effort on non-POSIX filesystems.
    }
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(ACCOUNTING_SCHEMA_SQL);
    db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(ACCOUNTING_SCHEMA_VERSION));
    this.db = db;
    return db;
  }
}

let runtimeStore: ProviderAccountingStore | null = null;
let runtimeInitializationError: Error | null = null;

/** Initialize/recover the required ledger once during main-process startup. */
export function initializeProviderAccountingStore(
  options: ProviderAccountingStoreOptions = {},
): ProviderAccountingStore {
  try {
    const store = new ProviderAccountingStore(options);
    store.recoverPending();
    runtimeStore?.close();
    runtimeStore = store;
    runtimeInitializationError = null;
    return store;
  } catch (error) {
    runtimeStore?.close();
    runtimeStore = null;
    runtimeInitializationError = error instanceof Error ? error : new Error(String(error));
    throw runtimeInitializationError;
  }
}

/** Provider requests must fail closed when durable attribution is unavailable. */
export function getProviderAccountingStore(): ProviderAccountingStore {
  if (runtimeStore) return runtimeStore;
  throw runtimeInitializationError ?? new Error('Provider accounting store has not been initialized');
}

export function resetProviderAccountingStore(): void {
  runtimeStore?.close();
  runtimeStore = null;
  runtimeInitializationError = null;
}
