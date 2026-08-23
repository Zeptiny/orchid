---
title: Trusted projects — fail-closed consent gating for project-supplied content
date: 2026-08-04
category: logic-errors
module: project
problem_type: logic_error
component: security_gate
symptoms:
  - Binding any folder silently executed its .orchid.json config, MCP servers, and definition overlays with no consent step
  - Opening the MCP sidebar panel alone spawned the project's server processes
  - Sticky default_project_dir rebound projects at startup without user action
root_cause: missing_consent_boundary
resolution_type: code_fix
severity: high
tags: [trust, security, gating, mcp, workspace, consent, fingerprint]
---

# Trusted projects — fail-closed consent gating for project-supplied content

## Problem

Orchid layers project config (`.orchid.json`), definitions (`.orchid/{agents,skills,personalities}`), and root instruction files over the home configuration. Binding a directory therefore *executes* project-supplied intent: permission rules can auto-allow tools, MCP servers spawn, agents/skills/personalities inject into prompts. There was no consent boundary — even `mcp:status` from the sidebar called `ProjectMCPManagerRegistry.get()`, which ran `startAll()`.

## Solution

Per-machine trust store (`~/.orchid/trusted_projects.json`, keyed by canonical path) with a sha256 fingerprint over the security surface, plus a bind-then-gate model: binding always succeeds, and every execution path independently fails closed.

Key files: `electron/src/main/project/trust.ts` (store/fingerprint/report), gates across `electron/src/main/ipc/*` and `mcp/project-registry.ts`, renderer `TrustProjectDialog` + `useTrustPrompt`. Plan: `docs/plans/2026-08-03-001-feat-trusted-projects-plan.md`.

## Pattern rules that matter

1. **Gate at every execution entry point, not at bind.** Bind choke points are not sufficient: sticky defaults rebind at startup, and services resolve workspaces independently. Gates: `ensureActiveSession` (`untrusted_project` kind), MCP start, `tool:execute`, RAG/AST indexing, `session:create`, `definitions:list` (home-only). "Every entry point" means every layer — the background index-refresh subsystem later bypassed the RAG/AST gates by calling the engines directly; engine-direct/background callers need the gate too (see `index-auto-refresh-trust-gate-config-bypass.md`).
2. **Auto-trust projects with no surface** (no `.orchid.json`, `.orchid/` definitions, or root instruction aliases). Nothing project-supplied runs, and universal prompting trains users to click through.
3. **Bare/absent → trusted without a store entry; un-canonicalizable → untrusted.** Fail closed on path errors, never fail open.
4. **Dormant MCP managers for untrusted projects**: `get()` creates the entry but skips `startAll()`. Granting needs no migration — but it must invalidate the registry so the next `get()` recreates and starts. A *started* manager whose project drifts out of `trusted` retires lease-aware (running turns keep their manager; zero-lease entries shut down and fall through to a fresh dormant one). Never overwrite a leased map entry — that orphans the old manager and leaks server processes.
5. **Revocation ordering: record first.** Drop the store record so concurrent gate reads fail closed, then invalidate runtime/MCP caches (lease-aware), then force-stop bound sessions and cancel RAG indexing, pending index refreshes, and workspace watchers. Wrap per-session stops in try/catch — one throwing session must not abort the rest after the record is already gone.
6. **Fingerprint the security surface only** (`.orchid.json` + `.orchid/{agents,skills,personalities}` + root instruction aliases), with caps that cannot become bypasses:
   - Oversized files must be stream-hashed by content, never `size=N` (same-size content swaps otherwise evade drift detection while loaders still read the content). Reserve size-only markers for an extreme hard cap.
   - File-count overflow markers must include the first overflowing path+size; a stable `truncated:N` count lets attackers swap which file hides past the cap. Stop walking at the cap.
7. **Anything shown in the consent dialog must survive the IPC schema.** Report entries derive keys from untrusted config; skip blank/unsafe keys so zod `min(1)` fields cannot reject the payload and brick the only grant path. Wrap report building in try/catch — a hostile FS entry must not make `trust_get` reject.
8. **Trust state resolution is a hot path** (every workspace resolution and gate). Cache the state with a TTL validated by a cheap stat-only signature; never re-walk or re-parse definition registries to answer "is this trusted".

## Gotchas discovered in review

- Report building happens for *untrusted* content — cap raw config size, definition counts, and serialized value lengths, or a crafted repo DoSes the main process pre-trust.
- Orchid's own writes (agent edits of root AGENTS.md, definition saves, `config:save_project` from ProjectConfigView) flip trusted → changed by design; the next send re-prompts. Product-accepted residual — note that every ProjectConfigView save (per-project MCP servers, tier models, AGENTS.md overrides, …) rewrites `.orchid.json` and therefore trips this, so the re-prompt frequency scales with project-config editing.
- Grant records the fingerprint at click time, not review time (TOCTOU while the dialog is open) — accepted residual; a hardened version carries the reviewed fingerprint into `trust_set`.

## Verification

- Store/fingerprint/report unit suites, gate integration suite (`trusted-project-gates.test.ts`) covering dormancy, drift → gate → re-grant, and lease/revocation composition.
- Suites that bind fake workspaces need `getProjectTrustState: () => 'trusted'` mocks (fail-closed gates reject non-canonical fixture paths).
