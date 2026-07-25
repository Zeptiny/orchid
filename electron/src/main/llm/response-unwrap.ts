/**
 * Provider response unwrapping — some OpenAI-compatible gateways wrap the
 * standard chat.completion body in an envelope:
 *
 *   { "data": { "choices": [...], "usage": ... }, "success": true }
 *
 * The AI SDK openai-compatible client expects top-level `choices`. Without
 * unwrapping, generateText/doGenerate fails with:
 *   Invalid input: expected array, received undefined (path: choices)
 *
 * Observed with Cline Pass (`api.cline.bot`). Streaming (SSE) is left alone.
 */

/**
 * If `body` is a known envelope around an OpenAI-style completion/chunk payload,
 * return the inner object; otherwise return `body` unchanged.
 */
export function unwrapOpenAICompatibleJson(body: unknown): unknown {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  const root = body as Record<string, unknown>;

  // Already OpenAI-shaped — leave alone
  if (Array.isArray(root.choices)) {
    return body;
  }

  const data = root.data;
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return body;
  }

  const inner = data as Record<string, unknown>;
  // Envelope: { data: { choices: [...] }, success?: boolean }
  if (Array.isArray(inner.choices)) {
    return data;
  }

  // Some gateways also wrap { data: { data: [...] } } for /models — not needed
  // for chat, but harmless if we don't touch it.
  return body;
}

/**
 * Custom fetch for createOpenAICompatible that unwraps JSON envelopes.
 * Passes through SSE / non-JSON / failed responses unchanged.
 */
export function createUnwrappingFetch(
  baseFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await baseFetch(input, init);

    // Don't touch streaming / non-JSON (chat completions stream is SSE)
    const contentType = response.headers.get('content-type') ?? '';
    if (
      !response.ok ||
      contentType.includes('text/event-stream') ||
      !contentType.includes('application/json')
    ) {
      return response;
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return response;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON despite content-type — reconstruct original body
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const unwrapped = unwrapOpenAICompatibleJson(parsed);
    if (unwrapped === parsed) {
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return new Response(JSON.stringify(unwrapped), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
