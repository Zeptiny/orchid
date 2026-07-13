import { z } from 'zod';

/** A model is executable only in the context of a specific connection. */
export const modelSelectionSchema = z.object({
  connectionId: z.string().uuid(),
  modelId: z.string().trim().min(1),
}).strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** Copy persisted selection data without retaining a caller-owned object. */
export function copyModelSelection(
  selection: ModelSelection | null | undefined,
): ModelSelection | null {
  return selection == null
    ? null
    : {
        connectionId: selection.connectionId,
        modelId: selection.modelId,
      };
}

export const providerProtocolSchema = z.enum([
  'openai-compatible',
  'anthropic-messages',
  'google-generative-ai',
  'xai',
]);

export type ProviderProtocol = z.infer<typeof providerProtocolSchema>;

export const providerLifecycleSchema = z.enum([
  'active',
  'preview',
  'deprecated',
  'disabled',
  'retired',
]);

export type ProviderLifecycle = z.infer<typeof providerLifecycleSchema>;

export const providerAuthMethodSchema = z.enum([
  'api-key',
  'environment',
  'none',
]);

export type ProviderAuthMethod = z.infer<typeof providerAuthMethodSchema>;

export const connectionHealthSchema = z.enum([
  'draft',
  'ready',
  'needs_attention',
  'disabled',
  'disconnected',
]);

export type ConnectionHealth = z.infer<typeof connectionHealthSchema>;

export const environmentVariableSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

export const credentialReferenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stored'),
    handle: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('environment'),
    variable: environmentVariableSchema,
  }).strict(),
  z.object({
    kind: z.literal('none'),
  }).strict(),
]);

export type CredentialReference = z.infer<typeof credentialReferenceSchema>;

/**
 * Connection endpoints identify an API base only. Credentials and request
 * parameters belong in the credential vault or driver, never in providers.json.
 */
export const providerEndpointSchema = z.string().url().superRefine((value, ctx) => {
  try {
    const endpoint = new URL(value);
    if (endpoint.username !== '' || endpoint.password !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endpoint must not include credentials',
      });
    }
    if (endpoint.search !== '' || endpoint.hash !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endpoint must not include query parameters or fragments',
      });
    }
  } catch {
    // `z.string().url()` reports malformed URLs. This refinement only adds
    // restrictions to otherwise valid absolute endpoint URLs.
  }
});

export const providerModelDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  protocol: providerProtocolSchema,
  lifecycle: providerLifecycleSchema.optional(),
  capabilities: z.object({
    inputModalities: z.array(z.enum(['text', 'image', 'audio', 'video', 'pdf'])).min(1),
    outputModalities: z.array(z.enum(['text', 'image', 'audio', 'video', 'pdf'])).min(1),
    tools: z.boolean(),
    reasoning: z.boolean(),
  }).strict().optional(),
  limits: z.object({
    contextTokens: z.number().int().positive().nullable(),
    outputTokens: z.number().int().positive().nullable(),
  }).strict().optional(),
}).strict();

export type ProviderModelDefinition = z.infer<typeof providerModelDefinitionSchema>;

/** User-declared metadata for a custom compatible model, never inferred. */
export const customConnectionModelSchema = providerModelDefinitionSchema.extend({
  capabilities: z.object({
    inputModalities: z.array(z.enum(['text', 'image', 'audio', 'video', 'pdf'])).min(1),
    outputModalities: z.array(z.enum(['text', 'image', 'audio', 'video', 'pdf'])).min(1),
    tools: z.boolean(),
    reasoning: z.boolean(),
  }).strict(),
  limits: z.object({
    contextTokens: z.number().int().positive().nullable(),
    outputTokens: z.number().int().positive().nullable(),
  }).strict(),
}).strict();

export type CustomConnectionModel = z.infer<typeof customConnectionModelSchema>;

export const providerDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  supportedAuthMethods: z.array(providerAuthMethodSchema).min(1),
  supportedProtocols: z.array(providerProtocolSchema).min(1),
  models: z.array(providerModelDefinitionSchema),
  allowsCustomModels: z.boolean(),
  lifecycle: providerLifecycleSchema.optional(),
}).strict();

export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>;

/** Non-secret, user-owned connection metadata. */
export const providerConnectionSchema = z.object({
  id: z.string().uuid(),
  providerId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  protocol: providerProtocolSchema,
  authMethod: providerAuthMethodSchema,
  credential: credentialReferenceSchema,
  /** Explicit user models for a generic connection. Never inferred from an alias. */
  modelIds: z.array(z.string().trim().min(1)),
  /** Optional richer metadata for user-defined compatible models. */
  customModels: z.array(customConnectionModelSchema).optional(),
  health: connectionHealthSchema,
  endpoint: providerEndpointSchema.nullable().optional(),
  /** Explicit user acknowledgement required for a non-loopback HTTP endpoint. */
  allowInsecureHttp: z.boolean().optional(),
}).strict();

export type ProviderConnection = z.infer<typeof providerConnectionSchema>;

export const createProviderConnectionSchema = providerConnectionSchema.omit({ id: true });
export type CreateProviderConnectionInput = z.infer<typeof createProviderConnectionSchema>;

export const updateProviderConnectionSchema = providerConnectionSchema
  .omit({ id: true })
  .partial()
  .strict();
export type UpdateProviderConnectionInput = z.infer<typeof updateProviderConnectionSchema>;

export const providerConnectionDocumentSchema = z.object({
  version: z.literal(1),
  connections: z.array(providerConnectionSchema),
}).strict().superRefine((document, ctx) => {
  const ids = new Set<string>();
  for (const [index, connection] of document.connections.entries()) {
    if (ids.has(connection.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate connection id '${connection.id}'`,
        path: ['connections', index, 'id'],
      });
    }
    ids.add(connection.id);
  }
});

export type ProviderConnectionDocument = z.infer<typeof providerConnectionDocumentSchema>;

export interface EffectiveModel extends ProviderModelDefinition {
  readonly source: 'catalog' | 'connection';
}

export type ProviderResolution =
  | {
      readonly kind: 'resolved';
      readonly selection: ModelSelection;
      readonly connection: ProviderConnection;
      readonly provider: ProviderDefinition;
      readonly model: EffectiveModel;
    }
  | {
      readonly kind: 'provider-required';
      readonly reason: 'no-usable-connection';
    }
  | {
      readonly kind: 'selection-required';
      readonly reason: 'no-selection';
    }
  | {
      readonly kind: 'unavailable';
      readonly selection: ModelSelection;
      readonly reason:
        | 'unknown-connection'
        | 'connection-not-ready'
        | 'unknown-provider'
        | 'provider-disabled'
        | 'unsupported-connection'
        | 'missing-model'
        | 'model-disabled'
        | 'provider-mismatch';
    };

export function isUsableConnection(connection: ProviderConnection): boolean {
  return connection.health === 'ready';
}
