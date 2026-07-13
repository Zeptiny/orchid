/**
 * Compatibility stubs for the retired renderer-side provider detector.
 *
 * Provider detection, credential environment lookup, and endpoint discovery
 * must run in the Electron main process. U8 replaces these stubs with
 * connection-centered provider IPC; U1 deliberately exposes no provider
 * information or secret-derived data to the renderer.
 */
export interface DetectedProvider {
  id: string;
  name: string;
  method: 'ollama-endpoint' | 'env-var';
  baseUrl: string;
  litellmProvider: string;
  maskedKey: string | null;
  envVar?: string;
  models: string[];
  detected: boolean;
}

export interface DetectionResult {
  providers: DetectedProvider[];
  errors: string[];
}

/** A renderer must never inspect the value it is asked to redact. */
export function maskApiKey(_key: string): string {
  return 'unavailable';
}

/** Connection discovery is unavailable until it is implemented in main IPC. */
export async function discoverModels(
  _baseUrl: string,
  _apiKey?: string,
): Promise<string[]> {
  return [];
}

/** No provider or environment detection occurs in the renderer. */
export async function detectProviders(): Promise<DetectionResult> {
  return { providers: [], errors: [] };
}

/** Legacy provider aliases can never be constructed from renderer data. */
export function buildProvidersConfig(
  _confirmedProviders: DetectedProvider[],
): Record<string, Record<string, unknown>> {
  return {};
}
