import { verify } from 'node:crypto';
import {
  catalogEnvelopeSchema,
  type ProviderCatalog,
} from './schema';
import type { ProviderAuthMethod, ProviderProtocol } from '../../../shared/types/provider';

/** Hard limit before JSON parsing or signature work can consume unbounded memory. */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export const MAX_CATALOG_SIGNATURE_BYTES = 16 * 1024;

/** A release bundles public verification keys only. Private keys never enter this type. */
export type CatalogKeyring = Readonly<Record<string, string>>;

export interface TrustedCatalogProviderPolicy {
  readonly id: string;
  readonly authMethods: readonly ProviderAuthMethod[];
  readonly protocols: readonly ProviderProtocol[];
  readonly allowsCustomModels: boolean;
}

/**
 * The catalog may only describe drivers that are present in trusted app code.
 * U4 owns their executable implementations; this table establishes the
 * conservative catalog boundary first.
 */
export const TRUSTED_CATALOG_PROVIDER_POLICIES: readonly TrustedCatalogProviderPolicy[] = [
  { id: 'openai', authMethods: ['api-key', 'environment'], protocols: ['openai-compatible'], allowsCustomModels: false },
  { id: 'anthropic', authMethods: ['api-key', 'environment'], protocols: ['anthropic-messages'], allowsCustomModels: false },
  { id: 'google-gemini', authMethods: ['api-key', 'environment'], protocols: ['google-generative-ai'], allowsCustomModels: false },
  { id: 'xai', authMethods: ['api-key', 'environment'], protocols: ['xai'], allowsCustomModels: false },
  { id: 'opencode-go', authMethods: ['api-key', 'environment'], protocols: ['openai-compatible', 'anthropic-messages'], allowsCustomModels: false },
  { id: 'lilac', authMethods: ['api-key', 'environment'], protocols: ['openai-compatible'], allowsCustomModels: false },
  { id: 'neuralwatt', authMethods: ['api-key', 'environment'], protocols: ['openai-compatible'], allowsCustomModels: false },
  { id: 'generic-openai-compatible', authMethods: ['api-key', 'environment', 'none'], protocols: ['openai-compatible'], allowsCustomModels: true },
  { id: 'generic-anthropic-compatible', authMethods: ['api-key', 'environment', 'none'], protocols: ['anthropic-messages'], allowsCustomModels: true },
];

export class CatalogTrustError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CatalogTrustError';
  }
}

export interface CatalogValidationOptions {
  readonly appVersion: string;
  readonly now?: Date;
  /** Recovery reads may retain an expired verified catalog, marked stale. */
  readonly allowExpired?: boolean;
  readonly policies?: readonly TrustedCatalogProviderPolicy[];
}

export interface SignedCatalogValidationInput extends CatalogValidationOptions {
  readonly bytes: Uint8Array;
  readonly signature: Uint8Array;
  readonly keyId: string;
  readonly keyring: CatalogKeyring;
}

export interface ValidatedCatalog {
  readonly catalog: ProviderCatalog;
  /** Exact bytes that were verified. Never stringify the parsed object to verify. */
  readonly bytes: Buffer;
  readonly stale: boolean;
}

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | null;
}

function parseSemver(value: string): ParsedSemver {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) throw new CatalogTrustError(`Invalid semantic version '${value}'`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

export function isCatalogExpired(catalog: ProviderCatalog, now = new Date()): boolean {
  return Date.parse(catalog.expiresAt) <= now.getTime();
}

function validateCompatibility(catalog: ProviderCatalog, appVersion: string): void {
  if (compareSemver(appVersion, catalog.compatibleApp.minimum) < 0) {
    throw new CatalogTrustError(
      `Catalog requires app version ${catalog.compatibleApp.minimum} or newer`,
    );
  }
  if (catalog.compatibleApp.maximum
    && compareSemver(appVersion, catalog.compatibleApp.maximum) > 0) {
    throw new CatalogTrustError(
      `Catalog is not compatible with app version ${appVersion}`,
    );
  }
}

/** Enforce the data-only boundary after structural validation. */
export function validateTrustedProviderDeclarations(
  catalog: ProviderCatalog,
  policies: readonly TrustedCatalogProviderPolicy[] = TRUSTED_CATALOG_PROVIDER_POLICIES,
): void {
  const policyById = new Map(policies.map((policy) => [policy.id, policy]));
  for (const provider of catalog.providers) {
    const policy = policyById.get(provider.id);
    if (!policy) {
      throw new CatalogTrustError(
        `Catalog introduces untrusted driver '${provider.id}'`,
      );
    }
    if (provider.allowsCustomModels !== policy.allowsCustomModels) {
      throw new CatalogTrustError(
        `Catalog may not change custom-model behavior for '${provider.id}'`,
      );
    }
    for (const authMethod of provider.supportedAuthMethods) {
      if (!policy.authMethods.includes(authMethod)) {
        throw new CatalogTrustError(
          `Catalog declares unsupported auth method '${authMethod}' for '${provider.id}'`,
        );
      }
    }
    for (const protocol of provider.supportedProtocols) {
      if (!policy.protocols.includes(protocol)) {
        throw new CatalogTrustError(
          `Catalog declares unsupported protocol '${protocol}' for '${provider.id}'`,
        );
      }
    }
    for (const model of provider.models) {
      if (!provider.supportedProtocols.includes(model.protocol)
        || !policy.protocols.includes(model.protocol)) {
        throw new CatalogTrustError(
          `Catalog model '${provider.id}/${model.id}' uses an unsupported protocol`,
        );
      }
    }
  }
}

function parseCatalogBytes(bytes: Uint8Array): ProviderCatalog {
  if (bytes.byteLength > MAX_CATALOG_BYTES) {
    throw new CatalogTrustError(`Catalog exceeds ${MAX_CATALOG_BYTES} byte limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new CatalogTrustError('Catalog is not valid UTF-8 JSON', { cause: error });
  }
  try {
    return catalogEnvelopeSchema.parse(value);
  } catch (error) {
    throw new CatalogTrustError('Catalog schema validation failed', { cause: error });
  }
}

/** Validate a bundled catalog, whose bytes are protected by the app bundle. */
export function validateCatalogBytes(
  bytes: Uint8Array,
  options: CatalogValidationOptions,
): ValidatedCatalog {
  const catalog = parseCatalogBytes(bytes);
  validateCompatibility(catalog, options.appVersion);
  validateTrustedProviderDeclarations(catalog, options.policies);
  const stale = isCatalogExpired(catalog, options.now);
  if (stale && !options.allowExpired) {
    throw new CatalogTrustError(`Catalog version ${catalog.catalogVersion} has expired`);
  }
  return { catalog, bytes: Buffer.from(bytes), stale };
}

/**
 * Verify a detached Ed25519 signature over the exact downloaded UTF-8 bytes,
 * then parse and apply all catalog policy checks.
 */
export function validateSignedCatalog(input: SignedCatalogValidationInput): ValidatedCatalog {
  if (input.signature.byteLength > MAX_CATALOG_SIGNATURE_BYTES) {
    throw new CatalogTrustError('Catalog signature exceeds size limit');
  }
  if (input.bytes.byteLength > MAX_CATALOG_BYTES) {
    throw new CatalogTrustError(`Catalog exceeds ${MAX_CATALOG_BYTES} byte limit`);
  }

  const publicKey = input.keyring[input.keyId];
  if (!publicKey) {
    throw new CatalogTrustError(`Catalog signature uses unknown key '${input.keyId}'`);
  }

  let signatureValid: boolean;
  try {
    signatureValid = verify(
      null,
      Buffer.from(input.bytes),
      publicKey,
      Buffer.from(input.signature),
    );
  } catch (error) {
    throw new CatalogTrustError('Catalog signature could not be verified', { cause: error });
  }
  if (!signatureValid) throw new CatalogTrustError('Catalog signature is invalid');

  return validateCatalogBytes(input.bytes, input);
}
