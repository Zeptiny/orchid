---
description: 'How to file residual review findings in project trackers. Covers detection, fallback chain, ticket composition, and non-interactive mode for autonomous callers.'
---

# Tracker Detection and Defer Execution

This reference covers how Defer actions file tickets in the project's tracker. It is loaded by `SKILL.md` when the walk-through's Defer option executes, and when autonomous callers (e.g., `lfg`) need to file residual actionable findings without user prompts — see Execution Modes below.

---

## Execution Modes

Tracker-defer has two execution modes. The caller selects one; the detection, fallback chain, and ticket composition are shared.

### Interactive mode (default)

Used by `code-review` Interactive mode's routing question, walk-through Defer actions, and bulk-preview option C. All user-facing prompts fire:

- First Defer of the session with a generic (non-named) label confirms the effective tracker choice.
- Execution failures prompt with Retry / Fall back to next sink / Convert to Skip.
- Labels in the routing question reflect `named_sink_available` (name the tracker) vs fallback generics.

### Non-interactive mode

Used by autonomous callers like `lfg` that must not prompt. All blocking questions are skipped; the fallback chain is executed silently in order. Behavior:

- No confirmation on the first generic-label Defer; proceed directly.
- On execution failure, automatically fall to the next tier without prompting. Record the failure.
- On total chain exhaustion (every tier failed or no sink available), return findings in the `no_sink` bucket so the caller can route them to another surface (e.g., inline them in a PR description).
- Return a structured result: `{ filed: [{ finding_id, tracker, url }], failed: [{ finding_id, tracker, reason }], no_sink: [{ finding_id, title, severity, file, line }] }`.

The caller decides how to surface the result to the user. The non-interactive mode treats "no sink available" as a data-producing outcome, not a prompt trigger.

---

## Detection

The agent determines the project's tracker from whatever documentation is obvious. Primary sources: `AGENTS.md` at the repo root and in relevant subdirectories. Supplementary signals: `CONTRIBUTING.md`, `README.md`, PR templates under `.github/`, visible tracker URLs in the repo.

A tracker can be surfaced via MCP tool, CLI (e.g., `gh`), or direct API. All are acceptable. The detection output is a tuple with two availability flags:

```
{ tracker_name, confidence, named_sink_available, any_sink_available }
```

Where:
- `tracker_name` — human-readable name ("Linear", "GitHub Issues", "Jira"), or `null` when detection cannot identify a specific tracker
- `confidence` — `high` when the tracker is named explicitly in documentation and is unambiguously the project's canonical tracker; `low` when the signal is thin, conflicting, or implied only
- `named_sink_available` — `true` only when the agent can actually invoke the detected tracker; `false` when the tracker is documented but no tool reaches it
- `any_sink_available` — `true` when any tier in the fallback chain can be invoked this session

---

## Probe timing and caching

Availability probes run **at most once per session** and **only when Defer execution is imminent**. Never speculatively at review start, never per-Defer. The cached tuple is reused for every Defer action in the same run.

---

## Fallback chain

When the named tracker is unavailable or no tracker is named, fall back in this order:

1. **Named tracker** (MCP tool, CLI, or API the agent can invoke directly)
2. **GitHub Issues via `gh`** — when `gh auth status` succeeds and the current repo has issues enabled
3. **No sink** — findings remain in the review report's residual-work section (Interactive mode) or are returned in the `no_sink` bucket (Non-interactive mode)

---

## Ticket composition

Every Defer action creates a ticket with the following content, adapted to the tracker's capabilities:

- **Title:** the merged finding's `title` (capped at 10 words).
- **Body:**
  - Plain-English problem statement.
  - Suggested fix (when present in the finding's `suggested_fix`).
  - Evidence (direct quotes from the reviewer's artifact).
  - Metadata block: `Severity: <level>`, `Confidence: <score>`, `Reviewer(s): <list>`, `Finding ID: <fingerprint>`.
- **Labels** (when the tracker supports labels): severity tag (`P0`, `P1`, `P2`, `P3`).

---

## Failure path

When ticket creation fails at execution (API error, auth expiry, rate limit, malformed body):

**Interactive mode:** surface the failure inline and ask the user.

**Non-interactive mode:** do not prompt. Automatically fall through to the next tier. If every tier fails, record the finding in the `failed` bucket of the structured return and continue.

---

## Per-tracker behavior

| Tracker | Interface | Invocation sketch | Labels |
|---------|-----------|-------------------|--------|
| Linear | MCP (preferred) or API | Create issue in the project/workspace identified by documentation | Severity priority field |
| GitHub Issues | `gh issue create` | Repo defaults to the current repo. Use `--label` for severity tag when labels exist | `--label P0` / `--label P1` / etc. |
| Jira | MCP or API | Create issue in the project identified by documentation | Severity priority field |
| No sink available | — | Findings returned in the `no_sink` bucket | — |

When uncertain, prefer "drop with explicit user-facing notice" over "pass through silently and hope." A Defer that produces no durable artifact and no user message is data loss.
