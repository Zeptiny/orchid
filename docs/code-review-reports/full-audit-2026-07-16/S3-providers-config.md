# Full Audit S3 — Providers, Credentials & Config

**Date:** 2026-07-16  
**Mode:** report-only (no fixes applied)  
**Intent:** Providers, credential vault, connection store, catalog trust, config merge/validation, accounting integrity, agent parity.  
**Scope:**
- `electron/src/main/providers/**`
- `electron/src/main/config/**`
- `electron/src/main/defs/**`
- `electron/src/main/ipc/providers.ts`
- `electron/src/main/ipc/config.ts`
- `electron/src/shared/types/{provider,accounting}.ts`
- Renderer Providers / Preferences / `useProviders` / `provider-selection`

## Review team

| Reviewer | Role |
|----------|------|
| correctness | always |
| testing | always |
| maintainability | always |
| project-standards | always |
| agent-native | always |
| learnings-researcher | always |
| security | conditional |
| reliability | conditional |
| api-contract | conditional |
| kieran-typescript | conditional |
| adversarial | conditional |

**Team size:** 11 specialized agents

## Verdict

**Provider stack is well-designed (vault redaction, catalog signing, accounting freeze) but has end-to-end policy holes and multi-store races.** One **P0** correctness break (`allowInsecureHttp` dropped on request path). Security **P0/P1** around env-auth + custom endpoint exfil and HTTPS SSRF. Adversarial **P0** races can re-enable disconnected connections or leave live keys after disconnect. **Agent-native score ~0%** for provider/config management.

**Learnings:** `docs/solutions/` has **zero** applicable Electron provider/config learnings (only stale Python MCP note).

---

## P0 — Critical (4)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 1 | `allowInsecureHttp` dropped on request/resolve path (ready ≠ usable) | `compatible.ts:63` + `providers/index.ts:176` | correctness, security, reliability, adversarial, kieran/api (prior) | 95–100 | gated_auto |
| 2 | Env-auth + generic endpoint can exfiltrate arbitrary process env secrets | `providers/index.ts:160` | security | 75 | manual |
| 3 | Concurrent `submit_api_key` + `disconnect` can leave live key after “disconnect” | `ipc/providers.ts` | adversarial, reliability | 85 | manual |
| 4 | `validateConnection` last-write can re-enable disabled/disconnected connections | `ipc/providers.ts` validate path | adversarial | 90 | manual |

### 1. allowInsecureHttp end-to-end break

IPC/registry honor `allowInsecureHttp`; `resolveCredential` and `createCompatibleLanguageModel` re-validate **without** the flag. LAN/self-hosted HTTP connections look ready then fail every chat.

### 2. Env-auth credential theft

`process.env[connection.credential.variable]` with only `/^[A-Z_][A-Z0-9_]*$/` → API key to user-controlled generic endpoint. Compromised renderer can bind `OPENAI_API_KEY` / cloud tokens to attacker URL.

### 3–4. Multi-store / health races

No joint vault+connection lock. Concurrent submit/disconnect/validate/disable can leave usable vault handles after disconnect, or overwrite `disabled`/`disconnected` back to `ready`.

---

## P1 — High (18)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 5 | HTTPS custom endpoints: no destination allowlist (credential SSRF) | `compatible.ts:21` | security | 75 | manual |
| 6 | Loopback check treats any hostname starting with `127.` as local | `compatible.ts:17` | correctness | 100 | safe_auto |
| 7 | Vault + connection mutations multi-step without joint atomicity | `ipc/providers.ts:631` | reliability, correctness, adversarial | 75–85 | manual |
| 8 | `submit_api_key` binds vault origin from stale snapshot while endpoint mutates | `ipc/providers.ts` | adversarial | 85 | manual |
| 9 | Invalid home config fails closed by quitting entire app | `config/loader.ts:215` | reliability | 85 | gated_auto |
| 10 | `ConfigSaveMessage` is `Partial<Config>` but runtime is tombstone PATCH | `ipc.ts:247` | api-contract | 92 | manual |
| 11 | Dual model resolution: incomplete custom models allowed at resolve, rejected at gate | `resolver.ts:70` + IPC | api-contract, correctness | 75–88 | gated_auto |
| 12 | `mcp_servers` untyped bag + spawn (cross-ref S1 P0) | `ipc-boundary.ts:114` | kieran-ts, adversarial | 80–88 | manual |
| 13 | Agent has ~0% action parity on provider/config ops | tools + system-prompt | agent-native | 100 | manual |
| 14 | Context starvation: no provider/config in system prompt | `system-prompt.ts` | agent-native | 100 | gated_auto |
| 15 | IPC providers imports `main/index` (circular) | `ipc/providers.ts:30` | maintainability | 100 | gated_auto |
| 16 | `providers:update` builds candidate via `as ProviderConnection` | `ipc/providers.ts:607` | kieran-ts | 78 | gated_auto |
| 17 | Config dual source: hand-written `Config` vs Zod schema | `config/schema.ts` | kieran-ts | 82 | manual |
| 18 | Accounting middleware `wrapGenerate` completely untested | `accounting/middleware.ts:111` | testing | 90 | manual |
| 19 | Provider IPC `validate` / `enable` / `status_refresh` untested | `ipc/providers.ts:651` | testing | 88 | manual |
| 20 | Vault fail-closed/corruption paths largely untested | `vault.ts` | testing | 85 | manual |
| 21 | Accounting store singleton init/fail-closed API untested | `accounting/store.ts:356` | testing | 85 | manual |
| 22 | Middleware cost evidence (headers + Neuralwatt) never exercised | `middleware.ts:60` | testing | 82 | manual |

---

## P2 — Moderate (22)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 23 | Log redaction misses non-`sk-` key formats | `logging.ts:55` | security | 50 |
| 24 | `storeApiKey` appends generations (orphan secrets) | `vault.ts:331` | correctness | 50–100 |
| 25 | Session cost totals attach global `unknownCount` to every currency row | `accounting/store.ts:329` | correctness | 100 |
| 26 | Stream attempt can finalize succeeded without finish usage | `accounting/middleware.ts:201` | correctness | 75 |
| 27 | `config:save` persists values `validateConfig` rejects | `ipc/config.ts:171` | correctness | 75 |
| 28 | ProviderStatusCache `put()` no write serialization | `status/cache.ts:162` | reliability | 85 |
| 29 | Status refresh coalescing ignores manual vs automatic | `status/service.ts:140` | reliability | 80 |
| 30 | Corrupt config JSON silently treated as empty layer | `loader.ts:49` | reliability | 75 |
| 31 | `config:save` rejects `providers` while types/tombstones still treat it writable | multi | api-contract | 88 |
| 32 | Inconsistent error payload shapes config vs providers | multi | api-contract | 82 |
| 33 | `ProviderStatusView.data` unversioned open bag | `ipc.ts:311` | api-contract | 72 |
| 34 | `FrozenProviderRequestSnapshot.protocol` is `string` | `accounting.ts:59` | kieran-ts | 85 |
| 35 | Accounting provenance bags open `unknown` | `accounting.ts:37` | kieran-ts | 76 |
| 36 | SQLite rows cast to `AttemptRow` without row Zod | `store.ts:282` | kieran-ts | 74 |
| 37 | Config validation blanket unknown casts | `validation.ts:113` | kieran-ts | 72 |
| 38 | `environmentVariable!` non-null assertion | `ipc/providers.ts:549` | kieran-ts | 70 |
| 39 | Provider IPC ~800-line god module | `ipc/providers.ts` | maintainability | 75 |
| 40 | Connection rules triplicated (IPC / resolver / registry) | multi | maintainability | 75 |
| 41 | Fresh driver registry on every `services()` | `ipc/providers.ts:148` | maintainability | 75 |
| 42 | `deepMergeProviderDict` name obsolete | `merge.ts:76` | maintainability | 75 |
| 43 | Empty `providers` config field permanent shim | `schema.ts:41` | maintainability | 75 |
| 44 | Zod and `validateConfig` duplicate constraints | `validation.ts:89` | maintainability | 75 |
| 45 | `customModels` can override catalog model metadata for same id | `resolver.ts` | adversarial | 85 |
| 46 | Disconnect deletes vault before health flips (race window) | `ipc/providers.ts` | adversarial | 75 |
| 47 | Resolver lifecycle unavailability reasons untested | `resolver.ts` | testing | 80 |
| 48 | Config IPC `model_metadata` / `list_personalities` / unknown-key untested | `ipc/config.ts` | testing | 78 |
| 49 | Catalog transport/coalescing under-tested | catalog updater | testing | 75 |
| 50 | Cost formula reasoning branches under-tested | `cost.ts` | testing | 75 |
| 51 | Docs: `connections.json` vs actual `providers.json` | CLAUDE.md vs store | project-standards | 80 |
| 52 | Docs: project config path `.orchid/config.json` vs `.orchid.json` | CLAUDE.md vs loader | project-standards | 80 |
| 53 | `config:model_metadata` skips Zod at IPC boundary | `ipc/config.ts:128` | project-standards | 90 |

---

## P3 — Low (6)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 54 | Env numeric overrides can inject NaN | `merge.ts:338` | correctness | 75 |
| 55 | Disconnect interrupt wins over late stream success (cost loss) | accounting store | correctness | 75 |
| 56 | `validateConfig` errors never enforced at runtime | `loader.ts:294` | reliability | 70 |
| 57 | Provider create `modelIds` required in TS, defaulted in Zod | `ipc.ts` | api-contract | 78 |
| 58 | Accounting types internal-only (no IPC) | `accounting.ts` | api-contract | 70 |
| 59 | Stale U8 “until then” comment on config IPC | `ipc/config.ts:5` | maintainability | 100 |
| 60 | No permanent connection hard-delete API | connection-store | residual | — |
| 61 | docs/solutions empty for provider/config domain | learnings | 100 |

---

## Agent-native (S3)

| Principle | Score |
|-----------|-------|
| Action parity (provider + config UI) | **0 / ~18** |
| Connection CRUD | **0 / 5** |
| Config get/update tools | **0 / 2** |
| Provider/config in system prompt | **0** |
| Verdict | **NEEDS WORK (fail)** |

Unsafe FS “parity” (`providers.json` / `config.json` write) bypasses vault, locks, and UI refresh — **not** acceptable substitute.

---

## Deduplication notes

| Merged from | Into |
|-------------|------|
| correctness + security + reliability + adversarial on allowInsecureHttp | #1 |
| reliability + correctness + adversarial on vault/connection multi-step | #7 |
| security env-auth + residual generic endpoint | #2, #5 |
| adversarial validate re-enable + concurrent submit/disconnect | #3, #4 |
| api-contract + prior S1 ConfigSave tombstones | #10 |
| kieran + adversarial mcp_servers | #12 (also S1 P0) |
| maintainability circular import (also S1) | #15 |

---

## Residual risks

1. Vault depends on OS `safeStorage`; keychain compromise yields decryptable secrets.
2. In-memory API keys for in-flight requests survive disconnect until turn stops.
3. Empty `RELEASE_CATALOG_KEYRING` disables remote catalog promote (intentional fail-closed).
4. Catalog compromise (stolen signing key) can skew models/pricing, not inject drivers.
5. Status cache last-writer-wins under concurrent provider puts.
6. No mass vault wipe IPC (good); no in-app factory-reset either.
7. Learnings base has no Electron provider patterns to guide future agents.

---

## Testing gaps (union)

- E2E: `allowInsecureHttp:true` non-loopback HTTP → resolve + language model success
- Hostname `127.evil.com` is **not** loopback
- Concurrent `submit_api_key` ∥ `disconnect` / `validate` ∥ `disable`
- Fault injection: vault success + connection update failure
- Multi-currency `unknownCount`
- Stream close without finish part
- `config:save` rejects `chunk_overlap >= chunk_size`
- Invalid `ORCHID_*` numeric env → reject NaN
- Startup with schema-invalid config remains usable
- Manual status refresh during automatic in-flight
- `wrapGenerate` accounting paths
- Vault corrupt/empty key/encrypt fail/encryption unavailable
- Accounting store init/get fail-closed singleton
- Resolver: disabled/retired/mismatch reasons
- Catalog transport errors + refresh coalescing
- Config IPC model_metadata / list_personalities / unknown keys
- Cost reasoning / missing rates branches

---

## Strengths (do not regress)

- Credentials never returned in IPC DTOs; one-shot `submit_api_key`
- Origin rebinding deletes stored secrets
- Disconnect requires `confirm:true`, stops turns, accounting interrupt before vault delete
- Catalog: size limits, Ed25519, trusted provider policy, no remote origins/drivers
- Config rejects legacy `providers` key on save
- Broad provider unit/integration suite relative to rest of app

---

## Coverage

| Item | Value |
|------|--------|
| Specialized agents | 11/11 |
| Fixes applied | **none** |
| Cross-refs | S1 mcp_servers RCE, S1 circular providers import |

---

## Suggested fix priority (later)

1. P0: thread `allowInsecureHttp` end-to-end; env-auth allowlist + endpoint SSRF guards  
2. P0: per-connection joint lock; conditional health updates (never clobber disabled/disconnected)  
3. P1: config load soft-recovery; ConfigSave typed patch; typed MCP servers  
4. P1: agent tools + prompt context for providers/config (or document intentional isolation)  
5. P1: break IPC↔main cycle; expand vault/IPC/accounting tests  
