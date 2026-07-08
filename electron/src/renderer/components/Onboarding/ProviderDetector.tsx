/**
 * ProviderDetector — scans for available LLM providers.
 *
 * Checks:
 * - Ollama running at localhost:11434
 * - Environment variables: OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.
 *
 * Returns detected providers with masked API key tails.
 * Actual keychain integration comes in U25; this reads env vars only.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface DetectedProvider {
  /** Unique ID for this provider (e.g. "ollama", "openai"). */
  id: string;
  /** Display name (e.g. "Ollama", "OpenAI"). */
  name: string;
  /** Detection method: "ollama-endpoint" | "env-var". */
  method: 'ollama-endpoint' | 'env-var';
  /** Base URL for the provider. */
  baseUrl: string;
  /** Litellm-compatible provider name. */
  litellmProvider: string;
  /** Masked API key (last 4 chars) or null if not applicable. */
  maskedKey: string | null;
  /** Environment variable name (if detected via env var). */
  envVar?: string;
  /** Available models (populated after detection). */
  models: string[];
  /** Whether the provider was successfully detected. */
  detected: boolean;
}

export interface DetectionResult {
  providers: DetectedProvider[];
  errors: string[];
}

// ── Known provider env vars ──────────────────────────────────────────────────

const PROVIDER_ENV_MAP: Array<{
  id: string;
  name: string;
  envVar: string;
  baseUrl: string;
  litellmProvider: string;
  defaultModels: string[];
}> = [
  {
    id: 'openai',
    name: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    litellmProvider: 'openai',
    defaultModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
    litellmProvider: 'anthropic',
    defaultModels: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
  },
  {
    id: 'google',
    name: 'Google AI',
    envVar: 'GOOGLE_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    litellmProvider: 'gemini',
    defaultModels: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  },
  {
    id: 'groq',
    name: 'Groq',
    envVar: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    litellmProvider: 'groq',
    defaultModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    envVar: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    litellmProvider: 'mistral',
    defaultModels: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
  },
];

// ── Detection functions ──────────────────────────────────────────────────────

/**
 * Mask an API key: show only the last 4 characters.
 * Example: "sk-abc123def456" -> "********456"
 */
export function maskApiKey(key: string): string {
  if (key.length <= 4) return '****';
  const tail = key.slice(-4);
  return `${'*'.repeat(Math.min(8, key.length - 4))}${tail}`;
}

/**
 * Check if Ollama is running at localhost:11434.
 * Returns available models if detected.
 */
async function detectOllama(): Promise<DetectedProvider> {
  const provider: DetectedProvider = {
    id: 'ollama',
    name: 'Ollama (Local)',
    method: 'ollama-endpoint',
    baseUrl: 'http://localhost:11434',
    litellmProvider: 'ollama',
    maskedKey: null,
    models: [],
    detected: false,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch('http://localhost:11434/api/tags', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      provider.detected = true;
      provider.models = (data.models ?? []).map((m) => m.name);
    }
  } catch {
    // Ollama not running — not an error, just not detected
  }

  return provider;
}

/**
 * Check environment variables for API keys.
 */
function detectEnvVarProviders(): DetectedProvider[] {
  const results: DetectedProvider[] = [];

  for (const spec of PROVIDER_ENV_MAP) {
    const key = typeof process !== 'undefined'
      ? process.env?.[spec.envVar]
      : undefined;

    const provider: DetectedProvider = {
      id: spec.id,
      name: spec.name,
      method: 'env-var',
      baseUrl: spec.baseUrl,
      litellmProvider: spec.litellmProvider,
      maskedKey: key ? maskApiKey(key) : null,
      envVar: spec.envVar,
      models: [...spec.defaultModels],
      detected: !!key,
    };

    results.push(provider);
  }

  return results;
}

/**
 * Discover available models from a provider via its /models endpoint.
 * Returns model IDs or empty array if discovery fails.
 */
export async function discoverModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${baseUrl}/models`, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      const data = (await response.json()) as {
        data?: Array<{ id: string }>;
      };
      return (data.data ?? []).map((m) => m.id);
    }
  } catch {
    // Discovery failed — non-fatal
  }

  return [];
}

/**
 * Run full provider detection scan.
 * Scans for Ollama and checks environment variables.
 */
export async function detectProviders(): Promise<DetectionResult> {
  const errors: string[] = [];

  // Run Ollama detection and env var detection in parallel
  const [ollama, envProviders] = await Promise.all([
    detectOllama(),
    Promise.resolve(detectEnvVarProviders()),
  ]);

  const providers: DetectedProvider[] = [ollama, ...envProviders];

  return { providers, errors };
}

/**
 * Build a providers config dict from confirmed detected providers.
 * Suitable for merging into the config's `providers` field.
 */
export function buildProvidersConfig(
  confirmedProviders: DetectedProvider[],
): Record<string, Record<string, unknown>> {
  const config: Record<string, Record<string, unknown>> = {};

  for (const provider of confirmedProviders) {
    if (!provider.detected) continue;

    const models: Record<string, unknown> = {};
    for (const model of provider.models) {
      models[model] = {};
    }

    config[provider.id] = {
      base_url: provider.baseUrl,
      litellm_provider: provider.litellmProvider,
      models,
    };
  }

  return config;
}
