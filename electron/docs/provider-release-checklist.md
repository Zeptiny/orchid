# Provider release checklist

Use this as a release gate for provider behavior. It is not permission to enable a provider merely because code exists.

## Current subscription state

The bundled catalog currently marks `chatgpt-codex` and `grok-subscription` as `disabled`, and the default registry supplies disabled release configurations. Keep both disabled unless every subscription gate below is met. Do not enable either through catalog data alone.

## Baseline gates

- [ ] A fresh profile has no configured connection or selected model; no provider is silently chosen.
- [ ] Local-only mode works: browsing, history, settings, indexing, and provider setup remain available while LLM actions explain the provider-required state.
- [ ] Typed connection/model selections survive restart, slash-containing model IDs, agents, subagents, sessions, and tool loops without account switching.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` pass from `electron/`.
- [ ] Target packaging rebuilds and loads required `better-sqlite3`; packaged offline startup verifies the bundled catalog and initializes the ledger or clearly leaves provider requests disabled.
- [ ] Architecture/security scans find no default OpenCode path, URL/name inference, generic OpenAI fallback, plaintext credential fallback, renderer secret type, fixture secret, private signing key, copied third-party client ID, or mutable cost aggregate.
- [ ] Deterministic end-to-end fixtures cover setup, skip/local-only mode, connection repair, status refresh, retry/tool-loop accounting, interrupt/restart recovery, and immutable historical totals.

## Catalog and fixture gates

- [ ] The catalog has reviewed provenance, capture date/hash, valid schema, compatible app range, expiry, and a higher monotonic version.
- [ ] Exact final bytes verify against an app-bundled public key; private signing material is absent from source, artifacts, and logs.
- [ ] A remote catalog cannot add a driver, auth method, protocol, credential destination, or executable behavior beyond trusted code.
- [ ] Every changed driver has deterministic local request/response fixtures with source, capture time, integration version, and redaction review.
- [ ] Opt-in live smoke tests use environment credential references, are non-destructive, and assert contract fields rather than generated text.

## Provider-specific gates

| Provider area | Required release evidence |
| --- | --- |
| Native OpenAI, Anthropic, Gemini, xAI | Native adapter/protocol fixture, code-owned origin check, supported auth check, normalized stream/tool/usage/error behavior. |
| Generic compatible providers | Endpoint validation, non-loopback HTTP confirmation, user-defined model provenance, and credential rebinding test. |
| OpenCode Go | A current fixture for each catalog-declared protocol; routing is selected solely from frozen model metadata. |
| Neuralwatt | Request-cost header takes precedence; energy calculation has charged energy, rate, multiplier evidence, and currency; otherwise cost is unknown. Quota status remains informational. |
| Lilac | See the mandatory live supply-discount gate below. |
| ChatGPT/Codex and Grok subscription | All OAuth and compatibility gates below; otherwise retain disabled lifecycle and release configuration. |

### Mandatory Lilac supply-discount live gate

- [ ] The public Lilac `window=5m` status contract is reachable without a user credential and returns a valid provider timestamp.
- [ ] For at least one approved model, the response supplies `current_subscription_supply_updated_at`, `current_subscription_supply_state`, `current_subscription_discount_percent`, and `current_subscription_credit_multiplier` with valid values.
- [ ] The live check records the observation/capture time and verifies that stale, missing, unauthorized, and malformed status states are shown honestly and do not block sending.
- [ ] No code, fixture, or UI derives a discount from supply, performance, demand, or marketing text.

If this contract fails, do not release-enable or advertise Lilac supply-discount support. Preserve unavailable/stale behavior and leave other providers usable; do not estimate a replacement discount.

### Mandatory subscription gate

- [ ] Orchid-owned, approved public-client registration exists for the target integration; no third-party/OpenCode client identifier is copied.
- [ ] The release record names a semantic integration version, terms-review version/date, and current live-contract fixture version.
- [ ] Build-owned HTTPS request, authorization, token, and (when applicable) device-authorisation endpoints pass validation; static request headers are reviewed and cannot override authorization/cookie/host headers.
- [ ] Browser callback/device flow, state/PKCE, cancellation, timeout, token refresh single-flight, account/entitlement handling, and connection-scoped failure/reconnect behavior pass deterministic fixtures.
- [ ] A current opt-in live smoke test proves the approved auth/protocol contract. Subscription quota without a provider monetary charge remains unknown cost, never zero.

If any item fails, keep the affected subscription integration disabled. A contract failure may require reconnection for one provider connection but must not break standard API-key drivers or local-only Orchid.

## Accounting and status gates

- [ ] Each model invocation inserts a durable pending attempt before network I/O; AI SDK retries remain disabled so retry middleware is observable.
- [ ] Reported cost wins over calculated cost; decimal totals reconcile by currency from immutable rows; unknown-cost counts remain distinct from zero.
- [ ] Provider evidence, status cache, logs, IPC snapshots, session files, and bundles contain no API key, OAuth token, authorization code, account identifier, or raw request body.
- [ ] Status TTL/manual minimum/`Retry-After` behavior is exercised. Status failure or staleness never disables, delays, reroutes, or recommends against a usable inference request.
- [ ] Disconnect finalizes/cancels active attempts before deleting stored credentials; disable blocks only new work and allows frozen work to finish.

## Release record and sign-off

For each release-enabled provider, record: catalog version and signing key ID; driver/integration version; fixture source and capture date; live-smoke result; OAuth registration and terms approval where applicable; status/cost contract result; release owner; and rollback contact.

Block the release when any required live contract is stale or failing. The deterministic fixture suite remains the CI gate, while live smoke tests establish freshness for providers that are actually release-enabled.
