---
name: review-output-template
description: 'Canonical skeleton for code review output. Defines pipe-delimited markdown tables, severity grouping, triage groups, and the full report structure.'
---

# Code Review Output Template

Use this **exact format** when presenting synthesized review findings — this example is the **canonical skeleton: copy its structure and fill it in**, do not re-derive a layout. Findings are grouped by severity, not by reviewer.

**IMPORTANT:** Use pipe-delimited markdown tables (`| col | col |`). Do NOT use ASCII box-drawing characters.

**IMPORTANT:** Escape literal pipe characters in table cells. Any `|` that appears inside a finding title, issue description, code snippet, regex pattern, or delimited-string example must be written as `\|` so column boundaries are determined only by unescaped pipes.

## Example

```markdown
## Code Review Results

**Scope:** merge-base with the review base branch -> working tree (14 files, 342 lines)
**Intent:** Add order export endpoint with CSV and JSON format support
**Mode:** interactive

**Reviewers:** correctness, testing, maintainability, security, api-contract
- security -- new public endpoint accepts user-provided format parameter
- api-contract -- new /api/orders/export route with response schema

### Applied (safe, verified)

| # | File | Fix | Reviewer |
|---|------|-----|----------|
| 6 | `export_helper_test.rb:40` | Added missing test for the empty-format branch | testing |
| 7 | `orders_controller.rb:88` (+test) | Tightened export file perms `0644 -> 0600` (security-posture — verify in diff) | security |

Validation: export tests 11 -> 13; suite 214 pass, lint clean.
Committed: `fix(review): cover empty-format branch + tighten export perms` (working tree was clean before review).

### Triage Groups

| Group | Findings | Context | Preferred Resolution | Why |
|-------|----------|---------|----------------------|-----|
| Export result-set scaling | #2, #3 | Both stem from loading the full order set in one pass | Design the pagination contract first (#3), then stream with `find_each` behind it (#2) | One cursor/page decision resolves the memory bound and the API shape together |

### P0 -- Critical

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 1 | `orders_controller.rb:42` | User-supplied ID in lookup, no ownership check | security | 100 |

- **#1** — `find(params[:id])` on the export path has no `where(account: current_account)` scope, so any authenticated user can export another account's orders. Scope the lookup to the current account.

### P1 -- High

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 2 | `export_service.rb:87` | Loads all orders into memory -- unbounded | performance | 100 |
| 3 | `export_service.rb:91` | No pagination contract | api-contract, performance | 75 |

- **#2** — `Order.where(...).to_a` materializes the full result set; a large account OOMs the worker. Stream with `find_each` or paginate.
- **#3** — the endpoint returns every row in one response; needs a cursor/page contract before GA. Design decision — see Actionable Findings.

### P2 -- Moderate

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 4 | `export_service.rb:45` | No error handling for CSV serialization failure | correctness | 75 |

### P3 -- Low

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 5 | `export_helper.rb:12` | Format detection could use an early return | maintainability | 75 |

### Actionable Findings

| # | File | Issue | Route | Notes |
|---|------|-------|-------|-------|
| 1 | `orders_controller.rb:42` | Ownership check missing on export lookup | `gated_auto -> downstream-resolver` | `suggested_fix` present — caller decides whether to apply |
| 3 | `export_service.rb:91` | Pagination contract needs a broader API decision | `manual -> downstream-resolver` | Needs design input before implementation |

### Pre-existing Issues

| # | File | Issue | Reviewer |
|---|------|-------|----------|
| 1 | `orders_controller.rb:12` | Broad rescue masking failed permission check | correctness |

### Learnings & Past Solutions

- [Known Pattern] `docs/solutions/export-pagination.md` -- previous export pagination fix applies to this endpoint

### Agent-Native Gaps

- New export endpoint has no CLI/agent equivalent -- agent users cannot trigger exports

### Deployment Notes

- Pre-deploy: capture baseline row counts before enabling the export backfill
- Verify: `SELECT COUNT(*) FROM exports WHERE status IS NULL;` should stay at `0`
- Rollback: keep the old export path available until the backfill has been validated

### Coverage

- Suppressed: 2 findings below anchor 75 (1 at anchor 50, 1 at anchor 25)
- Residual risks: No rate limiting on export endpoint
- Testing gaps: No test for concurrent export requests

---

> **Verdict:** Ready with fixes
>
> **Reasoning:** 1 critical auth bypass must be fixed. The memory/pagination issues (P1) should be addressed for production safety.
>
> **Fix order:** P0 auth bypass -> P1 memory/pagination -> P2 error handling if straightforward
```

## Anti-patterns

Do NOT produce output like this. The following is wrong:

```markdown
Findings

Sev: P1
File: foo.go:42
Issue: Some problem description
Reviewer(s): adversarial
Confidence: 75
Route: advisory -> human
────────────────────────────────────────
Sev: P2
File: bar.go:99
Issue: Another problem
```

This fails because: no pipe-delimited tables, no severity-grouped `###` headers, uses box-drawing horizontal rules, no numbered findings, no `## Code Review Results` title, and the verdict is not in a blockquote. Always use the table format from the example above.

## Formatting Rules

- **Pipe-delimited markdown tables** for findings -- never ASCII box-drawing characters or per-finding horizontal-rule separators
- **Escape literal `|` in table cells** -- any `|` inside a finding title, issue description, code snippet, regex pattern, or delimited-string example must be written as `\|`
- **Severity-grouped sections** -- `### P0 -- Critical`, `### P1 -- High`, `### P2 -- Moderate`, `### P3 -- Low`. Omit empty severity levels.
- **Stable sequential finding numbers** -- assign finding numbers once after sorting, continue them across severity sections, and reuse those same numbers when findings are repeated in Actionable Findings.
- **Always include file:line location** for code review issues
- **Reviewer column** shows which persona(s) flagged the issue. Multiple reviewers = cross-reviewer agreement.
- **Confidence column** shows the finding's anchor as an integer (`50`, `75`, or `100`). Never render as a float.
- **No `Route` column in the per-severity tables** -- the synthesized route appears only in the Actionable Findings table and the `mode:agent` JSON.
- **Detail line (per finding, as needed)** -- keep the `Issue` cell to **one short clause**; put the full explanation in a bullet list immediately under the severity table, keyed by stable `#`: `- **#N** — <why it matters + concrete fix direction>`.
- **Header includes** scope, intent, and reviewer team with per-conditional justifications
- **Mode line** -- include `interactive` or `agent`
- **Triage Groups section (when groups exists)** -- pipe table `| Group | Findings | Context | Preferred Resolution | Why |` rendered after Applied and before the severity tables.
- **Applied section (default mode only)** -- when the review applied fixes (Stage 5c), list them first as `# | File | Fix | Reviewer`.
- **Actionable Findings section** -- include when the actionable queue is non-empty
- **Pre-existing section** -- separate table, no confidence column
- **Learnings & Past Solutions section** -- results from learnings-researcher, with links to docs/solutions/ files
- **Agent-Native Gaps section** -- results from agent-native-reviewer. Omit if no gaps found.
- **Deployment Notes section** -- key checklist items from deployment-verification-agent. Omit if the agent did not run.
- **Coverage section** -- suppressed count, residual risks, testing gaps, failed reviewers
- **Summary uses blockquotes** for verdict, reasoning, and fix order
- **Horizontal rule** (`---`) separates findings from verdict
- **`###` headers** for each section -- never plain text headers

## Agent mode (JSON)

When `mode:agent` is active, **do not** emit the markdown table report above. Emit **one parseable JSON object** as the primary response and write the same payload to `review.json` under `/tmp/code-review/<run-id>/`.

The contract is defined in SKILL.md under **`### JSON output format (`mode:agent` only)`**. Minimum fields: `status`, `verdict`, `scope`, `intent`, `reviewers`, `findings`, `actionable_findings`, `artifact_path`, `run_id`.

Key differences from the interactive markdown format:

- **No pipe-delimited tables** — findings are JSON arrays with merged fields.
- **`actionable_findings`** — subset for caller apply workflows.
- **`triage_groups`** — the markdown Triage Groups section serialized as JSON objects.
- **No `applied_fixes` and no Applied section** — `mode:agent` does not apply fixes; the caller does.
- **Failure/degraded paths** — `{"status":"failed","reason":"..."}` or `"status":"degraded"` with reason.
- **Stable `#`** — same numbering as Stage 5 synthesis, carried in JSON finding objects.
