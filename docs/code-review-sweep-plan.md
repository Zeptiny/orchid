# Code Review Sweep Plan — Full Application

**Mode:** `report-only` (no checkout mutation, safe for full-codebase sweep)
**Scope:** 7 top-level Python packages under `src/stupidex/`
**Run date:** 2026-06-20
**Reviewer reduction:** `ce-learnings-researcher` dropped (no `docs/solutions/` present, would return empty on every run)

---

## 1. Reviewer Dispatch Table

`correctness`, `security`, `adversarial` inherit the **session model** (highest stakes). All others use the **mid-tier model** to control cost.

| Module | Agent | Model tier | Asked to do | Why selected |
|---|---|---|---|---|
| `domain/` | `ce-correctness-reviewer` | session | Find logic/edge-case/state bugs in sessions, messages, chains, todos, skills, tools | Always-on |
| `domain/` | `ce-testing-reviewer` | mid | Flag coverage gaps / brittle assertions in `tests/domain_*` | Always-on |
| `domain/` | `ce-maintainability-reviewer` | mid | Coupling, naming, dead code in domain models | Always-on |
| `domain/` | `ce-project-standards-reviewer` | mid | AGENTS.md / repo conventions, frontmatter, naming | Always-on |
| `domain/` | `ce-agent-native-reviewer` | mid | Confirm agent tool surface mirrors user surface | Always-on |
| `domain/` | `ce-adversarial-reviewer` | session | Race conditions in session persistence, message ordering | >=50 changed lines + mutates state |
| `domain/` | `ce-reliability-reviewer` | mid | Error propagation, ID generation, replay safety | Session save/load is async + persistent |
| `domain/` | `ce-kieran-python-reviewer` | mid | Pythonic clarity, type hints, dataclass usage | Python module |
| `tools/` | `ce-correctness-reviewer` | session | Logic/edge-case/state bugs across all tools | Always-on |
| `tools/` | `ce-testing-reviewer` | mid | Coverage of exec, file manip, AST, search, rag tools | Always-on |
| `tools/` | `ce-maintainability-reviewer` | mid | Duplication across tool implementations | Always-on |
| `tools/` | `ce-project-standards-reviewer` | mid | Conventions across tool definitions | Always-on |
| `tools/` | `ce-agent-native-reviewer` | mid | Tools accessible to subagents, not just UI | Always-on |
| `tools/` | `ce-adversarial-reviewer` | session | Shell injection, path traversal, exec sandbox escape, MCP abuse | >=50 lines + executes user code + network |
| `tools/` | `ce-security-reviewer` | session | Input validation in `exec.py`, `file_manipulation.py`, `web_fetch.py`, `ast.py` | Auth boundary, user input, code execution |
| `tools/` | `ce-reliability-reviewer` | mid | Tool timeout handling, MCP aclose cleanup, async error paths | Async tool results + recent CancelledError fix commits |
| `tools/` | `ce-performance-reviewer` | mid | Search latency, RAG embedding batching | Mid-tier perf surface |
| `tools/` | `ce-kieran-python-reviewer` | mid | Pythonic clarity across tool surface | Python module |
| `llm/` | `ce-correctness-reviewer` | session | Provider dispatch bugs, message ordering, tool_call/tool_result pairing | Always-on; recent commits fix exactly these |
| `llm/` | `ce-testing-reviewer` | mid | Coverage of client + provider branching | Always-on |
| `llm/` | `ce-maintainability-reviewer` | mid | Static vs dynamic system prompt split, provider abstraction quality | Always-on |
| `llm/` | `ce-project-standards-reviewer` | mid | Conventions | Always-on |
| `llm/` | `ce-agent-native-reviewer` | mid | Dynamic system prompt accessible to agents | Always-on |
| `llm/` | `ce-adversarial-reviewer` | session | Prompt injection via tool results, message replay attacks, provider divergence | >=50 lines + sensitive boundary |
| `llm/` | `ce-security-reviewer` | session | API key handling, provider URL validation | Network + auth |
| `llm/` | `ce-reliability-reviewer` | mid | Retry behavior, timeout, partial response handling | Network client |
| `llm/` | `ce-kieran-python-reviewer` | mid | Pythonic clarity | Python module |
| `screens/` | `ce-correctness-reviewer` | session | Modal/picker state bugs, focus handling | Always-on |
| `screens/` | `ce-testing-reviewer` | mid | Coverage of settings/picker flows | Always-on |
| `screens/` | `ce-maintainability-reviewer` | mid | Modal reuse, widget coupling | Always-on |
| `screens/` | `ce-project-standards-reviewer` | mid | Conventions | Always-on |
| `screens/` | `ce-agent-native-reviewer` | mid | Settings flows reachable by agents? | Always-on (likely advisory-only) |
| `screens/` | `ce-kieran-python-reviewer` | mid | Pythonic clarity | Python module |
| `agents/` | `ce-correctness-reviewer` | session | Manager state bugs, subagent lifecycle, persistence replay | Always-on; recent fixes target this |
| `agents/` | `ce-testing-reviewer` | mid | Coverage of manager / persistence replay | Always-on |
| `agents/` | `ce-maintainability-reviewer` | mid | Manager abstraction quality, persistence design | Always-on |
| `agents/` | `ce-project-standards-reviewer` | mid | Conventions | Always-on |
| `agents/` | `ce-agent-native-reviewer` | mid | Subagent tools == user tools parity | Always-on; core to this module |
| `agents/` | `ce-adversarial-reviewer` | session | Subagent privilege escalation, parallel agent races, cancel-scope misuse | Recent fix commits about parallel/cancel corner cases |
| `agents/` | `ce-reliability-reviewer` | mid | Async lifecycle, persistence idempotency, cancellation cleanup | Async + persistent state + cancel fixes |
| `agents/` | `ce-kieran-python-reviewer` | mid | Pythonic clarity | Python module |
| `rag/` | `ce-correctness-reviewer` | session | Index/chunk correctness, off-by-one, embedding collisions | Always-on |
| `rag/` | `ce-testing-reviewer` | mid | Coverage of chunker/indexer | Always-on |
| `rag/` | `ce-maintainability-reviewer` | mid | Indexer abstraction, storage format | Always-on |
| `rag/` | `ce-project-standards-reviewer` | mid | Conventions | Always-on |
| `rag/` | `ce-agent-native-reviewer` | mid | RAG accessible to agents? | Always-on |
| `rag/` | `ce-performance-reviewer` | mid | Embedding model wall-clock, numpy matmul, indexer I/O | fastembed + numpy + persistence |
| `rag/` | `ce-kieran-python-reviewer` | mid | Pythonic clarity | Python module |
| `mcp/` | `ce-correctness-reviewer` | session | Schema correctness, server lifecycle bugs | Always-on |
| `mcp/` | `ce-testing-reviewer` | mid | Coverage of schema/server | Always-on |
| `mcp/` | `ce-maintainability-reviewer` | mid | Server abstraction, schema duplication with tools/ | Always-on |
| `mcp/` | `ce-project-standards-reviewer` | mid | Conventions | Always-on |
| `mcp/` | `ce-agent-native-reviewer` | mid | MCP tools reachable from agents | Always-on |
| `mcp/` | `ce-adversarial-reviewer` | session | MCP resource poisoning, server spoofing, transport abuse | >=50 lines + external transport |
| `mcp/` | `ce-security-reviewer` | session | Resource URL validation, server attestation, sandbox escapes | External transport + user config |
| `mcp/` | `ce-reliability-reviewer` | mid | aclose() cleanup, transport timeout, partial-resource handling | Recent CancelledError fix commits |
| `mcp/` | `ce-kieran-python-reviewer` | mid | Pythonic clarity | Python module |

**Total dispatches:** 55

---

## 2. What Each Subagent Is Given (Stage 4 prompt payload)

Every dispatch receives the same structured bundle:

1. **Persona spec file** — identity, failure modes, calibration, suppress conditions
2. **Diff-scope rules** — shared reference document
3. **JSON output contract** — required top-level and per-finding fields (see §3)
4. **PR context block** (empty — report-only, no PR target)
5. **Review context:**
   - Intent summary (2–3 lines — per-module, written by the orchestrator from filename + responsibility inspection)
   - File list for the module
   - Full diff (`git diff $BASE` for that module's package)
   - Untracked-files list
6. **Run ID** (each module gets its own `/tmp/compound-engineering/ce-code-review/<run-id>/`)
7. **For `project-standards` only:** `<standards-paths>` block listing all `AGENTS.md` / `AGENTS.md` files whose directory is an ancestor of a changed file in that module

Persona output is **read-only**: no checkout edits, no commits, no PRs. Each persona writes its full analysis JSON to `/tmp/compound-engineering/ce-code-review/<run-id>/<reviewer>.json` and returns a compact merge-tier JSON only.

---

## 3. What Each Subagent Returns

### Compact JSON (returned inline to the orchestrator)

Required merge-tier fields:

```json
{
  "reviewer": "correctness",
  "findings": [
    {
      "title": "<short description>",
      "severity": "P0|P1|P2|P3",
      "file": "<relative path>",
      "line": <positive int>,
      "confidence": 0|25|50|75|100,
      "autofix_class": "safe_auto|gated_auto|manual|advisory",
      "owner": "review-fixer|downstream-resolver|human|release",
      "requires_verification": <bool>,
      "pre_existing": <bool>,
      "suggested_fix": "<optional; included when reviewer has a concrete fix>"
    }
  ],
  "residual_risks": ["..."],
  "testing_gaps": ["..."]
}
```

### Artifact file (`/tmp/compound-engineering/ce-code-review/<run-id>/<reviewer>.json`)

Full schema — compact fields plus:
- `why_it_matters` — the impact rationale
- `evidence[]` — code excerpts, line ranges, supporting context

Loaded only during cross-module synthesis (§5), not loaded during per-module merge (Stage 5 keeps context light).

---

## 4. Per-Module Return Handling (Stage 5)

Each module run produces a merged finding set via this pipeline:

1. **Validate** — drop returns missing top-level/per-finding fields or with out-of-range values; record drop count.
2. **Deduplicate within module** — fingerprint = `normalize(file) + line_bucket(±3) + normalize(title)`. When two findings match, keep highest severity + highest confidence anchor; record contributing reviewers.
3. **Cross-reviewer promotion** — when 2+ independent reviewers flag the same fingerprint, bump confidence one anchor step: `50→75`, `75→100`, `100→100`.
4. **Separate pre-existing** — findings with `pre_existing: true` move to a separate list.
5. **Disagreement resolution** — record per-finding disagreement in the Reviewer column (`security (P0), correctness (P1) — kept P0`).
6. **Final routing** — synthesize keeps the most conservative route. Collapse `safe_auto → gated_auto/manual` is allowed; widening never is.
7. **Mode-aware demotion** — P2/P3 + `advisory` + contributors all from testing OR maintainability → soft-bucket to `testing_gaps` / `residual_risks`. (Report-only mode does not suppress, just reroutes.)
8. **Confidence gate** — drop findings below anchor 75, EXCEPT P0 findings at anchor 50+ survive.
9. **Partition** into: in-skill fixer queue (safe_auto only — empty in report-only), residual actionable queue (gated_auto/manual owned by downstream-resolver), report-only queue (advisory + human/release owned).
10. **Sort** by severity → confidence desc → file → line.
11. **Union** residual_risks + testing_gaps across reviewers of this module.

Each module run produces:
- A merged-finding JSON file: `/tmp/compound-engineering/ce-code-review/<module-run-id>/merged.json`
- Coverage data union for the module

---

## 5. Cross-Module Reconciliation (Synthesis → Final Report)

After all 7 module runs complete, a second-pass synthesis loads each module's `merged.json` and applies the **same Stage 5 rules across modules**:

1. **Cross-module dedup** — same fingerprint rule. Same bug surfaced by `tools/exec.py` and `mcp/example_server.py` (both run user code) collapses to one finding.
2. **Cross-module promotion** — if a finding is flagged by reviewers in two different module runs, bump confidence anchor.
3. **Final confidence gate** — same rule (drop <75 except P0 at ≥50).
4. **Load detail tier** — pull `why_it_matters` + `evidence` from each surviving finding's per-agent artifact file across all module run IDs.
5. **Build final unified finding set** — single P0–P3 ordered list with Reviewer column showing every contributing persona and module.

### Final report markdown

Output to: `docs/code-review-reports/2026-06-20-full-sweep.md`

Structure:

```markdown
# Code Review Report — Full Application Sweep
Date: 2026-06-20
Mode: report-only
Modules reviewed: domain, tools, llm, screens, agents, rag, mcp (55 dispatches)
Reviewer count: 5 always-on (learnings-researcher dropped) + per-module conditionals

## Coverage
- Files reviewed: <count>
- Lines reviewed: <count>
- Reviewers dispatched: 55
- Reviewers returned results: N / 55
- Findings suppressed at anchor 50: N
- Findings suppressed at anchor 25: N
- Pre-existing findings: N (separate list)
- Mode-aware demotions to soft buckets: N
- Plan source: none (full-codebase sweep, no plan doc)

## Verdict
<2–4 sentences — overall code health, top themes, must-fix items>

## Findings

### P0 — Must fix before merge
| # | Title | File:line | Reviewer(s) | Confidence | Class | Owner | Why it matters | Suggested fix |
|---|-------|-----------|-------------|------------|-------|-------|-----------------|---------------|
| 1 | ... | src/stupidex/tools/exec.py:42 | security, correctness | 100 | gated_auto | downstream-resolver | <why> | <fix> |

### P1 — Should fix
<same table format>

### P2 — Fix if straightforward
<same table format>

### P3 — User's discretion
<same table format>

## Residual Risks (advisory / human / release)
- <file:line> — <title> — <reviewer>

## Testing Gaps
- <file:line> — <title> — <reviewer>

## Pre-Existing Findings (not introduced by this sweep's scope)
| Title | File:line | Reviewer | Severity | Notes |
|-------|-----------|----------|----------|-------|

## Per-Module Coverage Matrix
| Module | Files | Findings | P0 | P1 | P2 | P3 | Suppressions |
|--------|-------|----------|----|----|----|----|-------------|
| domain/ | N | N | N | N | N | N | N |
| tools/ | ... | | | | | | |
| llm/ | ... | | | | | | |
| screens/ | ... | | | | | | |
| agents/ | ... | | | | | | |
| rag/ | ... | | | | | | |
| mcp/ | ... | | | | | | |

## Run Artifacts
- domain run: /tmp/compound-engineering/ce-code-review/<id>/merged.json
- tools run: /tmp/compound-engineering/ce-code-review/<id>/merged.json
- (one per module + final synthesis)
- Final synthesis: /tmp/compound-engineering/ce-code-review/<final-id>/synthesis.json

## Next Steps
1. Triage P0 findings — these block any next release
2. Pair each P0/P1 gated_auto + manual finding with a `downstream-resolver` ticket
3. Hand `safe_auto` findings (if any surfaced despite report-only) to ce-simplify-code for cleanup pass
4. Re-run targeted review on fixed modules before merging
```

---

## 6. Severity Rubric (applied uniformly across modules)

| Level | Meaning | Action |
|---|---|---|
| P0 | Critical breakage, exploitable vulnerability, data loss/corruption | Must fix before merge |
| P1 | High-impact defect likely hit in normal usage, breaking contract | Should fix |
| P2 | Moderate issue with meaningful downside (edge case, perf regression, maintainability trap) | Fix if straightforward |
| P3 | Low-impact, narrow scope, minor improvement | User's discretion |

## 7. Routing Rubric

| `autofix_class` | Default owner | Post-sweep handling |
|---|---|---|
| `safe_auto` | review-fixer | In a follow-up pass: dispatched the fixer to apply, then re-review |
| `gated_auto` | downstream-resolver or human | Concrete fix exists but crosses behavior / contract / permission boundary — ticketed for explicit review |
| `manual` | downstream-resolver or human | Actionable work handed off rather than fixed in-skill |
| `advisory` | human or release | Report-only learnings, rollout notes, residual risk — documented in final report |

## 8. Recommended Action Mapping (for review-markdown "Suggested Fix" column presence)

| `autofix_class` | `suggested_fix` present? | Recommended action |
|---|---|---|
| `safe_auto` | (auto-applied before surfacing — N/A in report-only) | Apply |
| `gated_auto` | yes | Apply |
| `gated_auto` | no | Defer |
| `manual` | yes | Apply |
| `manual` | no | Defer |
| `advisory` | n/a | Acknowledge |

---

## 9. Execution Order

1. Write this plan (✓ this document)
2. For each module in order: **domain → agents → tools → llm → mcp → rag → screens** (high-risk first, screens last as lowest-risk):
   - Resolve diff base (empty-tree or first commit touching the module)
   - Write module intent summary
   - Dispatch all selected reviewers in parallel (bounded by harness limit)
   - Collect compact JSON returns
   - Run per-module Stage 5 merge → `merged.json` per module
3. After all 7 modules complete:
   - Load all 7 `merged.json` files
   - Run cross-module Stage 5 merge → `synthesis.json`
   - Load detail-tier fields from per-agent artifact files for surviving findings only
   - Render final markdown report to `docs/code-review-reports/2026-06-20-full-sweep.md`
4. Hand off `safe_auto` findings list to `ce-simplify-code` as a follow-up pass
