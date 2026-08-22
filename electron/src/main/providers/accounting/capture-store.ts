import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  DebugRequestCapture,
  DebugRequestSummary,
} from '../../../shared/types/debug';
import { HOME_CONFIG_DIR } from '../../config/loader';
import { openSqliteDb, type SqliteDatabase } from '../../utils/sqlite';
import { ACCOUNTING_SCHEMA_SQL, applyAccountingSchemaMigrations } from './schema';

export const PROVIDER_ATTEMPT_CAPTURE_DB_PATH = path.join(HOME_CONFIG_DIR, 'accounting.db');

/**
 * Per-field serialization cap. Captures are a debug affordance, not an
 * archive: one giant history payload must never balloon accounting.db
 * unboundedly. Over-cap fields are replaced by a truncation marker that
 * records the original size.
 */
export const DEBUG_CAPTURE_MAX_FIELD_BYTES = 4 * 1024 * 1024;

/** Session list window when the caller does not request one explicitly. */
export const DEBUG_CAPTURE_LIST_DEFAULT_LIMIT = 200;

/** Hard ceiling on the requested window (Show more growth is bounded). */
export const DEBUG_CAPTURE_LIST_MAX_LIMIT = 10_000;

export interface ProviderAttemptCaptureStoreOptions {
  readonly dbPath?: string;
  readonly now?: () => Date;
}

export interface InsertCaptureRequestInput {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly request: unknown;
}

export interface FinalizeCaptureInput {
  readonly response: unknown;
  readonly rawChunks: readonly unknown[];
}

/** Header names whose values are credentials and must never persist. */
const CAPTURE_REDACTED_HEADERS = new Set([
  'authorization',
  'api-key',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

interface SerializedField {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/**
 * Capture-specific serialization. Unlike the accounting ledger's sanitizer
 * (which redacts body-like keys outright), captures exist to preserve exact
 * request/response payloads — so only credential-bearing headers and
 * non-serializable runtime values (abort signals, functions) are stripped.
 */
function captureReplacer(this: unknown, key: string, value: unknown): unknown {
  if (key === 'abortSignal' || key === 'signal') return undefined;
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  // Error parts carry live Error instances; preserve their diagnostic shape.
  if (value instanceof Error) {
    return { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}) };
  }
  if (key === 'headers' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
      redacted[name] = CAPTURE_REDACTED_HEADERS.has(name.toLowerCase())
        ? '[REDACTED]'
        : headerValue;
    }
    return redacted;
  }
  return value;
}

function serializeField(value: unknown): SerializedField {
  let text: string;
  try {
    text = JSON.stringify(value, captureReplacer) ?? 'null';
  } catch {
    text = JSON.stringify(String(value));
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= DEBUG_CAPTURE_MAX_FIELD_BYTES) {
    return { text, bytes, truncated: false };
  }
  const marker = JSON.stringify({
    __truncated: true,
    originalBytes: bytes,
    capBytes: DEBUG_CAPTURE_MAX_FIELD_BYTES,
  });
  return {
    text: marker,
    bytes: Buffer.byteLength(marker, 'utf8'),
    truncated: true,
  };
}

type CaptureRow = {
  attempt_id: string;
  session_id: string;
  request_json: string;
  request_bytes: number;
  response_json: string | null;
  response_bytes: number | null;
  raw_chunks_json: string | null;
  raw_available: number;
  truncated: number;
  captured_at: string;
};

type SummaryJoinRow = CaptureRow & {
  chain_id: string | null;
  turn_id: string | null;
  provider_id: string;
  connection_name: string;
  model_id: string;
  protocol: string;
  outcome: DebugRequestSummary['outcome'];
  started_at: string;
  completed_at: string | null;
  first_token_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  agent_scope: string | null;
  agent_name: string | null;
  agent_type: string | null;
  agent_tier: string | null;
  error: string | null;
};

function joinRowToSummary(row: SummaryJoinRow): DebugRequestSummary {
  return {
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    chainId: row.chain_id,
    turnId: row.turn_id,
    providerId: row.provider_id,
    connectionName: row.connection_name,
    modelId: row.model_id,
    protocol: row.protocol,
    agentScope: row.agent_scope,
    agentName: row.agent_name,
    agentType: row.agent_type,
    agentTier: row.agent_tier,
    outcome: row.outcome,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    firstTokenAt: row.first_token_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    requestBytes: row.request_bytes,
    responseBytes: row.response_bytes,
    truncated: row.truncated === 1,
    rawAvailable: row.raw_available === 1,
    error: row.error,
  };
}

/** The frozen attempt snapshot JSON carries the connection display name. */
function snapshotConnectionName(snapshotJson: string): string {
  try {
    return (JSON.parse(snapshotJson) as { connectionName?: string }).connectionName ?? '';
  } catch {
    return '';
  }
}

/**
 * Raw provider request/response capture store (issue 146). Shares the
 * accounting.db file. All writes are best-effort by contract: a capture
 * failure must never break a provider attempt — callers wrap in try/catch.
 */
export class ProviderAttemptCaptureStore {
  private readonly dbPath: string;
  private readonly now: () => Date;
  private db: SqliteDatabase | null = null;

  constructor(options: ProviderAttemptCaptureStoreOptions = {}) {
    this.dbPath = options.dbPath ?? PROVIDER_ATTEMPT_CAPTURE_DB_PATH;
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** Persist the request half before network I/O. Idempotent per attempt. */
  insertRequest(input: InsertCaptureRequestInput): void {
    const field = serializeField(input.request);
    this.connection().prepare(`
      INSERT OR IGNORE INTO provider_attempt_captures (
        attempt_id, session_id, request_json, request_bytes,
        response_json, response_bytes, raw_chunks_json, raw_available, truncated, captured_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)
    `).run(
      input.attemptId,
      input.sessionId,
      field.text,
      field.bytes,
      field.truncated ? 1 : 0,
      this.now().toISOString(),
    );
  }

  /** Persist the response half once the attempt settles. Idempotent. */
  finalizeResponse(attemptId: string, input: FinalizeCaptureInput): void {
    const response = serializeField(input.response);
    const rawChunks = input.rawChunks.length > 0 ? serializeField(input.rawChunks) : null;
    this.connection().prepare(`
      UPDATE provider_attempt_captures
      SET response_json = ?, response_bytes = ?, raw_chunks_json = ?,
          raw_available = ?, truncated = MAX(truncated, ?)
      WHERE attempt_id = ? AND response_json IS NULL
    `).run(
      response.text,
      response.bytes,
      rawChunks === null ? null : rawChunks.text,
      input.rawChunks.length > 0 ? 1 : 0,
      (response.truncated || (rawChunks?.truncated ?? false)) ? 1 : 0,
      attemptId,
    );
  }

  /**
   * Captured attempts for one session joined with their ledger metadata.
   * Only attempts that have a capture row are listed — the capture gate
   * (not the ledger) defines the debug view's population.
   *
   * Windowed newest-first: long debugged sessions accumulate hundreds of
   * attempts (one per tool-loop step, retry, and background origin), so the
   * renderer pages through a growing window instead of shipping every row
   * over IPC on each poll. Returns the newest `limit` summaries plus the
   * unwindowed total so the UI can render "N of M".
   */
  listForSession(
    sessionId: string,
    limit: number = DEBUG_CAPTURE_LIST_DEFAULT_LIMIT,
  ): { requests: readonly DebugRequestSummary[]; total: number } {
    const cappedLimit = Math.min(DEBUG_CAPTURE_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
    const rows = this.connection().prepare(`
      SELECT cap.attempt_id, cap.session_id, cap.request_bytes, cap.response_bytes,
             cap.raw_available, cap.truncated, cap.captured_at,
             pa.chain_id, pa.turn_id, pa.provider_id, pa.model_id, pa.protocol,
             pa.outcome, pa.started_at, pa.completed_at, pa.first_token_at,
             json_extract(pa.usage_json, '$.inputTokens') as input_tokens,
             json_extract(pa.usage_json, '$.outputTokens') as output_tokens,
             pa.agent_scope, pa.agent_name, pa.agent_type, pa.agent_tier, pa.error,
             pa.snapshot_json
      FROM provider_attempt_captures cap
      JOIN provider_attempts pa ON pa.attempt_id = cap.attempt_id
      WHERE cap.session_id = ?
      ORDER BY pa.started_at DESC, pa.attempt_id DESC
      LIMIT ?
    `).all(sessionId, cappedLimit) as Array<SummaryJoinRow & { snapshot_json: string }>;
    const totalRow = this.connection().prepare(
      'SELECT COUNT(*) as total FROM provider_attempt_captures WHERE session_id = ?',
    ).get(sessionId) as { total: number };
    // connection_name lives inside the frozen snapshot JSON, not a column.
    return {
      requests: rows.map((row) => joinRowToSummary({
        ...row,
        connection_name: snapshotConnectionName(row.snapshot_json),
      })),
      total: totalRow.total,
    };
  }

  /** Full capture (request + response + raw chunks) for one attempt. */
  getCapture(attemptId: string): DebugRequestCapture | null {
    const row = this.connection().prepare(`
      SELECT cap.attempt_id, cap.session_id, cap.request_json, cap.request_bytes,
             cap.response_json, cap.response_bytes, cap.raw_chunks_json, cap.raw_available,
             cap.truncated, cap.captured_at,
             pa.chain_id, pa.turn_id, pa.provider_id, pa.model_id, pa.protocol,
             pa.outcome, pa.started_at, pa.completed_at, pa.first_token_at,
             json_extract(pa.usage_json, '$.inputTokens') as input_tokens,
             json_extract(pa.usage_json, '$.outputTokens') as output_tokens,
             pa.agent_scope, pa.agent_name, pa.agent_type, pa.agent_tier, pa.error,
             pa.snapshot_json
      FROM provider_attempt_captures cap
      JOIN provider_attempts pa ON pa.attempt_id = cap.attempt_id
      WHERE cap.attempt_id = ?
    `).get(attemptId) as (SummaryJoinRow & { snapshot_json: string; request_json: string }) | undefined;
    if (!row) return null;

    const summary = joinRowToSummary({
      ...row,
      connection_name: snapshotConnectionName(row.snapshot_json),
    });
    let request: unknown;
    try {
      request = JSON.parse(row.request_json);
    } catch {
      request = null;
    }
    let response: unknown = null;
    if (row.response_json !== null) {
      try {
        response = JSON.parse(row.response_json);
      } catch {
        response = null;
      }
    }
    let rawChunks: readonly unknown[] = [];
    if (row.raw_chunks_json !== null) {
      try {
        const parsed = JSON.parse(row.raw_chunks_json);
        rawChunks = Array.isArray(parsed) ? parsed : [];
      } catch {
        rawChunks = [];
      }
    }
    return { attemptId, summary, request, response, rawChunks };
  }

  private connection(): SqliteDatabase {
    if (this.db) return this.db;
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    const db = openSqliteDb(this.dbPath, { schema: ACCOUNTING_SCHEMA_SQL, recovery: 'preserve' });
    try { fs.chmodSync(this.dbPath, 0o600); } catch { /* best effort */ }
    db.pragma('foreign_keys = ON');
    applyAccountingSchemaMigrations(db);
    this.db = db;
    return db;
  }
}

let runtimeStore: ProviderAttemptCaptureStore | null = null;

/**
 * Best-effort access: unlike the attempt ledger (fail-closed), a missing
 * capture store only means no captures — the provider attempt proceeds.
 * Lazily created once so repeated calls share one SQLite connection.
 */
export function getProviderAttemptCaptureStore(): ProviderAttemptCaptureStore | null {
  if (!runtimeStore) runtimeStore = new ProviderAttemptCaptureStore();
  return runtimeStore;
}

export function initializeProviderAttemptCaptureStore(
  options: ProviderAttemptCaptureStoreOptions = {},
): ProviderAttemptCaptureStore {
  runtimeStore?.close();
  runtimeStore = new ProviderAttemptCaptureStore(options);
  return runtimeStore;
}

export function resetProviderAttemptCaptureStore(): void {
  runtimeStore?.close();
  runtimeStore = null;
}
