/**
 * Tests for OpenAI-compatible response envelope unwrapping (Cline Pass, etc.).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createUnwrappingFetch,
  unwrapOpenAICompatibleJson,
} from '../../src/main/llm/response-unwrap';

describe('unwrapOpenAICompatibleJson', () => {
  it('unwraps { data: { choices }, success } envelope (Cline Pass)', () => {
    const inner = {
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          message: { content: 'Repository Exploration Inquiry', role: 'assistant' },
        },
      ],
      id: 'gen-1',
      model: 'xiaomi/mimo-v2.5',
      object: 'chat.completion',
      usage: { completion_tokens: 10, prompt_tokens: 5, total_tokens: 15 },
    };
    const envelope = { data: inner, success: true };
    expect(unwrapOpenAICompatibleJson(envelope)).toEqual(inner);
  });

  it('leaves standard OpenAI responses unchanged', () => {
    const body = {
      choices: [{ message: { content: 'hi', role: 'assistant' } }],
      id: 'chatcmpl-1',
    };
    expect(unwrapOpenAICompatibleJson(body)).toBe(body);
  });

  it('leaves non-objects unchanged', () => {
    expect(unwrapOpenAICompatibleJson(null)).toBe(null);
    expect(unwrapOpenAICompatibleJson('x')).toBe('x');
    expect(unwrapOpenAICompatibleJson([1])).toEqual([1]);
  });

  it('leaves { data } without choices unchanged', () => {
    const body = { data: { id: 'models' }, success: true };
    expect(unwrapOpenAICompatibleJson(body)).toBe(body);
  });
});

describe('createUnwrappingFetch', () => {
  it('rewrites JSON envelope responses to OpenAI shape', async () => {
    const inner = {
      choices: [{ message: { content: 'Title Here', role: 'assistant' } }],
    };
    const envelope = { data: inner, success: true };
    const baseFetch = vi.fn(async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const fetchFn = createUnwrappingFetch(baseFetch as unknown as typeof fetch);
    const res = await fetchFn('https://api.cline.bot/api/v1/chat/completions', {
      method: 'POST',
    });
    const json = await res.json();
    expect(json).toEqual(inner);
    expect(Array.isArray(json.choices)).toBe(true);
  });

  it('does not rewrite SSE streams', async () => {
    const body = 'data: {"choices":[]}\n\n';
    const baseFetch = vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const fetchFn = createUnwrappingFetch(baseFetch as unknown as typeof fetch);
    const res = await fetchFn('https://example.com/v1/chat/completions');
    expect(await res.text()).toBe(body);
  });

  it('passes through standard JSON unchanged', async () => {
    const body = { choices: [{ message: { content: 'ok' } }] };
    const baseFetch = vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const fetchFn = createUnwrappingFetch(baseFetch as unknown as typeof fetch);
    const res = await fetchFn('https://api.openai.com/v1/chat/completions');
    expect(await res.json()).toEqual(body);
  });
});
