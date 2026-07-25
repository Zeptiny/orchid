---
name: code-review
description: 'Structured code review using tiered persona agents, confidence-gated findings, and a merge/dedup pipeline. Use when reviewing code changes before creating a PR or after completing a task.'
---

# Code Review

Reviews code changes using dynamically selected reviewer personas. Spawns parallel sub-agents that return structured JSON, then merges and deduplicates findings into a single report.

## When to Use

- Before creating a PR
- After completing a task during iterative implementation
- When feedback is needed on any code changes
- Can be invoked standalone
- Can run inside larger workflows; use `mode:agent` when the caller needs JSON instead of markdown tables

## Argument Parsing

Parse arguments for optional tokens. Strip each recognized token before interpreting the remainder as a PR number, GitHub URL, or branch name.

| Token | Example | Effect |
|-------|---------|--------|
| `mode:agent` | `mode:agent` | **Report-only**: return **JSON** instead of markdown tables and skip the Stage 5c apply (the caller applies). Does not change reviewer selection, merge logic, or scope rules |
| `base:<sha-or-ref>` | `base:abc1234` or `base:origin/main` | Diff base on the **current checkout** (explicit; skips auto base detection) |
| `plan:<path>` | `plan:docs/plans/2026-03-25-001-feat-foo-plan.md` | Plan file for requirements verification (explicit) |
| `grouping:auto` | `grouping:auto` | **Default** — build thematic triage groups when findings span distinct concerns |
| `grouping:off` | `grouping:off` | Suppress triage groups |
| `grouping:always` | `grouping:always` | Always build triage groups, even for small reviews |

**Grouping is presentation, not a mode.** The `grouping:` tokens change how the finding set is organized for triage — never reviewer selection, merge logic, scope rules, or the Stage 5c apply decision.

**Mode note:** `mode:agent` is passed as a skill argument. Some platforms may alias this as `mode:headless`.

**Conflicting arguments:** Stop without dispatching reviewers when:
- Multiple incompatible scope selectors appear together (e.g. `base:` **and** a PR number/branch target)
- Multiple distinct `mode:` tokens
- Multiple distinct `grouping:` tokens

Emit a one-line failure reason. In `mode:agent`, return JSON: `{"status":"failed","reason":"..."}`.

## Operating principles

Same pipeline for default and `mode:agent`:

- **Apply locally; never push.** Never push, open PRs, or file tickets in any mode — push is the outward step the user owns. In **default (interactive)** mode the review applies safe, verified fixes and commits them when the pre-review tree was clean (Stage 5c owns the full rule). In **`mode:agent`** it never mutates the tree — it reports and the caller applies.
- **No blocking prompts.** Never use blocking question tools. Infer intent, plan, and scope from explicit tokens, git state, PR metadata, and conversation. Note uncertainty in Coverage or the verdict — do not stop to ask.
- **Explicit mutations only.** Never run `gh pr checkout`, `git checkout`, `git switch`, or similar branch-switch commands. Passing a PR number, URL, or branch name selects **review scope**, not permission to mutate the working tree.
- **Smart defaults.** Untracked files: review tracked changes only and list excluded paths in Coverage. Plan: use `plan:` when passed; otherwise discover conservatively from PR body or branch keywords. Weak advisory P2/P3 from testing/maintainability alone: demote to `testing_gaps` / `residual_risks` per Stage 5.

## Output format

| Invocation | Deliverable |
|------------|-------------|
| **Default** | Markdown report (pipe-delimited finding tables) + Actionable Findings summary |
| **`mode:agent`** | One JSON object (see ### JSON output format below) + the same `/tmp/code-review/<run-id>/` artifacts |

`mode:agent` is **report-only**: it skips the Stage 5c apply (the caller applies) and serializes findings as JSON instead of markdown. It does not change reviewer selection, merge logic, or scope rules.

## Quick Review Short-Circuit

If arguments indicate the user wants a quick, fast, or light code review — and **`mode:agent` is not active** — do not dispatch the multi-agent flow.

**Announce the chosen path** before any other work (Quick review vs Multi-agent review). Skip this announcement when `mode:agent` is active.

Sequence:

1. **Run the harness's built-in code review.** Forward any review target after stripping tokens. Then stop — do not dispatch the multi-agent pipeline.
2. **Exemption:** If no built-in review exists, continue into the full multi-agent review.
3. **`mode:agent` bypasses this short-circuit** — always run the full multi-agent review and return JSON.

## Severity Scale

All reviewers use P0-P3:

| Level | Meaning | Action |
|-------|---------|--------|
| **P0** | Critical breakage, exploitable vulnerability, data loss/corruption | Must fix before merge |
| **P1** | High-impact defect likely hit in normal usage, breaking contract | Should fix |
| **P2** | Moderate issue with meaningful downside (edge case, perf regression, maintainability trap) | Fix if straightforward |
| **P3** | Low-impact, narrow scope, minor improvement | User's discretion |

## Action Routing

Severity answers **urgency**. `autofix_class` and `owner` are **signal** describing follow-up shape for callers — **not apply permission or an apply gate.** The apply decision is judgment (Stage 5c), not a function of `autofix_class`: default mode applies; in `mode:agent` this skill does not mutate the checkout — the caller applies. See `references/action-class-rubric.md` for persona guidance.

| `autofix_class` | Default owner | Meaning |
|-----------------|---------------|---------|
| `gated_auto` | `downstream-resolver` or `human` | Concrete `suggested_fix` proposed; caller applies after judgment |
| `manual` | `downstream-resolver` or `human` | Actionable work needing design input or handoff |
| `advisory` | `human` or `release` | Report-only — learnings, rollout notes, residual risk |

Routing rules:

- **Synthesis owns the final route.** Persona-provided routing metadata is input, not the last word.
- **Choose the more conservative route on disagreement.** A merged finding may move from `gated_auto` to `manual`, but never widen without stronger evidence.
- **Reject `safe_auto` and `review-fixer` if present** — drop the finding or remap to `gated_auto` / `downstream-resolver` during synthesis.
- **`requires_verification: true` means any caller-applied fix needs targeted tests or follow-up validation.**

## Reviewers

14 reviewer personas in layered conditionals, plus specialized agents. Quick roster with one-line triggers below; the persona catalog included at the bottom has the full per-persona selection criteria and spawn gates.

**Always-on (every review):** `correctness-reviewer`, `testing-reviewer`, `maintainability-reviewer`, `project-standards-reviewer`, plus specialized agents `agent-native-reviewer` and `learnings-researcher`.

**Cross-cutting conditional (per diff):**

- `security-reviewer` — auth, public endpoints, user input, permissions
- `performance-reviewer` — DB queries, data transforms, caching, async
- `api-contract-reviewer` — routes, serializers, type signatures, versioning
- `data-migration-reviewer` — migration files / schema dumps / backfills (see spawn gate in Stage 3)
- `reliability-reviewer` — error handling, retries, timeouts, background jobs
- `adversarial-reviewer` — >=50 changed code lines, or auth / payments / data mutations / external APIs
- `previous-comments-reviewer` — PR with existing review comments (PR-only, comment-gated)

**Stack-specific conditional (per diff):** `julik-frontend-races-reviewer` (Stimulus/Turbo, DOM events, async UI) and `swift-ios-reviewer` (Swift/SwiftUI/UIKit, entitlements, Core Data, `.pbxproj`).

**Conditional specialized (migration-specific):** `deployment-verification-agent` — deployment checklist + rollback when the migration gate applies and the change is risky.

## Review Scope

Every review spawns all 4 always-on personas plus the 2 specialized always-on agents, then adds whichever cross-cutting and stack-specific conditionals fit the diff. The model naturally right-sizes: a small config change triggers 0 conditionals = 6 reviewers. A Rails auth feature might trigger security + reliability + adversarial = 9 reviewers.

## Protected Artifacts

The following paths are pipeline artifacts and must never be flagged for deletion, removal, or gitignore by any reviewer:

- `docs/brainstorms/*` -- requirements documents
- `docs/plans/*.md` -- plan files (decision artifacts; execution progress is derived from git)
- `docs/solutions/*.md` -- solution documents

If a reviewer flags any file in these directories for cleanup or removal, discard that finding during synthesis.

## How to Run

### Stage 1: Determine scope

Compute the diff range, file list, and diff. Minimize permission prompts by combining into as few commands as possible.

**If `base:` argument is provided (fast path):**

The caller already knows the diff base. Skip all base-branch detection, remote resolution, and merge-base computation. Use the provided value directly:

```
BASE_ARG="{base_arg}"
BASE=$(git merge-base HEAD "$BASE_ARG" 2>/dev/null) || BASE="$BASE_ARG"
```

Then produce the same output as the other paths:

```
echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard
```

**If a PR number or GitHub URL is provided as an argument:**

Do **not** check out the PR branch. Scope comes from GitHub read APIs plus optional local alignment when HEAD already matches the PR head branch.

**Skip-condition pre-check.** Before scope detection, run a PR-state probe:

```
gh pr view <number-or-url> --json state,title,body,files
```

Apply skip rules in order:

- `state` is `CLOSED` or `MERGED` -> stop with reason `PR is closed/merged; not reviewing.`
- **Trivial-PR judgment**: spawn a lightweight sub-agent with the PR title, body, and changed file paths. The agent's task: "Is this an automated or trivial PR that does not warrant a code review?" If yes: stop with reason `PR appears to be a trivial automated PR; not reviewing.`

When any skip rule fires, stop without dispatching reviewers. **Default mode:** emit the reason as plain text. **`mode:agent`:** emit JSON only — `{"status":"skipped","reason":"<same message>"}`.

If no skip rule fires, fetch PR metadata **without checkout**:

```
gh pr view <number-or-url> --json title,body,baseRefName,headRefName,headRefOid,isCrossRepository,url,files,reviews,comments --jq '{title, body, baseRefName, headRefName, headRefOid, isCrossRepository, url, files: [.files[].path], hasPriorComments: ((.reviews | map(select(.state != "APPROVED" or .body != "")) | length) > 0 or (.comments | length) > 0)}'
```

Set `BASE:` to `pr:<number-or-url>` (logical marker — not a git SHA). Set `UNTRACKED:` from `git ls-files --others --exclude-standard` on the **current** checkout.

**PR scope mode.** Classify as **`local-aligned`** only when **all** of these hold; otherwise use **`pr-remote`**:

1. `git rev-parse --abbrev-ref HEAD` equals `headRefName`.
2. The PR is **not** cross-repository (`isCrossRepository` is false).
3. The PR head commit is contained in the local checkout: `git merge-base --is-ancestor <headRefOid> HEAD` exits 0.

**Diff by scope mode:**

- **`local-aligned`:** Resolve `<resolved-base-ref>` from `baseRefName` (fetch if needed). Compute `BASE=$(git merge-base HEAD <resolved-base-ref>)`, then set `FILES:` and `DIFF:` from `git diff -U10 $BASE`. Note in Coverage: `scope: local-aligned (PR; local tree diff)`.
- **`pr-remote`:** Set `FILES:` from the PR `files` array. Set `DIFF:` from `gh pr diff <number-or-url> --color=never`.

When **`pr-remote`**, before Stage 4:

1. Best-effort fetch PR head without checkout: `git fetch --no-tags origin <headRefName>:refs/review/pr-<number>-head`.
2. When fetch succeeds, set `PR_HEAD_REF=refs/review/pr-<number>-head` for reviewers and validators.
3. Best-effort fetch the PR base without checkout: `git fetch --no-tags origin <baseRefName>`. When it succeeds, set `PR_BASE_REF` to that SHA.
4. Include `<pr-scope-mode>pr-remote</pr-scope-mode>` and, when set, `<pr-head-ref>...</pr-head-ref>` and `<pr-base-ref>...</pr-base-ref>` in the Stage 4 review context bundle.

Reviewers and Stage 5b validators in **`pr-remote`** mode must **not** Read/Grep workspace paths for files in `FILES:`. Inspect via `git show <PR_HEAD_REF>:<path>` when `PR_HEAD_REF` is set, otherwise use only the provided diff hunks.

**If a branch name is provided as an argument:**

Substitute the provided branch name as `<branch>`. Do **not** check out `<branch>`.

If `git rev-parse --abbrev-ref HEAD` equals `<branch>`, use the **standalone (current branch)** path below.

Otherwise diff the remote/local ref **without checkout**:

1. Try `gh pr view <branch> --json baseRefName,url,headRefName` — if a PR exists, prefer the **PR number/URL path** above.
2. Else resolve `<branch>` as `origin/<branch>` or `<branch>` after `git fetch --no-tags origin <branch>` when needed.
3. Resolve default base branch. Compute `BASE=$(git merge-base <base-ref> <branch-ref>)` and `git diff -U10 $BASE <branch-ref>`.

**If no argument (standalone on current branch):**

Apply the same base-detection logic as branch mode above, using the current branch.

If no base can be resolved, **stop**. Do not fall back to `git diff HEAD`.

On success, produce the diff:

```
echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard
```

**Untracked file handling:** Always inspect `UNTRACKED:`. Untracked paths are out of scope unless staged. When non-empty, list excluded files in Coverage and continue on tracked changes only.

### Stage 2: Intent discovery

Understand what the change is trying to accomplish:

**PR/URL mode:** Use the PR title, body, and linked issues from `gh pr view` metadata.

**Branch mode:** Run `git log --oneline ${BASE}..<branch-ref>`.

**Standalone (current branch):** Run:

```
echo "BRANCH:" && git rev-parse --abbrev-ref HEAD && echo "COMMITS:" && git log --oneline ${BASE}..HEAD
```

Combined with conversation context, write a 2-3 line intent summary:

```
Intent: Simplify tax calculation by replacing the multi-tier rate lookup
with a flat-rate computation. Must not regress edge cases in tax-exempt handling.
```

Pass this to every reviewer in their spawn prompt. Intent shapes *how hard each reviewer looks*, not which reviewers are selected.

**When intent is ambiguous:** Infer from branch name, commits, PR title/body, diff, `plan:`, and conversation. Write the best-effort intent summary and note uncertainty in Coverage — never block on a clarifying question.

### Stage 2b: Plan discovery (requirements verification)

Locate the plan document so Stage 6 can verify requirements completeness. Check these sources in priority order — stop at the first hit:

1. **`plan:` argument.** If the caller passed a plan path, use it directly.
2. **PR body.** Scan the body for paths matching `docs/plans/*.md`. If exactly one match exists, use it as `plan_source: explicit`.
3. **Auto-discover.** Extract 2-3 keywords from the branch name. Glob `docs/plans/*` and filter filenames containing those keywords. If exactly one match, use it. If multiple or ambiguous, skip.

**Confidence tagging:** Record how the plan was found:
- `plan:` argument -> `plan_source: explicit`
- Single unambiguous PR body match -> `plan_source: explicit`
- Multiple/ambiguous PR body matches -> `plan_source: inferred`
- Auto-discover with single match -> `plan_source: inferred`

If a plan is found, read its **Requirements** section and the R-IDs listed there, plus **Implementation Units**. Store the extracted requirements list and `plan_source` for Stage 6. Do not block the review if no plan is found.

### Stage 3: Select reviewers

Read the diff and file list from Stage 1. The 4 always-on personas and 2 specialized always-on agents are automatic. For each cross-cutting and stack-specific conditional persona, decide whether the diff warrants it. This is agent judgment, not keyword matching.

**File-type awareness for conditional selection:** Instruction-prose files (Markdown skill definitions, JSON schemas, config files) are product code but do not benefit from runtime-focused reviewers. For diffs that only change instruction-prose files, skip adversarial unless the prose describes auth, payment, or data-mutation behavior.

**`previous-comments` is PR-only AND comment-gated.** Only select when both conditions hold:

1. Stage 1 gathered PR metadata.
2. `hasPriorComments` from Stage 1 is true.

**`data-migration` spawn gate.** Select `data-migration-reviewer` only when the diff includes at least one migration or schema artifact: `db/migrate/*`, `db/schema.rb`, `db/structure.sql`, Alembic/Flyway/Liquibase migration paths, or explicit backfill/data-transform scripts.

For `deployment-verification-agent`, use the same migration-artifact gate when the change is risky.

Announce the team before spawning:

```
Review team:
- correctness (always)
- testing (always)
- maintainability (always)
- project-standards (always)
- agent-native-reviewer (always)
- learnings-researcher (always)
- security -- new endpoint in routes.rb accepts user-provided redirect URL
- julik-frontend-races -- Stimulus controller with async DOM updates
- data-migration -- adds migration 20260303_add_index_to_orders
- deployment-verification-agent -- destructive migration with backfill
```

### Stage 3b: Discover project standards paths

Before spawning sub-agents, find the file paths of all relevant standards files for the `project-standards` persona:

1. Use the native file-search/glob tool to find all `**/CLAUDE.md` and `**/AGENTS.md` in the repo.
2. Filter to those whose directory is an ancestor of at least one changed file.

Pass the resulting path list to the `project-standards` persona inside a `<standards-paths>` block in its review context.

### Stage 4: Spawn sub-agents

#### Model tiering

Three reviewers inherit the session model with no override: `correctness-reviewer`, `security-reviewer`, and `adversarial-reviewer`. All other persona sub-agents and specialized agents use the platform's mid-tier model to reduce cost and latency.

#### Run ID

Generate a unique run identifier before dispatching any agents.

```bash
RUN_ID=$(date +%Y%m%d-%H%M%S)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' ')
mkdir -p "/tmp/code-review/$RUN_ID"
```

Pass `{run_id}` to every persona sub-agent so they can write their full analysis to `/tmp/code-review/{run_id}/{reviewer_name}.json`.

**Large shared context — pass paths, not contents.** The diff and file list go to every reviewer. When inlining them into each subagent prompt would be wasteful, write them once into the run dir (e.g. `full.diff`, `files.txt`) and pass those **paths** instead.

#### Spawning

Omit the `mode` parameter when dispatching sub-agents so the user's configured permission settings apply. Do not pass `mode: "auto"`.

**Model override at dispatch time.** Pass the platform's mid-tier model on every dispatch except `correctness-reviewer`, `security-reviewer`, and `adversarial-reviewer`, which inherit the session model.

**Bounded parallel dispatch.** Respect the current harness's active-subagent limit. Queue selected reviewers, dispatch only as many as the harness accepts, and fill freed slots as reviewers complete. Treat active-agent/thread/concurrency-limit spawn errors as backpressure, not reviewer failure.

Spawn each selected persona reviewer using the subagent template. Each persona sub-agent receives:

1. Their persona file content (identity, failure modes, calibration, suppress conditions)
2. Shared diff-scope rules from `references/diff-scope.md`
3. The JSON output contract from `references/findings-schema.json`
4. PR metadata: title, body, and URL when reviewing a PR
5. Review context: intent summary, file list, diff, scope mode, and remote head ref when set
6. Run ID and reviewer name for the artifact file path
7. **For `project-standards` only:** the standards file path list from Stage 3b
8. **For `data-migration` only:** the resolved review base ref from Stage 1

Persona sub-agents are **read-only** with respect to the project: they review and return structured JSON. They do not edit project files or propose refactors. The one permitted write is saving their full analysis to the run-artifact path.

Each persona sub-agent writes full JSON to `/tmp/code-review/{run_id}/{reviewer_name}.json` and returns compact JSON with merge-tier fields only:

```json
{
  "reviewer": "security",
  "findings": [
    {
      "title": "User-supplied ID in account lookup without ownership check",
      "severity": "P0",
      "file": "orders_controller.rb",
      "line": 42,
      "confidence": 100,
      "autofix_class": "gated_auto",
      "owner": "downstream-resolver",
      "requires_verification": true,
      "pre_existing": false,
      "suggested_fix": "Add current_user.owns?(account) guard before lookup"
    }
  ],
  "residual_risks": [...],
  "testing_gaps": [...]
}
```

**Specialized always-on agents** (`agent-native-reviewer`, `learnings-researcher`) are dispatched as standard agent calls through the same bounded parallel scheduler. Give them the same review context bundle the personas receive.

**Conditional specialized agents** (`deployment-verification-agent` only) are dispatched when the migration-artifact gate applies. Pass the same review context bundle plus the applicability reason.

### Stage 5: Merge findings

Convert multiple reviewer compact JSON returns into one deduplicated, confidence-gated finding set.

1. **Validate.** Check each compact return for required top-level and per-finding fields, plus value constraints. Drop malformed returns or findings.
   - **Top-level required:** reviewer (string), findings (array), residual_risks (array), testing_gaps (array).
   - **Per-finding required:** title, severity, file, line, confidence, autofix_class, owner, requires_verification, pre_existing
   - **Value constraints:** severity: P0-P3; autofix_class: gated_auto|manual|advisory; owner: downstream-resolver|human|release; confidence: integer in {0, 25, 50, 75, 100}; line: positive integer; pre_existing, requires_verification: boolean

2. **Deduplicate.** Compute fingerprint: `normalize(file) + line_bucket(line, +/-3) + normalize(title)`. When fingerprints match, merge: keep highest severity, keep highest anchor, note which reviewers flagged it.

3. **Cross-reviewer agreement.** When 2+ independent reviewers flag the same issue (same fingerprint), promote the merged finding by one anchor step: `50 -> 75`, `75 -> 100`, `100 -> 100`.

4. **Separate pre-existing.** Pull out findings with `pre_existing: true` into a separate list.

5. **Resolve disagreements.** When reviewers flag the same code region but disagree on severity, autofix_class, or owner, annotate the Reviewer column with the disagreement.

6. **Normalize routing.** For each merged finding, set the final `autofix_class`, `owner`, and `requires_verification`. Remap any legacy `safe_auto` or `review-fixer` to `gated_auto` / `downstream-resolver`.

6b. **Mode-aware demotion of weak general-quality findings.** Reroute weak signal to existing soft buckets so the primary findings table stays focused.

A finding qualifies for demotion when **all** of these hold:
   - Severity is P2 or P3 (P0 and P1 always stay in primary findings)
   - `autofix_class` is `advisory`
   - **All** contributing reviewers are `testing` or `maintainability` — if any other persona also flagged this finding, it stays in primary

When a finding qualifies:
   - If the contributing reviewer is `testing`, append to `testing_gaps`. If `maintainability`, append to `residual_risks`.

7. **Confidence gate.** After dedup, promotion, and demotion, suppress remaining findings below anchor 75. Exception: P0 findings at anchor 50+ survive the gate. Record the suppressed count by anchor.

8. **Partition the work.** Build two sets:
   - actionable queue: `gated_auto` or `manual` findings whose owner is `downstream-resolver`
   - report-only queue: `advisory` findings plus anything owned by `human` or `release`

9. **Sort and number.** Order by severity (P0 first) -> anchor (descending) -> file path -> line number, then assign monotonically increasing `#` values. Do not restart numbering inside each severity table or triage group.

9b. **Build thematic triage groups.** After stable `#` values exist, group related findings so the reader can triage themes instead of items.
   - **`grouping:off`:** skip this step.
   - **`grouping:auto` (default):** build groups when findings span distinct concerns.
   - **`grouping:always`:** always build groups.
   - **Grouping signals:** shared root cause, affected subsystem, user-facing failure mode, overlapping fix path, dependency ordering.
   - **Group shape:** short title, the included stable finding `#`s, one-line context, preferred resolution, and why.
   - **Ordering:** order groups by the highest-severity finding they contain, then by lowest stable `#`.

10. **Collect coverage data.** Union residual_risks and testing_gaps across reviewers.

11. **Preserve specialized agent artifacts.** Keep the learnings, agent-native, and deployment-verification outputs alongside the merged finding set.

### Stage 5b: Validation pass (optional quality gate)

Independent verification gate. Spawn one validator sub-agent per surviving finding using `references/validator-template.md`. Findings the validator rejects are dropped; confirmed findings flow through unchanged.

**When this stage runs:** After Stage 5 whenever at least one finding survives — skip only when zero survive.

**Steps:**

1. **Select findings to validate.** All survivors of Stage 5.
2. **Apply dispatch budget cap.** If the selected set exceeds 15 findings, validate the highest-severity 15, dropping only from the P2/P3 tail. **Never drop a P0 or P1 from validation.**
3. **Spawn validators with bounded parallelism.** One sub-agent per finding. Each validator receives the finding's title, severity, file, line, suggested_fix, original reviewer name, confidence anchor, why_it_matters (when available), the full diff, scope mode, and remote head ref.
4. **Collect verdicts.** Each validator returns `{ "validated": true | false, "reason": "<one sentence>" }`.
   - `validated: true` -> finding survives unchanged into Stage 6
   - `validated: false` -> finding is dropped; record the validator's reason in Coverage
   - Validator **infrastructure** failure: for P2/P3, drop. For P0/P1, keep and mark **degraded**.
5. **Use mid-tier model for validators.**
6. **Record metrics for Coverage.**
7. **Prune triage groups after drops.** When validation dropped any finding, rebuild or prune `triage_groups`.

**Orchestrator direct verification.** When a finding hinges on a fact the orchestrator can check cheaply and authoritatively, verify it directly. This may replace the independent validator only for P2/P3 at anchor 100 (verifiable from code alone). For P0/P1, the per-finding validator wave is required.

### Stage 5c: Act on findings (default mode only)

**Skip entirely in `mode:agent`** — that mode is a machine handoff and the caller owns apply.

**Act policy (bias to act).** Default to applying every finding that is a clear improvement and a reversible edit, regardless of severity:

- **Apply** clear improvements — the common case.
- **Push back** — do not apply — when the reviewer is wrong; keep the finding and state the disagreement with reasoning.
- **Skip with judgment** taste calls and conflicting suggestions, but surface what was skipped and why. Never silently drop.

**Scope invariant.** Apply only when the working tree *is* what was reviewed — `local-aligned` or standalone. In `pr-remote` / `branch-remote` do not apply — report instead.

**Verify, then keep.** After applying, run the affected tests and lint. If they fail, revert that fix and report it as a finding instead.

**Commit when the pre-review tree was clean.** Before applying, note whether the working tree already had uncommitted changes.

- **Clean before the review:** after applying and verifying, commit the fixes as one isolated, review-labeled fix commit — `fix(review): <summary>`.
- **Dirty before the review:** apply but do **not** commit — the fixes interleave with the user's in-flight work.
- **Never push, open a PR, or file tickets** — that's the outward-facing step the user owns.

**Surface green-but-unverifiable edits.** When an applied fix touches auth/authz, a public or cross-service contract/schema, or concurrency/ordering, flag it prominently in the Applied section.

**Re-partition triage groups after apply.** Prune applied findings out of `triage_groups` before Stage 6 rendering.

### Stage 6: Synthesize and present

Assemble the final report. **Default:** pipe-delimited markdown tables for findings. **`mode:agent`:** skip markdown and emit JSON.

**Before writing the report, load `references/review-output-template.md` and mirror it** — that file is the canonical skeleton.

**Findings table shape (default mode).** Every finding is a row in a pipe-delimited table grouped by severity:

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 1 | `path/to/file.go:42` | One terse line — the scannable index | correctness | 100 |

- **#1** — full explanation here as a keyed detail line under the table.

Per-severity tables are **5 columns** — `Route` is not shown here. Keep the `Issue` cell to **one short clause** — it is the scannable index, not the explanation.

**Never produce these shapes (instant fail):**
- Any row rendered as `Field:`-prefixed blocks (`#:` / `Sev:` / `File:` / `Issue:`)
- Per-row separators made of horizontal rules or box-drawing characters
- A table replaced by a plain bulleted/numbered list
- Unicode separators or arrows in cells (middot `·`); use ASCII `->`
- **Inconsistent treatment across severities or sections**

1. **Header.** Scope, intent, mode, reviewer team with per-conditional justifications.
2. **Applied (default mode only).** When Stage 5c applied fixes, list them first as a pipe table `| # | File | Fix | Reviewer |`, then a one-line validation outcome and commit status. Omit in `mode:agent` and when nothing was applied.
2b. **Triage Groups.** When finalized `triage_groups` exist, render as `| Group | Findings | Context | Preferred Resolution | Why |` before the severity tables.
3. **Findings.** Pipe-delimited tables grouped by severity (`### P0 -- Critical`, `### P1 -- High`, `### P2 -- Moderate`, `### P3 -- Low`). Omit empty severity levels.
4. **Requirements Completeness.** Include only when a plan was found in Stage 2b. For each requirement and implementation unit, report whether corresponding work appears in the diff.
5. **Actionable Findings.** Include when the actionable queue is non-empty.
6. **Pre-existing.** Separate section, does not count toward verdict.
7. **Learnings & Past Solutions.** Surface learnings-researcher results.
8. **Agent-Native Gaps.** Surface agent-native-reviewer results. Omit if no gaps found.
9. **Deployment Notes.** If deployment-verification-agent ran, surface the key Go/No-Go items.
10. **Coverage.** Suppressed count by anchor, demotion count, validator drop count, residual risks, testing gaps, failed reviewers.
11. **Verdict.** Ready to merge / Ready with fixes / Not ready. Fix order if applicable.

Do not include time estimates.

**Format verification (default only — last gate before delivering).** Before delivering, scan **every table** for forbidden shapes. If any table hit one, STOP and re-render it before delivering.

### JSON output format (`mode:agent` only)

Emit **one raw JSON object** as the primary response — a single bare JSON value, **no markdown code fence**. Also write `review.json` under `/tmp/code-review/<run-id>/` with the same payload.

Minimum shape:

```json
{
  "status": "complete",
  "verdict": "Ready to merge | Ready with fixes | Not ready",
  "scope": {
    "base": "<merge-base sha, pr:NNN marker, or base: ref>",
    "branch": "<current branch name>",
    "head_sha": "<git rev-parse HEAD>",
    "pr_url": "<url or null>",
    "files_changed": 0
  },
  "intent": "<2-3 line summary>",
  "intent_confidence": "explicit | inferred | uncertain",
  "reviewers": ["correctness", "security"],
  "findings": [],
  "actionable_findings": [],
  "triage_groups": [],
  "pre_existing_findings": [],
  "requirements_completeness": null,
  "learnings": [],
  "agent_native_gaps": [],
  "deployment_notes": [],
  "residual_risks": [],
  "testing_gaps": [],
  "coverage": {},
  "artifact_path": "/tmp/code-review/<run-id>/",
  "run_id": "<run-id>"
}
```

Each object in `findings` uses the merged finding fields: `#`, `title`, `severity`, `file`, `line`, `confidence`, `autofix_class`, `owner`, `requires_verification`, `pre_existing`, `suggested_fix`, `why_it_matters`, `evidence`, `reviewers`.

`actionable_findings` lists the `gated_auto` / `manual` + `downstream-resolver` subset.

Each object in `triage_groups` carries `{ "title", "findings": [<stable #s>], "context", "preferred_resolution", "why" }`. Groups span the full finding set — a triage lens, not an apply queue. A caller batching related fixes by theme must first intersect each group's `findings` with `actionable_findings`.

On failure before review completes, set `"status": "failed"` and `"reason": "<one sentence>"`. When all reviewers fail, use `"status": "degraded"`. When a PR skip rule fires, use `"status": "skipped"`.

## Quality Gates

Before delivering the review, verify:

1. **Every finding is actionable.** Re-read each finding. If it says "consider" or "might want to" without a concrete fix, rewrite it.
2. **No false positives from skimming.** Verify the surrounding code was actually read.
3. **Severity is calibrated.** A style nit is never P0. A SQL injection is never P3.
4. **Line numbers are accurate.** Verify each cited line number against the file content.
5. **Protected artifacts are respected.** Discard findings recommending deletion of pipeline artifacts.
6. **Findings don't duplicate linter output.** Focus on semantic issues.

## Language-Aware Conditionals

Stack-specific reviewers fire only when the diff touches runtime behavior they specialize in — never mechanically from file extensions alone. Structural quality lives in the always-on `maintainability-reviewer`.

## After Review

After Stage 6, stop. Never push, open PRs, or file tickets from this skill.

### Emit actionable findings summary (default mode only)

After Stage 6 **in default mode**, emit a compact **Actionable Findings** summary:

- List each actionable finding with stable `#`, severity, file:line, title, `autofix_class`, whether `suggested_fix` is present, and `confidence`.
- Include the run-artifact path: `/tmp/code-review/<run-id>/`
- When the actionable queue is empty, state `Actionable findings: none.` explicitly.

In `mode:agent` do **not** emit this markdown summary — the actionable findings are carried solely by the JSON object.

### Mode-specific completion

| Mode | After Stage 6 + actionable summary |
|------|-----------------------------------|
| **Default** | Markdown tables + Actionable Findings summary. |
| **`mode:agent`** | JSON object + `review.json` in run artifact dir. |

Do not offer push/PR/create-branch next steps from this skill.

#### Run artifacts

Always write run artifacts under `/tmp/code-review/<run-id>/`:

- synthesized findings
- actionable findings list
- advisory outputs
- per-agent `{reviewer_name}.json` from Stage 4
- `report.md` — the rendered markdown report exactly as presented to the user (default mode only)

`metadata.json` minimum fields:

```json
{
  "run_id": "<run-id>",
  "branch": "<git branch --show-current at dispatch time>",
  "head_sha": "<git rev-parse HEAD at dispatch time>",
  "verdict": "<Ready to merge | Ready with fixes | Not ready>",
  "completed_at": "<ISO 8601 UTC timestamp>"
}
```

## Fallback

If the platform doesn't support parallel sub-agents, run reviewers sequentially. Everything else (stages, output format, merge pipeline) stays the same.

---

## Included References

The files below are inlined at load time. The review output template is **not** inlined — Stage 6 loads it on demand (`references/review-output-template.md`).

### Persona Catalog

@./references/persona-catalog.md

### Subagent Template

@./references/subagent-template.md

### Diff Scope Rules

@./references/diff-scope.md

### Action class rubric

@./references/action-class-rubric.md

### Findings Schema

@./references/findings-schema.json
