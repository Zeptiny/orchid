# Provider driver contract

This document is the maintenance contract for trusted provider code in Orchid's Electron main process. A catalog entry describes data; a driver owns credentials, request construction, and every credential-bearing destination.

## Trust boundary

Implement drivers under `src/main/providers/drivers/` and register them in `drivers/registry.ts`. A driver declares:

- its stable provider ID, supported authentication methods, and supported protocols;
- whether a user may supply an endpoint; and
- a code-owned API origin for built-in providers, or `null` for generic providers.

`ProviderDriverRegistry` validates the selected connection, provider definition, auth method, protocol, and endpoint before it asks the driver to create an AI SDK model. Do not add name-based routing, URL inference, or an OpenAI fallback. Remote catalog data must never add a driver, request origin, module, or credential destination.

| Driver | Auth | Protocol | Request destination ownership |
| --- | --- | --- | --- |
| OpenAI | API key, environment | OpenAI-compatible | Code: `https://api.openai.com/v1` |
| Anthropic | API key, environment | Anthropic Messages | Code: `https://api.anthropic.com/v1` |
| Google Gemini | API key, environment | Google Generative AI | Code: `https://generativelanguage.googleapis.com/v1beta` |
| xAI | API key, environment | xAI | Code: `https://api.x.ai/v1` |
| OpenCode Go | API key, environment | OpenAI-compatible or Anthropic Messages per catalog model | Code: `https://opencode.ai/zen/go/v1` |
| Lilac | API key, environment | OpenAI-compatible | Code: `https://api.getlilac.com/v1` |
| Neuralwatt | API key, environment | OpenAI-compatible | Code: `https://api.neuralwatt.com/v1` |
| Generic OpenAI/Anthropic-compatible | API key, environment, or none | Declared compatible protocol | User-entered, validated endpoint |

Orchid does not ship OAuth or subscription-login providers. Authentication is API key, environment reference, or none.

## Endpoint and credential rules

Built-in drivers reject connection endpoint overrides. Generic endpoints must be credential-free `https` or `http` URLs with no query or fragment; loopback HTTP is allowed, while non-loopback HTTP requires explicit user confirmation. A generic stored credential is bound to its connection ID, driver ID, auth method, and normalized origin. Changing any of those values requires a new credential submission.

Credentials stay in the main process:

- API keys are encrypted by Electron `safeStorage` in the credential vault. `basic_text` and unavailable encryption are not acceptable persistent storage.
- An API key crosses IPC only in a one-shot secret-submission request and is never returned. Renderer state must clear it after settlement.
- Environment references contain only a validated variable name. Resolve the value only immediately before a trusted request; never send it to the renderer.

## Protocol, status, and cost hooks

Use the native AI SDK adapter for a named provider. OpenCode Go must choose its adapter from the frozen catalog model protocol, not a model-name heuristic. Generic Anthropic-compatible connections use the Anthropic adapter; generic OpenAI-compatible connections use the compatible adapter.

Provider-specific response parsing belongs beside the driver and must preserve only sanitized evidence. Cost resolution is ordered:

1. Provider-reported monetary charge wins.
2. A frozen, authoritative token or energy formula may calculate a charge.
3. Otherwise persist `unknown`; quota, credits, or a missing charge are never zero cost.

Use exact decimal strings for money and preserve the request's frozen catalog/status snapshot. For Neuralwatt, record reported request cost before considering energy; energy calculation requires authoritative charged energy, multiplier evidence, applicable rate, and currency. Do not substitute token pricing when those inputs are incomplete.

Status sources are independent and informational. They cache redacted, timestamped observations, honor TTL/manual minimums and `Retry-After`, and never disable a usable connection or reroute a request. Lilac's source is public and credential-free; it may expose throughput, first-token latency, uptime, supply state, discount, multiplier, and source timestamps only when supplied by Lilac. For a fresh matching Lilac model observation that includes both the explicit discount and credit multiplier, Orchid freezes the multiplier-adjusted catalog rates into that attempt's snapshot with live-status provenance. Missing or stale values leave the signed catalog rate intact; Orchid never infers a discount from performance or demand.

## Contract fixtures

Every driver change needs deterministic local fixtures before a live check:

- Capture fixture provenance: upstream documentation/endpoint, capture time, driver integration version, and sanitized response shape. Never commit a credential, account identifier, request body, private signing key, or copied client ID.
- Exercise the exact adapter/protocol, opaque model ID (including `/`), code-owned or validated origin, auth rejection, stream/tool normalization, usage extraction, and error/abort handling.
- Include billing cases for provider-reported charge, complete authoritative calculation, and unknown cost. Include retry/tool-loop attempts so accounting can reconcile one row per model invocation.
- Include status freshness, `Retry-After`, unauthorized, schema-failure, and redaction cases. Lilac fixtures must cover complete supply/discount/multiplier data plus absent and stale data; Neuralwatt fixtures must cover reported-cost precedence and incomplete energy evidence.

Live tests are opt-in, non-destructive contract checks using environment credential references. Assert protocol/auth/status/cost fields, not generated model content. A changed upstream contract blocks that driver's release enablement until its fixture, integration version, and release checklist are refreshed.

## Adding or changing a driver

1. Add or change trusted driver code and its focused contract tests.
2. Add the provider to the registry and trusted catalog policy with no broader auth/protocol capability than the code supports.
3. Add only declarative provider/model metadata to the catalog; preserve source and observation provenance.
4. Wire sanitized status/cost helpers and ensure accounting records unknown cost when the authoritative inputs are incomplete.
5. Update deterministic fixtures and run the provider architecture, integration, and release gates before changing a catalog lifecycle to active.

Removing a driver or breaking an upstream contract should disable only the affected provider/connection. It must not reintroduce a default provider or affect Orchid's local-only mode.
