/**
 * Shared plumbing for OpenAI-style `GET /models` discovery endpoints. Drivers
 * own their URLs and metadata parsing; this helper owns transport, timeouts,
 * and the tolerant `{ data: [{ id, ... }] }` envelope walk (R26, R27).
 */
import { parseRetryAfter, StatusRefreshError } from '../status/service';

export const MODELS_ENDPOINT_REQUEST_TIMEOUT_MS = 15_000;

export interface FetchModelsEndpointOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Fetch one models endpoint with the connection credential, never logged. */
export async function fetchModelsEndpoint(
  url: string,
  apiKey: string | undefined,
  providerLabel: string,
  options: FetchModelsEndpointOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? MODELS_ENDPOINT_REQUEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    signal,
  });
  if (!response.ok) {
    throw new StatusRefreshError(`${providerLabel} models request failed with HTTP ${response.status}`, {
      statusCode: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    });
  }
  try {
    return await response.json();
  } catch {
    throw new StatusRefreshError(`${providerLabel} models response was not valid JSON`, { kind: 'schema' });
  }
}

export function recordEntries(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Extract unique model entries from an OpenAI-style list payload. Entries
 * without a usable id are skipped rather than failing the whole fetch.
 */
export function modelsListEntries(
  payload: unknown,
  providerLabel: string,
): readonly Record<string, unknown>[] {
  const root = recordEntries(payload);
  const data = root?.['data'];
  if (!root || !Array.isArray(data)) {
    throw new StatusRefreshError(`${providerLabel} models response has no data array`, { kind: 'schema' });
  }
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const entry = recordEntries(item);
    const id = entry?.['id'];
    if (!entry || typeof id !== 'string' || id.trim() === '' || seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
  }
  return entries;
}
