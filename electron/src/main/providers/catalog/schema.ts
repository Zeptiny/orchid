import { z } from 'zod';
import {
  providerAuthMethodSchema,
  providerDefinitionSchema,
  providerProtocolSchema,
  reasoningModelConfigSchema,
  type ProviderDefinition,
} from '../../../shared/types/provider';
import {
  cacheFacetSchema,
  currencyUnitSchema,
  priceRateSchema,
  pricingContextTierSchema,
  pricingRateFieldsSchema,
  thinkingPolicySchema,
  tierMechanismSchema,
} from '../../../shared/types/provider-facets';

/** The first Orchid-owned, data-only catalog format. */
export const CATALOG_SCHEMA_VERSION = 1;

const nonEmptyString = z.string().trim().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });
const semanticVersionSchema = z.string().regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  'Expected a semantic version such as 1.2.3',
);
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/, 'Expected a sha256 content hash');

const provenanceSourceSchema = z.enum([
  'catalog',
  'models.dev',
  'provider',
  'user',
]);

/** Provenance is retained at the catalog field boundary, never inferred later. */
export const catalogFieldProvenanceSchema = z.object({
  source: provenanceSourceSchema,
  observedAt: isoTimestampSchema.optional(),
  sourceUrl: z.string().url().optional(),
}).strict();

export const catalogProvenanceSchema = z.object({
  source: z.enum(['models.dev', 'orchid-catalog']),
  sourceUrl: z.string().url(),
  capturedAt: isoTimestampSchema,
  contentHash: sha256Schema,
}).strict();

const modalitySchema = z.enum(['text', 'image', 'audio', 'video', 'pdf', 'embedding']);
const lifecycleSchema = z.enum(['active', 'preview', 'deprecated', 'disabled', 'retired']);

export const catalogPriceRateSchema = priceRateSchema;

/**
 * Facet kinds a catalog may declare as data. Declaring a kind is gated again
 * by the trusted policy list; undeclared keys fail the strict schema.
 */
export const catalogFacetsSchema = z.object({
  thinking: thinkingPolicySchema.optional(),
  tiers: tierMechanismSchema.optional(),
  cache: cacheFacetSchema.optional(),
}).strict();

export type CatalogFacets = z.infer<typeof catalogFacetsSchema>;
export type CatalogFacetKind = keyof CatalogFacets;

export const catalogPricingSchema = z.object({
  /** Cost-bucketing code: the ISO-4217 code for fiat, the native unit otherwise. */
  currency: z.string().trim().min(1).max(24),
  /** Typed unit declaration; required whenever the currency is non-fiat (R8). */
  currencyUnit: currencyUnitSchema.optional(),
  effectiveAt: isoTimestampSchema,
  rates: pricingRateFieldsSchema,
  contextTiers: z.array(pricingContextTierSchema).optional(),
  provenance: catalogFieldProvenanceSchema,
}).strict().superRefine((pricing, ctx) => {
  const unit = pricing.currencyUnit;
  if (!unit) {
    if (!/^[A-Z]{3}$/.test(pricing.currency)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A non-fiat currency requires a currencyUnit declaration',
        path: ['currency'],
      });
    }
    return;
  }
  const expected = unit.kind === 'fiat' ? unit.code : unit.unit;
  if (pricing.currency !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Currency '${pricing.currency}' does not match the declared currencyUnit '${expected}'`,
      path: ['currency'],
    });
  }
});

export const catalogModelSchema = z.object({
  /** Opaque provider model ID. It may legally contain `/`. */
  id: nonEmptyString,
  displayName: nonEmptyString,
  protocol: providerProtocolSchema,
  capabilities: z.object({
    inputModalities: z.array(modalitySchema).min(1),
    outputModalities: z.array(modalitySchema).min(1),
    tools: z.boolean(),
    reasoning: z.boolean(),
  }).strict(),
  limits: z.object({
    contextTokens: z.number().int().positive().nullable(),
    outputTokens: z.number().int().positive().nullable(),
  }).strict(),
  lifecycle: lifecycleSchema,
  pricing: catalogPricingSchema,
  provenance: catalogFieldProvenanceSchema,
  reasoningLevels: reasoningModelConfigSchema.shape.levels.optional(),
  reasoningDefault: reasoningModelConfigSchema.shape.default.optional(),
  facets: catalogFacetsSchema.optional(),
}).strict();

export const catalogProviderSchema = z.object({
  id: nonEmptyString,
  displayName: nonEmptyString,
  /** These are declarative capabilities, constrained again by trusted code. */
  supportedAuthMethods: z.array(providerAuthMethodSchema).min(1),
  supportedProtocols: z.array(providerProtocolSchema).min(1),
  allowsCustomModels: z.boolean(),
  lifecycle: lifecycleSchema,
  provenance: catalogFieldProvenanceSchema,
  facets: catalogFacetsSchema.optional(),
  models: z.array(catalogModelSchema),
}).strict().superRefine((provider, ctx) => {
  const modelIds = new Set<string>();
  provider.models.forEach((model, index) => {
    if (modelIds.has(model.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate model id '${model.id}' for provider '${provider.id}'`,
        path: ['models', index, 'id'],
      });
    }
    modelIds.add(model.id);
  });
});

/**
 * The envelope is deliberately strict. There is no driver module, endpoint,
 * OAuth issuer, callback URL, or credential destination field for remote data
 * to influence.
 */
export const catalogEnvelopeSchema = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  catalogVersion: z.number().int().positive(),
  issuedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  compatibleApp: z.object({
    minimum: semanticVersionSchema,
    maximum: semanticVersionSchema.optional(),
  }).strict(),
  provenance: catalogProvenanceSchema,
  providers: z.array(catalogProviderSchema),
}).strict().superRefine((catalog, ctx) => {
  if (Date.parse(catalog.expiresAt) <= Date.parse(catalog.issuedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Catalog expiry must be after issuance',
      path: ['expiresAt'],
    });
  }

  const providerIds = new Set<string>();
  catalog.providers.forEach((provider, index) => {
    if (providerIds.has(provider.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate provider id '${provider.id}'`,
        path: ['providers', index, 'id'],
      });
    }
    providerIds.add(provider.id);
  });
});

export type CatalogFieldProvenance = z.infer<typeof catalogFieldProvenanceSchema>;
export type CatalogPricing = z.infer<typeof catalogPricingSchema>;
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type CatalogProvider = z.infer<typeof catalogProviderSchema>;
export type ProviderCatalog = z.infer<typeof catalogEnvelopeSchema>;

/**
 * U1 intentionally has a compact provider definition. This adapter lets later
 * resolver/driver work consume catalog metadata without changing U1's stored
 * connection contract.
 */
export function catalogToProviderDefinitions(
  catalog: ProviderCatalog,
): readonly ProviderDefinition[] {
  return catalog.providers.map((provider) => providerDefinitionSchema.parse({
    id: provider.id,
    displayName: provider.displayName,
    supportedAuthMethods: provider.supportedAuthMethods,
    supportedProtocols: provider.supportedProtocols,
    allowsCustomModels: provider.allowsCustomModels,
    lifecycle: provider.lifecycle,
    models: provider.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      protocol: model.protocol,
      capabilities: model.capabilities,
      limits: model.limits,
      lifecycle: model.lifecycle,
    })),
  }));
}
