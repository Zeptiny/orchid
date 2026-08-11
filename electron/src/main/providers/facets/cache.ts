/**
 * Prompt-cache facet — driver-owned breakpoint placement (R10–R12).
 *
 * Explicit-cache drivers place markers; placement itself is never
 * configurable and the TTL is the only user knob (R11). Generic compatible
 * connections declare no cache facet, so they send no markers and only
 * report cache usage from responses (R12).
 *
 * Anthropic (explicit): one `cache_control` breakpoint at the end of the
 * stable tools-plus-system prefix — applied to the system message when tools
 * are absent, otherwise to the last tool definition, whose cache marker
 * covers the entire earlier system+tools prefix — and one that advances with
 * the conversation tail (the last message; the adapter maps message-level
 * options onto its final content block). The Anthropic adapter enforces the
 * provider's 4-breakpoint limit.
 *
 * OpenAI (automatic + session key): the session-scoped `promptCacheKey`
 * rides the request-level provider options where the driver declares
 * `sessionKey`.
 */
import type { ModelMessage, SystemModelMessage } from 'ai';
import type { CacheFacet } from '../../../shared/types/provider-facets';
import type { ReasoningProviderOptions } from '../drivers/types';

export interface CachePlacementInput {
  /** Full assembled system prompt (static prefix first, R14). */
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: Record<string, unknown> | undefined;
  /** Stable session-scoped cache/routing key; undefined when no session. */
  readonly sessionKey?: string;
  /** User TTL selection from the driver's declared options. */
  readonly ttl?: string;
  readonly cacheFacet: CacheFacet | undefined;
  /** Driver namespace for per-part options, for example 'anthropic'. */
  readonly providerNamespace: string;
}

export interface CachePlacementResult {
  readonly system: string | SystemModelMessage;
  readonly messages: ModelMessage[];
  readonly tools: Record<string, unknown> | undefined;
  readonly providerOptions: ReasoningProviderOptions | undefined;
}

/** TTL is honored only when the driver declares it as an option (R2, R11). */
export function resolveCacheTtl(
  facet: Pick<CacheFacet, 'ttlOptions'> | undefined,
  selection: string | undefined,
): string | undefined {
  if (!facet?.ttlOptions || !selection) return undefined;
  return facet.ttlOptions.some((option) => option.id === selection) ? selection : undefined;
}

/** Derive the stable session-scoped cache/routing key (R10). */
export function deriveCacheSessionKey(sessionId: string | undefined): string | undefined {
  return sessionId ? `orchid-session-${sessionId}` : undefined;
}

/** Build the request-level cache options (session routing key, OpenAI). */
export function buildCacheProviderOptions(
  facet: CacheFacet | undefined,
  sessionKey: string | undefined,
): ReasoningProviderOptions | undefined {
  if (!facet?.sessionKey || !sessionKey) return undefined;
  return { openai: { promptCacheKey: sessionKey } };
}

type AnthropicCacheControl = { type: 'ephemeral'; ttl?: string };

type CarrierOptions = Record<string, Record<string, unknown> | undefined>;

function anthropicCacheOptions(
  existing: CarrierOptions | undefined,
  ttl: string | undefined,
): CarrierOptions {
  const cacheControl: AnthropicCacheControl = { type: 'ephemeral', ...(ttl ? { ttl } : {}) };
  return {
    ...existing,
    anthropic: { ...existing?.anthropic, cacheControl },
  };
}

function withAnthropicCacheControl<T extends { providerOptions?: unknown }>(
  carrier: T,
  ttl: string | undefined,
): T {
  return {
    ...carrier,
    providerOptions: anthropicCacheOptions(
      carrier.providerOptions as CarrierOptions | undefined,
      ttl,
    ),
  };
}

function lastToolName(tools: Record<string, unknown>): string | undefined {
  const names = Object.keys(tools);
  return names.length > 0 ? names[names.length - 1] : undefined;
}

/**
 * Place the explicit breakpoints for one assembled request. Only the
 * 'anthropic' namespace places markers today; every other facet mode returns
 * the request untouched.
 */
export function applyCacheBreakpoints(input: CachePlacementInput): CachePlacementResult {
  const facet = input.cacheFacet;
  if (!facet || facet.mode !== 'explicit' || input.providerNamespace !== 'anthropic') {
    return {
      system: input.system,
      messages: [...input.messages],
      tools: input.tools,
      providerOptions: undefined,
    };
  }
  const ttl = resolveCacheTtl(facet, input.ttl);

  // Breakpoint 1: end of the stable prefix. Tools are sent before the system
  // block by the adapter, so a marker on the last tool definition covers the
  // whole tools+system prefix; without tools the system message carries it.
  let tools = input.tools;
  let system: string | SystemModelMessage = input.system;
  const anchorTool = tools ? lastToolName(tools) : undefined;
  if (tools && anchorTool) {
    tools = {
      ...tools,
      [anchorTool]: withAnthropicCacheControl(tools[anchorTool] as { providerOptions?: unknown }, ttl),
    };
  } else {
    const systemMessage: SystemModelMessage = { role: 'system', content: input.system };
    system = withAnthropicCacheControl(systemMessage, ttl);
  }

  // Breakpoint 2: advance with the conversation tail.
  const tail = input.messages[input.messages.length - 1];
  const messages: ModelMessage[] = tail
    ? [...input.messages.slice(0, -1), withAnthropicCacheControl(tail, ttl)]
    : [...input.messages];

  return { system, messages, tools, providerOptions: undefined };
}
