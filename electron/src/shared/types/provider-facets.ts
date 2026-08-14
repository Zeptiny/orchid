import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });
const decimalStringSchema = z.string().regex(
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/,
  'Expected a non-negative decimal string',
);

// ── Currency units (R8) ─────────────────────────────────────────────────────

export const fiatCurrencyCodeSchema = z.string().regex(
  /^[A-Z]{3}$/,
  'Expected an ISO-4217 currency code',
);

/**
 * Billing units generalize beyond ISO fiat. Non-fiat units (e.g. kWh) render
 * natively in usage, quota, and analytics and are never force-converted.
 */
export const currencyUnitSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fiat'),
    code: fiatCurrencyCodeSchema,
  }).strict(),
  z.object({
    kind: z.literal('non-fiat'),
    /** Provider-native unit label, for example 'kWh'. */
    unit: nonEmptyString.max(24),
    displayName: nonEmptyString.max(64).optional(),
  }).strict(),
]);

export type CurrencyUnit = z.infer<typeof currencyUnitSchema>;

// ── Pricing rate dimensions (R9) ────────────────────────────────────────────

export const priceRateSchema = z.object({
  /** Exact decimal amount in the parent currency. */
  amount: decimalStringSchema,
  /** Denominator for the rate, for example 1_000_000 tokens. */
  per: z.number().int().positive(),
  unit: z.enum(['tokens', 'requests', 'characters', 'energy']),
}).strict();

export type PriceRate = z.infer<typeof priceRateSchema>;

/**
 * TTL labels key cache-write rate variants and driver TTL options: '5m', '1h'.
 * Responses-protocol providers also expose retention hints as the same knob
 * (Meta `prompt_cache_retention`: 'in_memory' | '24h'), so retention labels
 * are accepted alongside duration labels.
 */
export const cacheTtlLabelSchema = z.string().regex(
  /^(?:\d+[smhd]|in_memory)$/,
  'Expected a TTL label such as 5m or 1h, or a retention label such as in_memory',
);

export const pricingRateFieldsSchema = z.object({
  input: priceRateSchema.optional(),
  output: priceRateSchema.optional(),
  cacheRead: priceRateSchema.optional(),
  /** Cache-write rate at the provider's default TTL. */
  cacheWrite: priceRateSchema.optional(),
  /** Cache-write rates for non-default TTLs, keyed by TTL label. */
  cacheWriteByTtl: z.record(cacheTtlLabelSchema, priceRateSchema).optional(),
  reasoning: priceRateSchema.optional(),
  /** Flat fee charged per request, independent of token usage. */
  perRequest: priceRateSchema.optional(),
  /** Native energy rate (unit 'energy'), for example the price per kWh. */
  energy: priceRateSchema.optional(),
}).strict();

export type PricingRateFields = z.infer<typeof pricingRateFieldsSchema>;

export const pricingContextTierSchema = z.object({
  /** The tier begins when context exceeds this many input tokens. */
  overContextTokens: z.number().int().nonnegative(),
  rates: pricingRateFieldsSchema,
}).strict();

export type PricingContextTier = z.infer<typeof pricingContextTierSchema>;

/**
 * Typed evidence for a driver-applied rate adjustment, for example a live
 * subscription multiplier composed over the provider's base rates (R4).
 */
export const pricingRateAdjustmentSchema = z.object({
  /** Machine-readable adjustment kind, for example 'subscription-multiplier'. */
  kind: nonEmptyString,
  /** Multiplier the driver applied to the base rates, as decimal text. */
  multiplier: decimalStringSchema,
  /** Provider-disclosed discount percentage accompanying the multiplier. */
  discountPercent: z.number().nonnegative().optional(),
  /** Provider source timestamp for the adjusted pricing data. */
  providerUpdatedAt: isoTimestampSchema.nullable().optional(),
  /** Provider source timestamp for the underlying supply/subscription state. */
  supplyUpdatedAt: isoTimestampSchema.nullable().optional(),
}).strict();

export type PricingRateAdjustment = z.infer<typeof pricingRateAdjustmentSchema>;

/** One model's rates as returned by a provider pricing API (R7). */
export const providerRateCardSchema = z.object({
  currencyUnit: currencyUnitSchema,
  observedAt: isoTimestampSchema,
  rates: pricingRateFieldsSchema,
  contextTiers: z.array(pricingContextTierSchema).optional(),
  /** Typed adjustment evidence when the driver composed the rates (R4). */
  adjustment: pricingRateAdjustmentSchema.optional(),
}).strict();

export type ProviderRateCard = z.infer<typeof providerRateCardSchema>;

export const providerModelRateCardSchema = providerRateCardSchema.extend({
  modelId: nonEmptyString,
}).strict();

export type ProviderModelRateCard = z.infer<typeof providerModelRateCardSchema>;

// ── Thinking facet (R15) ────────────────────────────────────────────────────

export const thinkingExposureSchema = z.enum(['readable', 'summary', 'opaque', 'none']);

export type ThinkingExposure = z.infer<typeof thinkingExposureSchema>;

export const thinkingReplayRuleSchema = z.enum([
  'mandatory-in-tool-loop',
  'recommended',
  'impossible',
]);

export type ThinkingReplayRule = z.infer<typeof thinkingReplayRuleSchema>;

/** User-configurable thinking options are limited to what the driver declares. */
export const thinkingRequestKnobsSchema = z.object({
  displayModes: z.array(nonEmptyString).min(1).optional(),
  defaultDisplayMode: nonEmptyString.optional(),
  summaryProfiles: z.array(nonEmptyString).min(1).optional(),
  defaultSummaryProfile: nonEmptyString.optional(),
  /** The driver supports opting into encrypted thinking content for replay. */
  encryptedContentOption: z.boolean().optional(),
}).strict();

export type ThinkingRequestKnobs = z.infer<typeof thinkingRequestKnobsSchema>;

export const thinkingPolicySchema = z.object({
  exposure: thinkingExposureSchema,
  replay: thinkingReplayRuleSchema,
  knobs: thinkingRequestKnobsSchema.optional(),
}).strict();

export type ThinkingPolicy = z.infer<typeof thinkingPolicySchema>;

// ── Service tier facet (R19) ────────────────────────────────────────────────

export const serviceTierSchema = z.object({
  /** Tier identifier selected by the user, for example 'flex'. */
  id: nonEmptyString,
  displayName: nonEmptyString.optional(),
  description: nonEmptyString.optional(),
}).strict();

export type ServiceTier = z.infer<typeof serviceTierSchema>;

/**
 * How a selected tier reaches the provider: a request parameter (OpenRouter
 * service_tier) or a model-name variant (Neuralwatt -flex). Where variants
 * exist, variant names are used and parameter forms are ignored.
 */
export const tierMechanismSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('request-parameter'),
    /** Provider request parameter carrying the tier, for example service_tier. */
    parameter: nonEmptyString,
    tiers: z.array(serviceTierSchema).min(1),
  }).strict(),
  z.object({
    kind: z.literal('model-name-variants'),
    tiers: z.array(serviceTierSchema.extend({
      /** Suffix the driver appends to the base model id, for example '-flex'. */
      modelIdSuffix: nonEmptyString,
      /** Provider precondition asserted by the driver at request time. */
      requiresStreaming: z.boolean().optional(),
    }).strict()).min(1),
  }).strict(),
]);

export type TierMechanism = z.infer<typeof tierMechanismSchema>;

// ── Cache facet (R10–R12) ───────────────────────────────────────────────────

export const cacheTtlOptionSchema = z.object({
  /** TTL label matching the cacheWriteByTtl rate keys. */
  id: cacheTtlLabelSchema,
  displayName: nonEmptyString.optional(),
}).strict();

export type CacheTtlOption = z.infer<typeof cacheTtlOptionSchema>;

/**
 * Prompt-cache capability. 'explicit' drivers own breakpoint placement;
 * 'automatic' providers cache prefixes without markers. TTL choice is the
 * only user knob; placement itself is never configurable.
 */
export const cacheFacetSchema = z.object({
  mode: z.enum(['explicit', 'automatic']),
  /** The provider supports a stable session-scoped cache/routing key. */
  sessionKey: z.boolean(),
  ttlOptions: z.array(cacheTtlOptionSchema).min(1).optional(),
  /**
   * Automatic-cache providers whose TTL selection rides a request-level
   * retention hint (for example Meta `prompt_cache_retention`) instead of a
   * breakpoint marker. The selected ttl id is sent verbatim (R11).
   */
  retentionHint: z.boolean().optional(),
}).strict();

export type CacheFacet = z.infer<typeof cacheFacetSchema>;

// ── Quota facet (R24, R25) ──────────────────────────────────────────────────

export const quotaBalanceSchema = z.object({
  label: nonEmptyString,
  amount: decimalStringSchema,
  /** Native unit label, for example 'USD', 'kWh', or 'credits'. */
  unit: nonEmptyString.max(24),
}).strict();

export type QuotaBalance = z.infer<typeof quotaBalanceSchema>;

export const quotaSubscriptionSchema = z.object({
  state: z.enum(['active', 'trialing', 'past-due', 'cancelled', 'expired', 'unknown']),
  displayName: nonEmptyString.optional(),
  renewsAt: isoTimestampSchema.optional(),
}).strict();

export type QuotaSubscription = z.infer<typeof quotaSubscriptionSchema>;

export const quotaAllowanceSchema = z.object({
  label: nonEmptyString,
  state: z.enum(['available', 'limited', 'blocked', 'unknown']),
  detail: nonEmptyString.optional(),
}).strict();

export type QuotaAllowance = z.infer<typeof quotaAllowanceSchema>;

/** Typed quota state in provider-native units. Informational only; never gates. */
export const providerQuotaSchema = z.object({
  observedAt: isoTimestampSchema,
  balances: z.array(quotaBalanceSchema),
  subscription: quotaSubscriptionSchema.nullable(),
  allowances: z.array(quotaAllowanceSchema),
}).strict();

export type ProviderQuota = z.infer<typeof providerQuotaSchema>;
