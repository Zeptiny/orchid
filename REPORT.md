# Code Review Report: Provider System Refactor

| Field | Value |
|-------|--------|
| **Run ID** | `20260713-003253-a2e5fd4c` |
| **Branch** | `feat/provider-system-refactor` |
| **Base** | `feat/ts-electron-migration` (`5e6fcc8`) |
| **Plan** | `docs/plans/2026-07-12-001-refactor-provider-system-plan.md` (`plan_source: explicit`) |
| **Scope** | Original review: 155 files, +16.8k / −4.8k (U1–U9 surface); post-fix commits appended |
| **PR** | None |
| **Mode** | Original report with post-fix disposition |
| **Artifacts** | `/tmp/compound-engineering/ce-code-review/20260713-003253-a2e5fd4c/` |

## Post-fix update

This report was reviewed against the completed implementation commits:

- `4917b97 fix(providers): complete lifecycle requirements`
- `2cda32c fix(providers): resolve critical review findings`

The original findings below are retained as review history. Their current
disposition and the updated requirements assessment are recorded after the
historical tables.

## Intent

Replace development-era OpenCode-default / loosely typed providers with connection-scoped trusted drivers, signed catalog, secure credentials, native AI SDK adapters, immutable attempt accounting, and no-provider local-only UX (R1–R52, U1–U9).

## Review team (13)

| Reviewer | Model tier | Status |
|----------|------------|--------|
| correctness | session | returned |
| security | session | returned |
| adversarial | session | returned |
| reliability | mid | returned |
| testing | mid | returned |
| maintainability | mid | returned |
| project-standards | mid | returned |
| api-contract | mid | returned |
| performance | mid | returned |
| kieran-typescript | mid | returned |
| julik-frontend-races | mid | returned |
| ce-agent-native-reviewer | mid | returned |
| ce-learnings-researcher | mid | returned (none found) |

**Skipped:** previous-comments (no PR), Rails/Python/Swift, schema-drift, data-migrations.

## Verdict

**P0/P1 code findings are resolved.** The branch now matches the plan’s core
architecture (connection-scoped selections, main-process vault/catalog/drivers/
ledger, deleted OpenAI fallback, and informational status). Remaining items are
P2/P3 advisories, coverage improvements, and explicit release prerequisites for
currently disabled subscription integrations.

**Merge bar:** retain the release gates for unverified subscription OAuth
integrations, and address the remaining advisory accounting/stream-edge tests
when those paths are enabled.

---

## Primary findings (merged, confidence ≥75 or P0)

The tables in this section describe the findings at the original review point;
see “Post-fix disposition” below for the current state.

Sorted by severity → multi-reviewer agreement → file.

### P0 — must fix before merge

| ID | Title | Reviewers | File | Confidence | Route | Why it matters |
|----|-------|-----------|------|------------|-------|----------------|
| F1 | **`chat:send` ignores preferred model on existing sessions** | correctness, adversarial, api-contract | `electron/src/main/ipc/chat.ts` (~601) | 100 | gated_auto / fix now | `ensureActiveSession` accepts preferred/default selection but returns the loaded session unchanged; turn freezes `session.selection` only. Legacy `selection=null` cannot recover via send-time pick; switching picker while session has selection A still bills A. **Violates R7 / AE2 / API contract of `chat:send.model`.** |
| F2 | **Subagents resolve tier config instead of parent turn selection** | correctness, adversarial | `electron/src/main/tools/subagent/delegate.ts` (~132), `subagent-runner.ts` | 100 | gated_auto / fix now | `getTierModelSelection` is null by default; runner does not inherit parent frozen selection. Delegation fails after chat-only setup, or can switch connection mid-tool-loop. **Violates R7, R33, KTD7.** |
| F3 | **Generic environment credentials rebind to a new endpoint without invalidation** | security | `electron/src/main/ipc/providers.ts` (~584–593), `providers/index.ts` (~153–163) | 100 | gated_auto / fix now | Origin change deletes **stored** vault secrets but not **environment** credentials; validate can mark ready and runtime sends `process.env[var]` to the new origin. **KTD6 / credential-destination rebinding exfiltration path.** |

### P1 — should fix

| ID | Title | Reviewers | File | Confidence | Route | Why it matters |
|----|-------|-----------|------|------------|-------|----------------|
| F4 | **Subagent runner no longer strips nested delegation tools** | correctness | `electron/src/main/agents/subagent-runner.ts` (~145) | 100 | safe_auto | `SUBAGENT_FORBIDDEN_TOOLS` filter removed → nested fan-out / attribution mess. |
| F5 | **Turns use process-wide `toolRegistry` instead of frozen per-runtime registry** | correctness | `electron/src/main/ipc/chat.ts` (~766) | 100 | gated_auto | Mid-turn agent/skill reload mutates in-flight tool surface (regression vs prior runtime freeze). |
| F6 | **MCP managers no longer leased; invalidation can tear down mid-stream** | correctness | `electron/src/main/ipc/chat.ts` (~767) | 75 | gated_auto | `acquire`/`release` removed → config/project reload can shut down MCP during turn. |
| F7 | **Catalog promote TOCTOU during credential await** | adversarial | provider resolve/freeze path (definitions → `vault.readSecret` → re-`catalog.load` for freeze) | 80 | gated_auto | Pricing/catalog version frozen for accounting can differ from version used for model policy resolve. **Threatens R29 snapshot consistency.** |
| F8 | **OAuth refresh binds origin from `connection.endpoint` while runtime uses driver origin** | adversarial | credentials refresh vs driver runtime | 85 | gated_auto | Binding mismatch for code-owned subscription drivers under refresh. |
| F9 | **Status fetches have no timeout; hung network permanently blocks single-flight** | reliability | `status/service.ts`, Lilac/Neuralwatt sources | 88 | gated_auto | Single-flight never clears on hang → status dead until process restart. |
| F10 | **Catalog HTTP transport has no request timeout under single-flight** | reliability | `catalog/updater.ts` | 82 | gated_auto | Same hang/single-flight pattern for catalog refresh. |
| F11 | **Browser OAuth expiry checked only on callback; abandoned flows leak loopback servers** | reliability | `credentials/oauth-flow.ts` | 85 | gated_auto | Ports/PKCE state leak until cancel/exit (latent until OAuth IPC enabled). |
| F12 | **InputArea `handleSend` closes over stale provider/model gates** | julik-frontend-races | `InputArea.tsx` (~364) | 90 | safe_auto | Deps omit `providerAvailable` / `modelSelected` → send after reconnect/disconnect can use wrong gate. |
| F13 | **Wizard submit/completeOAuth lack synchronous re-entry guards** | julik-frontend-races | `ConnectionWizard.tsx` (~404) | 85 | safe_auto | Double Enter can double-create / double-submit API key. |
| F14 | **OAuth pending dismiss without cancel** | julik-frontend-races | `ConnectionWizard.tsx` (~392) | 80 | gated_auto | Close leaves main OAuth work + draft connection (latent until auth IPC live). |
| F15 | **AE1–AE11 e2e covers only partial scenarios; several are non-behavioral** | testing | `provider-end-to-end.test.ts`, `provider-onboarding.test.ts` | 95 | manual | Plan DoD requires AE suite through public contracts; onboarding tests are source-string scans. |
| F16 | **Disable mid-turn / disconnect-with-active-turn untested** | testing | `ipc/providers.ts` + tests | 95 | manual | KTD15 core lifecycle unguarded. |
| F17 | **`providers` IPC + ConnectionWizard are god modules; custom-endpoint policy duplicated** | maintainability, kieran-ts | `ipc/providers.ts`, `ConnectionWizard.tsx` | 85–90 | manual | Drift risk on allowsCustomEndpoint; hard to land OAuth safely. |
| F18 | **`CostSource` union excludes `subscription-quota` while drivers emit it** | kieran-typescript | `shared/types/accounting.ts` (~8) | 88 | gated_auto | Type/runtime drift; will break finalize when subscription path wires fully. |
| F19 | **Ledger rehydrates snapshots via unchecked casts / empty-object fallback** | kieran-typescript | `accounting/store.ts` (~60) | 92 | gated_auto | Corrupt/partial rows fail open instead of fail closed. |
| F20 | **`CLAUDE.md` still documents deleted `llm/providers*.ts` and alias/model model** | project-standards, maintainability | `electron/CLAUDE.md` | 85 | safe_auto | Next contributor will edit the wrong layer / reintroduce legacy patterns. |

### P2 — fix if straightforward

| ID | Title | Reviewers | File | Notes |
|----|-------|-----------|------|-------|
| F21 | Stream closed without `finish` part finalized as **succeeded** | correctness, reliability | `accounting/middleware.ts` (~201) | Misclassifies truncated streams in immutable ledger; prefer failed/interrupted. |
| F22 | Subagent system prompt drops project personality | correctness | `subagent-runner.ts` | Regression; restore `appendProjectPersonality`. |
| F23 | Disconnect aborts turns but in-memory model credentials race vault delete | adversarial | disconnect + runtime | Active adapters may still hold secrets briefly. |
| F24 | Expired OAuth secrets used as-is; refresh not on resolve path | adversarial | resolve + refresh coordinator | Requests may fail instead of refresh-first (R16). |
| F25 | Release-disabled subscription drivers routeable if catalog lifecycle active | adversarial | registry + catalog | Enablement gate gap (U5/U9). |
| F26 | Concurrent connection update during stream leaves frozen turn on stale metadata | adversarial | connection-store + freeze | By design for freeze, but UX/ops unclear. |
| F27 | Device OAuth poll / credential refresh lack per-request timeouts | reliability | oauth-flow, refresh | Hung poll stalls cancel. |
| F28 | WAL without FULL synchronous may lose pending row on hard crash | reliability | accounting/store | Weakens KTD8 durability claim under power loss. |
| F29 | Catalog freeze tests only prove `structuredClone`, not real request freeze | testing | catalog-refresh tests | R29 under-proven. |
| F30 | Unknown cost not asserted against monetary totals | testing | subscription contracts | AE10 partial. |
| F31 | Shared stream/tool contract suite missing for drivers | testing | native/compatible tests | U4 scenario 7. |
| F32 | apiKey helper copy-pasted across drivers (lilac throws, others `''`) | maintainability | native/compatible/lilac/… | Behavioral split. |
| F33 | Status/pricing branches outside driver boundary (IPC/runtime/UI) | maintainability | ipc/providers, runtime | New live-metadata providers require multi-file edits. |
| F34 | IPC rebuilds default driver registry every `services()` call | maintainability, performance | ipc/providers.ts (~133) | Release-config drift + alloc churn. |
| F35 | Sync SQLite on every attempt; connection store rereads JSON every resolve | performance | middleware, connection-store | Latency under tool loops. |
| F36 | `useProviders` multi-instance list fan-out | performance, julik residual | useProviders.ts | Extra IPC + re-render. |
| F37 | `FrozenProviderRequestSnapshot.protocol` stringly typed | kieran-ts | accounting.ts | Lose exhaustiveness. |
| F38 | `providers:update` builds candidate via `as ProviderConnection` | kieran-ts | ipc/providers.ts | Skips validation narrowing. |
| F39 | Wizard async setState / onComplete after dismiss | julik | ConnectionWizard | Late model selection after skip. |
| F40 | ModelPicker activates unavailable rows | julik | ModelPicker.tsx (~180) | Greyed but still selectable. |
| F41 | ConnectionList / ProviderStatus setState after unmount | julik | ConnectionList, ProviderStatus | Busy/error flicker. |
| F42 | `session:change_model` / config / SessionSummary hard breaks (intentional) | api-contract | ipc, session, schema | Document + tighten OrchidAPI types; ensure co-shipped bridge. |
| F43 | E2E attribution hand-finalizes ledger (bypasses real path) | testing | provider-end-to-end | False confidence on R35–R43. |

### P3 / advisory

| ID | Title | Notes |
|----|-------|-------|
| F44 | Catalog definitions remapped every read; status cache clone-on-put | Performance polish. |
| F45 | Agent-native: system prompt lacks connection/model context; session model pick UI-only | Not credential parity; should-have for agent-native. Credentials correctly human-only. |
| F46 | Chat error path truncates but may not fully redact provider `Error.message` | Security residual. |
| F47 | `allowInsecureHttp` accepted at connection layer but create path fail-closed | Inconsistent but currently safe. |

---

## What looks solid (intentionally not broken)

Reviewers agreed these plan properties largely hold:

- **No silent OpenAI fallback / no default provider** — old `providers.ts` / factory deleted; architecture greps present.
- **Legacy config not migrated** — providers stripped; diagnostics; sessions v1 model display-only.
- **Accounting fail-closed before network** for pending insert path (when store works).
- **Status failures do not disable connections** (KTD12).
- **Cost defaults to `unknown`, not zero** (R41–R42) in calculator paths.
- **Generic origin rebind** now invalidates stored and environment credentials before the new endpoint can be used.
- **Renderer DTOs** omit handles/tokens; one-shot submitApiKey write-only (redaction looks sound).
- **Agents/tools cannot access vault** (agent-native pass on must-nots).
- **Module tree** matches plan output structure; dead ProviderDetector/provider-renames removed.

---

## Requirements completeness (plan)

| Area | Status | Gaps |
|------|--------|------|
| R1–R7 foundations / ModelSelection | **Implemented** | Per-send selection is persisted for existing sessions; subagents inherit the frozen parent selection |
| R8–R12 onboarding / disconnected | **Implemented** | Connection lifecycle code is present; behavioral regression coverage was expanded beyond source scans |
| R13–R19 auth / credentials | **Implemented with release gates** | Vault binding, refresh-on-resolve, environment rebind invalidation, and OAuth cleanup are covered; disabled integrations remain intentionally unavailable until release prerequisites are supplied |
| R20–R29 catalog | **Implemented** | Resolution and accounting use one catalog snapshot; signed atomic promotion remains intact |
| R30–R34 protocol / adapters | **Implemented** | Trusted drivers and registry are wired; broader shared-stream coverage remains advisory |
| R35–R45 accounting / cost | **Implemented with residual advisories** | Durable ledger and fail-closed rehydration are present; stream-without-finish and crash-durability concerns remain P2 |
| R46–R52 status | **Implemented** | Lilac, Neuralwatt, scheduler, and bounded network requests are covered |
| AE1–AE11 | **Covered** | Explicit acceptance tests now exercise the public lifecycle contracts; legacy skipped chat-driver cases remain separately marked |
| U1–U9 units | **Code landed** | U9 subscription release gates remain external by design |
| KTD4 vault fail-closed | **Implemented** | Vault and accounting corruption paths fail closed |
| KTD6 origin binding | **Implemented** | Stored and environment credentials cannot silently follow a changed generic endpoint |
| KTD7 freeze | **Implemented** | Parent selection, per-runtime tools/MCP, and catalog snapshot are frozen per turn |
| KTD8 attempt before I/O | **Implemented with durability advisory** | Pending attempt insertion remains required before provider I/O; SQLite crash-hardening remains P2 |
| KTD14 SQLite required | **Present** | Packaging smoke not reviewed live |
| KTD15 disable vs disconnect | **Covered** | Disable preserves active work; disconnect finalizes pending accounting and removes credentials |

## Post-fix disposition

| Findings | Current disposition |
|----------|---------------------|
| F1–F13 | Confirmed and fixed in `2cda32c`; targeted regressions added |
| F14 | Rejected as a current P1: provider auth IPC is release-gated and cannot create a pending browser flow in this build |
| F15–F16 | Confirmed and fixed in `4917b97`; AE1–AE11 and KTD15 coverage added |
| F17 | Rejected as P1; god-module/duplication concerns are maintainability follow-up, not a current product defect |
| F18 | Rejected as a type mismatch; `subscription-quota` is driver evidence, while the monetary ledger intentionally records U9 unknown cost as `unknown` |
| F19–F20 | Confirmed and fixed in `2cda32c` |

The earlier P2 refresh-on-resolve gap (F24) was also fixed in `4917b97`.

---

## Residual risks (not full findings)

1. OAuth browser/device code largely unhooked from IPC until release enablement → will rot without contract tests.
2. Subscription / Lilac supply-discount release prerequisites remain process gates, not code gates alone.
3. Append-only `accounting.db` has no retention policy → long-term growth.
4. Mixed-version preload/main not supported after subtractive IPC breaks (acceptable if always co-shipped).
5. Disconnect vs pending-attempt races not fully proven.
6. CommandContext model APIs still stringly opaque keys in places.
7. No institutional learnings in `docs/solutions/` for this domain yet.

---

## Testing gaps (aggregate)

Remaining high-value tests/advisories:

1. Stream close without finish -> non-succeeded outcome (F21).
2. MCP invalidation during an active turn (lease behavior is covered; an end-to-end invalidation scenario remains useful).
3. Behavioral AE1 skip-onboarding coverage beyond the explicit acceptance harness.
4. Secret-pattern scan on `providers.list` / `chat:error` payloads.
5. SQLite crash-hardening and retention policy.

---

## Agent-native summary

| Check | Result |
|-------|--------|
| ModelSelection for subagents/tools/RAG | Pass; delegated execution inherits the frozen parent selection |
| Tools cannot vault/submit secrets | Pass |
| Credential authority human-only | Pass (plan-correct) |
| System prompt connection context | Fail (should-have) |
| Session model pick agent-accessible | Gap (should-have) |
| Provider status agent-visible | Gap (should-have) |

---

## Learnings research

**None found** applicable under `docs/solutions/` (only unrelated MCP cancel note). Consider compounding after fixes.

---

## Historical recommended fix order

The following was the order proposed by the original review; the post-fix
disposition above records which items were completed or rejected.

1. **F1 + F2** — selection freeze for existing sessions and subagents (correctness of the whole feature).
2. **F3** — env credential origin rebind (security).
3. **F4–F6** — subagent tools + tool registry + MCP lease regressions.
4. **F7** — freeze catalog once per resolve (no re-load after vault).
5. **F12–F13** — cheap UI race fixes.
6. **F9–F11** — timeouts / OAuth expiry cleanup.
7. **F18–F19, F21** — accounting type safety + stream outcome.
8. **F20** — update `electron/CLAUDE.md`.
9. **F15–F16** — tests for AE/KTD15 and the above bugs (prevents recurrence).
10. Maintainability splits (F17) after behavior is green.

---

## Coverage notes

- Untracked/excluded: `docs/plans/2026-07-12-001-refactor-provider-system-plan.md` (untracked), dirty `CONCEPTS.md` — not in git diff review scope.
- Diff too large for full line-by-line human reread; findings grounded in targeted file reads by 13 specialists.
- The post-fix implementation was reviewed directly; no additional automated autofix was applied.
- Final verification after the fixes: 101 test files passed, 1,648 tests passed, 20 intentionally skipped legacy chat-driver tests, typecheck passed, lint passed, and the production build passed.
- Confidence gate: primary table keeps ≥75 (and all P0). Soft P2/P3 advisory from testing/maintainability retained because user asked for **all** findings.

## Artifact index

```
/tmp/compound-engineering/ce-code-review/20260713-003253-a2e5fd4c/
  REPORT.md                 ← this file
  correctness.json
  security.json
  adversarial.json
  reliability.json
  testing.json
  maintainability.json
  project-standards.json
  api-contract.json
  performance.json
  kieran-typescript.json
  julik-frontend-races.json
  agent-native.md
  learnings.md
  files.txt
  commits.txt
```
