/**
 * Deterministically normalize a pinned models.dev capture into Orchid's
 * data-only catalog shape. This is an operator tool, never an app runtime
 * dependency: pass --input for a reviewed snapshot in release automation.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MODELS_DEV_URL = 'https://models.dev/api.json';
const DEFAULT_OUTPUT = path.resolve(__dirname, '../../assets/providers/catalog.json');

const PROVIDERS = [
  { sourceId: 'openai', id: 'openai', protocol: 'openai-compatible', auth: ['api-key', 'environment'] },
  { sourceId: 'anthropic', id: 'anthropic', protocol: 'anthropic-messages', auth: ['api-key', 'environment'] },
  { sourceId: 'google', id: 'google-gemini', protocol: 'google-generative-ai', auth: ['api-key', 'environment'] },
  { sourceId: 'xai', id: 'xai', protocol: 'xai', auth: ['api-key', 'environment'] },
  { sourceId: 'opencode-go', id: 'opencode-go', protocol: 'openai-compatible', auth: ['api-key', 'environment'] },
  { sourceId: 'lilac', id: 'lilac', protocol: 'openai-compatible', auth: ['api-key', 'environment'] },
  { sourceId: 'neuralwatt', id: 'neuralwatt', protocol: 'openai-compatible', auth: ['api-key', 'environment'] },
];

/** Generic providers are Orchid-owned definitions, not models.dev providers. */
const GENERIC_PROVIDERS = [
  {
    id: 'generic-openai-compatible',
    displayName: 'Generic OpenAI-compatible',
    supportedAuthMethods: ['api-key', 'environment', 'none'],
    supportedProtocols: ['openai-compatible'],
  },
  {
    id: 'generic-anthropic-compatible',
    displayName: 'Generic Anthropic-compatible',
    supportedAuthMethods: ['api-key', 'environment', 'none'],
    supportedProtocols: ['anthropic-messages'],
  },
];

const SUPPORTED_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'pdf', 'embedding']);

/**
 * Keep model roles that Orchid can use today. Media-generation and mixed
 * output models are intentionally excluded; embedding models remain available
 * to the RAG surface rather than being presented as chat models.
 */
function isUsefulModel(model: any): boolean {
  const output = model.modalities?.output;
  if (output === undefined) return true;
  return Array.isArray(output)
    && output.length > 0
    && (output.every((value: unknown) => value === 'text')
      || output.every((value: unknown) => value === 'embedding'));
}

function normalizeModalities(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) return fallback;
  const modalities = value.filter((item: unknown): item is string =>
    typeof item === 'string' && SUPPORTED_MODALITIES.has(item),
  );
  return modalities.length > 0 ? modalities : fallback;
}

function getOption(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function decimal(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return String(value);
}

function rate(value: unknown) {
  const amount = decimal(value);
  return amount === undefined ? undefined : { amount, per: 1000000, unit: 'tokens' };
}

function modelToCatalog(model: any, protocol: string, observedAt: string) {
  const cost = model.cost ?? {};
  const rates: Record<string, unknown> = {};
  const dimensions: Array<[string, string]> = [
    ['input', 'input'],
    ['output', 'output'],
    ['cacheRead', 'cache_read'],
    ['cacheWrite', 'cache_write'],
    ['reasoning', 'reasoning'],
  ];
  for (const [target, source] of dimensions) {
    const normalized = rate(cost[source]);
    if (normalized) rates[target] = normalized;
  }

  const modalities = model.modalities ?? {};
  const input = normalizeModalities(modalities.input, ['text']);
  const output = normalizeModalities(modalities.output, ['text']);

  return {
    id: String(model.id),
    displayName: String(model.name ?? model.id),
    protocol,
    capabilities: {
      inputModalities: input.length > 0 ? input : ['text'],
      outputModalities: output.length > 0 ? output : ['text'],
      tools: Boolean(model.tool_call),
      reasoning: Boolean(model.reasoning),
    },
    limits: {
      contextTokens: Number.isInteger(model.limit?.context) && model.limit.context > 0 ? model.limit.context : null,
      outputTokens: Number.isInteger(model.limit?.output) && model.limit.output > 0 ? model.limit.output : null,
    },
    lifecycle: model.status === 'deprecated' ? 'deprecated' : 'active',
    pricing: {
      currency: 'USD',
      effectiveAt: observedAt,
      rates,
      provenance: { source: 'models.dev', observedAt },
    },
    provenance: { source: 'models.dev', observedAt },
  };
}

function normalize(snapshot: Record<string, any>, rawBytes: Buffer, capturedAt: string) {
  return {
    schemaVersion: 1,
    catalogVersion: Number(getOption('--catalog-version') ?? '1'),
    issuedAt: capturedAt,
    expiresAt: getOption('--expires-at') ?? '2027-01-01T00:00:00.000Z',
    compatibleApp: {
      minimum: getOption('--minimum-app-version') ?? '0.1.0',
    },
    provenance: {
      source: 'models.dev',
      sourceUrl: MODELS_DEV_URL,
      capturedAt,
      contentHash: `sha256:${createHash('sha256').update(rawBytes).digest('hex')}`,
    },
    providers: [
      ...PROVIDERS.flatMap((definition) => {
        const provider = snapshot[definition.sourceId];
        if (!provider || typeof provider.models !== 'object') return [];
        const models = Object.values(provider.models)
          .filter((model: any) =>
            model
            && typeof model.id === 'string'
            && model.id.trim()
            && isUsefulModel(model),
          )
          .map((model: any) => modelToCatalog(model, definition.protocol, capturedAt))
          .sort((a: any, b: any) => a.id.localeCompare(b.id));
        return [{
          id: definition.id,
          displayName: String(provider.name ?? definition.id),
          supportedAuthMethods: definition.auth,
          supportedProtocols: [definition.protocol],
          allowsCustomModels: true,
          lifecycle: 'active',
          provenance: { source: 'models.dev', observedAt: capturedAt },
          models,
        }];
      }),
      ...GENERIC_PROVIDERS.map((definition) => ({
        ...definition,
        allowsCustomModels: true,
        lifecycle: 'active',
        provenance: { source: 'catalog', observedAt: capturedAt },
        models: [],
      })),
    ],
  };
}

async function main() {
  const inputPath = getOption('--input');
  const outputPath = path.resolve(getOption('--output') ?? DEFAULT_OUTPUT);
  const capturedAt = getOption('--captured-at') ?? new Date().toISOString();
  const rawBytes = inputPath
    ? fs.readFileSync(path.resolve(inputPath))
    : Buffer.from(await (await fetch(MODELS_DEV_URL, { redirect: 'error' })).arrayBuffer());
  const snapshot = JSON.parse(rawBytes.toString('utf8'));
  const catalog = normalize(snapshot, rawBytes, capturedAt);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote ${catalog.providers.length} providers to ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
