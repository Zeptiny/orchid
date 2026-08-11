/**
 * Prompt-cache facet — Anthropic explicit breakpoint placement, OpenAI session
 * key, TTL knob validation, and generic no-marker behavior (R10–R12).
 */
import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  applyCacheBreakpoints,
  buildCacheProviderOptions,
  deriveCacheSessionKey,
  resolveCacheTtl,
} from '../../src/main/providers/facets/cache';
import {
  ANTHROPIC_CACHE_FACET,
  OPENAI_CACHE_FACET,
} from '../../src/main/providers/drivers/native';

function userMessage(text: string): ModelMessage {
  return { role: 'user', content: text };
}

describe('resolveCacheTtl (R11)', () => {
  it('honors a declared TTL option', () => {
    expect(resolveCacheTtl(ANTHROPIC_CACHE_FACET, '1h')).toBe('1h');
    expect(resolveCacheTtl(ANTHROPIC_CACHE_FACET, '5m')).toBe('5m');
  });

  it('rejects an undeclared TTL (user data never constructs requests, R2)', () => {
    expect(resolveCacheTtl(ANTHROPIC_CACHE_FACET, '30m')).toBeUndefined();
  });

  it('returns undefined when the facet declares no TTL options', () => {
    expect(resolveCacheTtl(OPENAI_CACHE_FACET, '1h')).toBeUndefined();
    expect(resolveCacheTtl(undefined, '1h')).toBeUndefined();
  });
});

describe('deriveCacheSessionKey + buildCacheProviderOptions (R10)', () => {
  it('derives a stable session-scoped key', () => {
    expect(deriveCacheSessionKey('abc')).toBe('orchid-session-abc');
    expect(deriveCacheSessionKey(undefined)).toBeUndefined();
  });

  it('sends promptCacheKey under the openai namespace when the facet declares sessionKey', () => {
    expect(buildCacheProviderOptions(OPENAI_CACHE_FACET, 'orchid-session-abc')).toEqual({
      openai: { promptCacheKey: 'orchid-session-abc' },
    });
  });

  it('sends nothing for an explicit facet without a routing key (Anthropic)', () => {
    expect(buildCacheProviderOptions(ANTHROPIC_CACHE_FACET, 'orchid-session-abc')).toBeUndefined();
  });

  it('sends nothing without a session (no key, R12-safe)', () => {
    expect(buildCacheProviderOptions(OPENAI_CACHE_FACET, undefined)).toBeUndefined();
  });
});

describe('applyCacheBreakpoints — Anthropic explicit (R10, R11)', () => {
  const tools = {
    read_file: { description: 'read' },
    write_file: { description: 'write' },
  };

  it('marks the last tool definition to cover the stable tools+system prefix', () => {
    const result = applyCacheBreakpoints({
      system: 'STATIC',
      messages: [userMessage('hi')],
      tools,
      cacheFacet: ANTHROPIC_CACHE_FACET,
      providerNamespace: 'anthropic',
    });
    const last = result.tools?.write_file as {
      providerOptions?: { anthropic?: { cacheControl?: { type: string; ttl?: string } } };
    };
    expect(last.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
    // The first tool is unmarked — one prefix breakpoint only.
    expect((result.tools?.read_file as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  it('marks the system message when no tools are present', () => {
    const result = applyCacheBreakpoints({
      system: 'STATIC',
      messages: [userMessage('hi')],
      tools: undefined,
      cacheFacet: ANTHROPIC_CACHE_FACET,
      providerNamespace: 'anthropic',
    });
    expect(result.system).toMatchObject({
      role: 'system',
      content: 'STATIC',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
  });

  it('advances a breakpoint with the conversation tail', () => {
    const result = applyCacheBreakpoints({
      system: 'STATIC',
      messages: [userMessage('one'), userMessage('two')],
      tools: undefined,
      cacheFacet: ANTHROPIC_CACHE_FACET,
      providerNamespace: 'anthropic',
    });
    const [first, last] = result.messages;
    expect((first as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    expect(
      (last as { providerOptions?: { anthropic?: { cacheControl?: unknown } } })
        .providerOptions?.anthropic?.cacheControl,
    ).toEqual({ type: 'ephemeral' });
  });

  it('applies the user-selected TTL to both breakpoints (R11)', () => {
    const result = applyCacheBreakpoints({
      system: 'STATIC',
      messages: [userMessage('hi')],
      tools,
      ttl: '1h',
      cacheFacet: ANTHROPIC_CACHE_FACET,
      providerNamespace: 'anthropic',
    });
    const tool = result.tools?.write_file as {
      providerOptions?: { anthropic?: { cacheControl?: { ttl?: string } } };
    };
    expect(tool.providerOptions?.anthropic?.cacheControl?.ttl).toBe('1h');
    const tail = result.messages[result.messages.length - 1] as {
      providerOptions?: { anthropic?: { cacheControl?: { ttl?: string } } };
    };
    expect(tail.providerOptions?.anthropic?.cacheControl?.ttl).toBe('1h');
  });

  it('drops an undeclared TTL rather than sending it', () => {
    const result = applyCacheBreakpoints({
      system: 'STATIC',
      messages: [userMessage('hi')],
      tools: undefined,
      ttl: '30m',
      cacheFacet: ANTHROPIC_CACHE_FACET,
      providerNamespace: 'anthropic',
    });
    expect(result.system).toMatchObject({
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
    expect(
      (result.system as { providerOptions?: { anthropic?: { cacheControl?: { ttl?: string } } } })
        .providerOptions?.anthropic?.cacheControl?.ttl,
    ).toBeUndefined();
  });
});

describe('applyCacheBreakpoints — non-explicit / generic (R12)', () => {
  it('sends no markers for an automatic (OpenAI) facet', () => {
    const result = applyCacheBreakpoints({
      system: 'STATIC',
      messages: [userMessage('hi')],
      tools: { read_file: {} },
      sessionKey: 'orchid-session-abc',
      cacheFacet: OPENAI_CACHE_FACET,
      providerNamespace: 'openai',
    });
    expect(result.system).toBe('STATIC');
    expect((result.tools?.read_file as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    expect(result.providerOptions).toBeUndefined();
  });

  it('sends no markers when the connection declares no cache facet (generic, R12)', () => {
    const result = applyCacheBreakpoints({
      system: 'STATIC',
      messages: [userMessage('hi')],
      tools: { read_file: {} },
      sessionKey: 'orchid-session-abc',
      cacheFacet: undefined,
      providerNamespace: 'openai',
    });
    expect(result.system).toBe('STATIC');
    expect((result.tools?.read_file as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  it('sends no markers when the namespace is not anthropic even with an explicit facet', () => {
    const result = applyCacheBreakpoints({
      system: 'STATIC',
      messages: [userMessage('hi')],
      tools: undefined,
      cacheFacet: ANTHROPIC_CACHE_FACET,
      providerNamespace: 'generic-anthropic-compatible',
    });
    expect(result.system).toBe('STATIC');
  });
});
