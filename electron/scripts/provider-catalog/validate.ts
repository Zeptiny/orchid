/** Validate catalog structure and reject executable/credential-routing fields. */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CATALOG = path.resolve(__dirname, '../../assets/providers/catalog.json');
const FORBIDDEN_REMOTE_FIELDS = new Set([
  'driver', 'module', 'import', 'endpoint', 'baseUrl', 'oauthIssuer',
  'callbackUrl', 'credentialDestination', 'authorizationUrl', 'tokenUrl',
]);

function getOption(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNoExecutableFields(value: unknown, pathLabel = 'catalog') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoExecutableFields(entry, `${pathLabel}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_REMOTE_FIELDS.has(key)) {
      throw new Error(`${pathLabel}.${key} is forbidden in a data-only catalog`);
    }
    assertNoExecutableFields(nested, `${pathLabel}.${key}`);
  }
}

function assertUnique(items: unknown[], id: string, label: string) {
  const seen = new Set<string>();
  for (const item of items) {
    assertObject(item, label);
    const value = item[id];
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}.${id} is required`);
    if (seen.has(value)) throw new Error(`Duplicate ${label} ${id} '${value}'`);
    seen.add(value);
  }
}

function main() {
  const catalogPath = path.resolve(getOption('--catalog') ?? DEFAULT_CATALOG);
  const raw = fs.readFileSync(catalogPath, 'utf8');
  const catalog = JSON.parse(raw);
  assertObject(catalog, 'catalog');
  if (catalog.schemaVersion !== 1) throw new Error('catalog.schemaVersion must be 1');
  if (!Number.isInteger(catalog.catalogVersion) || catalog.catalogVersion <= 0) {
    throw new Error('catalog.catalogVersion must be a positive integer');
  }
  if (!Array.isArray(catalog.providers)) throw new Error('catalog.providers must be an array');
  assertUnique(catalog.providers, 'id', 'provider');
  for (const provider of catalog.providers) {
    assertObject(provider, 'provider');
    if (!Array.isArray(provider.models)) throw new Error(`provider '${provider.id}' must have models`);
    assertUnique(provider.models, 'id', `model for '${provider.id}'`);
  }
  assertNoExecutableFields(catalog);
  console.log(`Catalog ${catalog.catalogVersion} is structurally valid (${catalog.providers.length} providers).`);
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
