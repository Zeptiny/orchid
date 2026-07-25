/**
 * Opt-in, non-destructive live provider contract smoke.
 *
 * This file is intentionally executable without the Electron runtime. It only
 * performs read-only metadata/status requests after both the global opt-in and
 * an explicit provider target list are supplied. Credentials are resolved from
 * environment-variable *references*, never printed or written to disk.
 *
 * Example (Lilac's public supply-discount contract):
 *   ORCHID_PROVIDER_LIVE_SMOKE=1 \
 *   ORCHID_PROVIDER_LIVE_SMOKE_PROVIDERS=lilac \
 *   npm run test:providers:live
 *
 * Example (a credentialed read-only Neuralwatt quota contract):
 *   export ORCHID_NEURALWATT_API_KEY_ENV=CI_NEURALWATT_API_KEY
 *   export CI_NEURALWATT_API_KEY=... # never pass the value as a script argument
 *   ORCHID_PROVIDER_LIVE_SMOKE=1 \
 *   ORCHID_PROVIDER_LIVE_SMOKE_PROVIDERS=neuralwatt \
 *   npm run test:providers:live
 */
/* eslint-disable @typescript-eslint/no-require-imports -- Node runs this standalone smoke script as CommonJS. */
const fs = require('node:fs');
const path = require('node:path');

const CATALOG_PATH = path.resolve(__dirname, '../../assets/providers/catalog.json');
const REQUEST_TIMEOUT_MS = 20_000;
const ENVIRONMENT_REFERENCE_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const GENERIC_PROVIDER_IDS = ['generic-openai-compatible', 'generic-anthropic-compatible'];

const MODEL_LIST_PROBES = {
  openai: {
    url: 'https://api.openai.com/v1/models',
    credentialReference: 'ORCHID_OPENAI_API_KEY_ENV',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    credentialReference: 'ORCHID_ANTHROPIC_API_KEY_ENV',
    headers: (key) => ({
      'anthropic-version': '2023-06-01',
      'x-api-key': key,
    }),
  },
  'google-gemini': {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    credentialReference: 'ORCHID_GOOGLE_GEMINI_API_KEY_ENV',
    headers: (key) => ({ 'x-goog-api-key': key }),
  },
  xai: {
    url: 'https://api.x.ai/v1/models',
    credentialReference: 'ORCHID_XAI_API_KEY_ENV',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
  'opencode-go': {
    url: 'https://opencode.ai/zen/go/v1/models',
    credentialReference: 'ORCHID_OPENCODE_GO_API_KEY_ENV',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
};

class SmokeFailure extends Error {}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadCatalog() {
  try {
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    if (!isRecord(catalog) || !Array.isArray(catalog.providers)) {
      throw new SmokeFailure('The bundled provider catalog has no provider list');
    }
    return catalog;
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    throw new SmokeFailure('The bundled provider catalog could not be read');
  }
}

function catalogProvider(catalog, providerId) {
  const provider = catalog.providers.find(
    (candidate) => isRecord(candidate) && candidate.id === providerId,
  );
  if (!provider)
    throw new SmokeFailure(`Provider '${providerId}' is absent from the bundled catalog`);
  return provider;
}

function targetsFromEnvironment() {
  const raw = process.env.ORCHID_PROVIDER_LIVE_SMOKE_PROVIDERS;
  if (!raw) {
    throw new SmokeFailure(
      'Set ORCHID_PROVIDER_LIVE_SMOKE_PROVIDERS to an explicit comma-separated target list (for example, lilac or neuralwatt).',
    );
  }
  const targets = [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (targets.length === 0) throw new SmokeFailure('No live-smoke provider targets were supplied');
  return targets;
}

function credentialFromReference(referenceVariable) {
  const variableName = process.env[referenceVariable];
  if (!variableName || !ENVIRONMENT_REFERENCE_PATTERN.test(variableName)) {
    throw new SmokeFailure(
      `${referenceVariable} must name an environment variable containing this provider's API key.`,
    );
  }
  const value = process.env[variableName];
  if (!value) {
    throw new SmokeFailure(
      `The credential environment variable named by ${referenceVariable} is not available.`,
    );
  }
  return value;
}

async function fetchJson(label, url, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...headers },
        signal: controller.signal,
      });
    } catch {
      throw new SmokeFailure(`${label} read-only contract request failed`);
    }
    if (!response.ok) throw new SmokeFailure(`${label} returned HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new SmokeFailure(`${label} returned invalid JSON`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function assertModelListContract(providerId, payload) {
  if (!isRecord(payload) || (!Array.isArray(payload.data) && !Array.isArray(payload.models))) {
    throw new SmokeFailure(`${providerId} did not return a model-list-shaped response`);
  }
}

async function smokeModelList(providerId) {
  const probe = MODEL_LIST_PROBES[providerId];
  if (!probe) throw new SmokeFailure(`No safe model-list probe is registered for '${providerId}'`);
  const key = credentialFromReference(probe.credentialReference);
  const payload = await fetchJson(`${providerId} model list`, probe.url, probe.headers(key));
  assertModelListContract(providerId, payload);
  console.log(`${providerId}: read-only protocol/auth contract passed.`);
}

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

async function smokeLilac() {
  const payload = await fetchJson(
    'Lilac public status',
    'https://api.getlilac.com/status?window=5m',
    {},
  );
  if (
    !isRecord(payload) ||
    !validTimestamp(payload.current_subscription_supply_updated_at) ||
    !Array.isArray(payload.models)
  ) {
    throw new SmokeFailure(
      'Lilac status did not provide the authoritative subscription-supply timestamp and model list',
    );
  }
  const hasSupplyDiscount = payload.models.some(
    (model) =>
      isRecord(model) &&
      ['low', 'medium', 'high', 'surplus'].includes(model.current_subscription_supply_state) &&
      typeof model.current_subscription_discount_percent === 'number' &&
      Number.isFinite(model.current_subscription_discount_percent) &&
      model.current_subscription_discount_percent >= 0 &&
      model.current_subscription_discount_percent <= 100 &&
      typeof model.current_subscription_credit_multiplier === 'number' &&
      Number.isFinite(model.current_subscription_credit_multiplier) &&
      model.current_subscription_credit_multiplier >= 0,
  );
  if (!hasSupplyDiscount) {
    throw new SmokeFailure(
      'Lilac did not provide authoritative supply state, discount percent, and credit multiplier. Release enablement must remain blocked.',
    );
  }
  console.log('lilac: public supply-discount contract passed.');
}

async function smokeNeuralwatt() {
  const key = credentialFromReference('ORCHID_NEURALWATT_API_KEY_ENV');
  const payload = await fetchJson('Neuralwatt quota', 'https://api.neuralwatt.com/v1/quota', {
    authorization: `Bearer ${key}`,
  });
  const balance = isRecord(payload) ? payload.balance : null;
  if (!isRecord(balance) || !['energy', 'token'].includes(balance.accounting_method)) {
    throw new SmokeFailure('Neuralwatt quota did not return its authoritative accounting method');
  }
  console.log(
    `neuralwatt: read-only quota/accounting contract passed (${balance.accounting_method}).`,
  );
}

async function smokeProvider(catalog, providerId) {
  if (GENERIC_PROVIDER_IDS.includes(providerId)) {
    throw new SmokeFailure(
      `${providerId} is user-endpoint-specific and has no Orchid release-owned live contract probe.`,
    );
  }
  const provider = catalogProvider(catalog, providerId);
  if (provider.lifecycle === 'disabled' || provider.lifecycle === 'retired') {
    throw new SmokeFailure(`${providerId} is not release-enabled in the bundled catalog`);
  }
  if (providerId === 'lilac') return smokeLilac();
  if (providerId === 'neuralwatt') return smokeNeuralwatt();
  return smokeModelList(providerId);
}

async function main() {
  if (process.env.ORCHID_PROVIDER_LIVE_SMOKE !== '1') {
    console.log(
      'Provider live smoke skipped: set ORCHID_PROVIDER_LIVE_SMOKE=1 to permit any provider network request.',
    );
    return;
  }

  const catalog = loadCatalog();
  const targets = targetsFromEnvironment();
  for (const providerId of targets) await smokeProvider(catalog, providerId);
  console.log(`Provider live smoke passed for: ${targets.join(', ')}`);
}

main().catch((error) => {
  // All failures above are deliberately constructed without credential values,
  // response bodies, request URLs containing secrets, or raw provider errors.
  const message = error instanceof SmokeFailure ? error.message : 'unexpected safe smoke failure';
  console.error(`Provider live smoke failed: ${message}`);
  process.exitCode = 1;
});
