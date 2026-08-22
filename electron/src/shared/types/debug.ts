/**
 * Per-session request debug view types (issue 146).
 *
 * A capture is the raw, exact provider request and response for one durable
 * provider attempt — from any agent origin (main, subagent, compactor, title,
 * permission evaluator, web-fetch summarizer). Captures exist only when the
 * `debug_capture_requests` config gate is enabled; the attempt ledger rows
 * themselves are always written.
 */
import { z } from 'zod';

/** One captured request row in the session debug list. */
export interface DebugRequestSummary {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly providerId: string;
  readonly connectionName: string;
  readonly modelId: string;
  readonly protocol: string;
  readonly agentScope: string | null;
  readonly agentName: string | null;
  readonly agentType: string | null;
  readonly agentTier: string | null;
  readonly outcome: 'pending' | 'succeeded' | 'failed' | 'interrupted';
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly firstTokenAt: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly requestBytes: number | null;
  readonly responseBytes: number | null;
  /** A capture field exceeded the per-field byte cap and was stored truncated. */
  readonly truncated: boolean;
  /** At least one raw provider chunk was captured (includeRawChunks honored). */
  readonly rawAvailable: boolean;
  readonly error: string | null;
}

export interface DebugSessionRequestsResult {
  /** Newest-first summaries within the requested window. */
  readonly requests: readonly DebugRequestSummary[];
  /** Unwindowed capture count for the session ("N of M" in the UI). */
  readonly total: number;
}

/**
 * Full capture for one attempt: the provider-neutral request that was
 * serialized to the API and the response parts in arrival order.
 */
export interface DebugRequestCapture {
  readonly attemptId: string;
  readonly summary: DebugRequestSummary;
  /** Serialized `LanguageModelV4CallOptions` (abort signal and like excluded). */
  readonly request: unknown;
  /**
   * Stream attempts: `{ http, parts }` — response metadata plus normalized
   * stream parts in arrival order. Generate attempts: the full generate
   * result including request/response HTTP bodies.
   */
  readonly response: unknown;
  /** Deserialized raw provider chunks, when the driver emitted them. */
  readonly rawChunks: readonly unknown[];
}

export interface DebugRequestCaptureResult {
  readonly capture: DebugRequestCapture | null;
}

// ── Preload boundary validation ───────────────────────────────────────────────

/**
 * Invoke-result schemas for the debug IPC channels. The request/response/
 * rawChunks payloads are intentionally opaque (`z.unknown()`): captures exist
 * to preserve exact provider payloads, so only the envelope is validated.
 */
export const debugRequestSummarySchema = z.object({
  attemptId: z.string(),
  sessionId: z.string(),
  chainId: z.string().nullable(),
  turnId: z.string().nullable(),
  providerId: z.string(),
  connectionName: z.string(),
  modelId: z.string(),
  protocol: z.string(),
  agentScope: z.string().nullable(),
  agentName: z.string().nullable(),
  agentType: z.string().nullable(),
  agentTier: z.string().nullable(),
  outcome: z.enum(['pending', 'succeeded', 'failed', 'interrupted']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  firstTokenAt: z.string().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  requestBytes: z.number().nullable(),
  responseBytes: z.number().nullable(),
  truncated: z.boolean(),
  rawAvailable: z.boolean(),
  error: z.string().nullable(),
});

export const debugSessionRequestsResultSchema = z.object({
  requests: z.array(debugRequestSummarySchema),
});

export const debugRequestCaptureSchema = z.object({
  attemptId: z.string(),
  summary: debugRequestSummarySchema,
  request: z.unknown(),
  response: z.unknown(),
  rawChunks: z.array(z.unknown()),
});

export const debugRequestCaptureResultSchema = z.object({
  capture: debugRequestCaptureSchema.nullable(),
});
