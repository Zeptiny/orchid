---
description: Scoping synthesis rules for plan -- two-stage shape, keep tests, detail tests, tier-aware budgets, anti-patterns, soft-cut behavior, doc-shape routing, headless mode.
---

# Scoping Synthesis

**Scoping synthesis != plan doc.** The scoping synthesis is the scope/decisions checkpoint that plan-write (Phase 5.2) consumes as input. It surfaces decisions the agent CAN make at synthesis time: scope-level, posture, test approach. It does NOT surface decisions plan-write produces: PR count, commit/branch sequencing, Implementation Unit lists, exact file paths.

**Two-stage shape: internal draft, then chat-time synthesis.** Stage 1 is an internal three-bucket draft (Stated / Inferred / Out of scope). Stage 2 is the compressed chat-time output. The user only sees stage 2.

This content is loaded when a synthesis-summary phase fires in `plan`. There are two variants:

- **Solo variant** (Phase 0.7): fires before Phase 1 research begins. Catches scope misinterpretation before research is spent.
- **Brainstorm-sourced variant** (Phase 5.1.5): fires after Phase 1 research, before Phase 5.2 plan-write. Focuses on plan-time decisions.

---

## Stage 1: internal three-bucket draft (shared)

- **Stated** -- what the user said directly.
- **Inferred** -- what the agent assumed to fill gaps.
- **Out of scope** -- deliberately excluded items.

This draft is internal. Do not paste it verbatim into chat.

---

## Stage 2: chat-time scoping synthesis

### Brainstorm-sourced shape (Phase 5.1.5)

Two content sections plus call-outs:

1. **Brainstorm-scope restatement** (1-2 sentences). Restates the brainstorm's scope as orientation, in the brainstorm's own vocabulary.
2. **Plan-specific scoping decisions** (prose, or bullets when multi-faceted). Scope-level commitments the agent made that the brainstorm did not.
3. **Call outs** (zero or more, capped by plan depth).

### Solo shape (Phase 0.7)

1. **Scope claim** (prose, or bullets when multi-faceted). What the agent is planning to build, at affirm-or-redirect level.
2. **Call outs** (zero or more, capped by plan depth).

### Shape budgets

| Plan depth | Restatement (brainstorm-sourced) | Plan-specific scoping / Scope claim |
|---|---|---|
| Lightweight | 1 sentence | 1-3 lines prose |
| Standard | 1-2 sentences | up to 3-5 lines or 2-4 bullets |
| Deep | 1-2 sentences | up to 4-6 lines or 3-6 bullets |

### Shared rules

- **No "Stated" bucket in chat.**
- **No "Out of scope" bucket as a separate list.**
- **Source-document vocabulary.** When a brainstorm exists, use its terms.
- **Pre-emit mechanical checks.** Bare ID references -> replace with plain names. File paths -> cut unless the path IS the topic of an explicit fork.

### The keep test for each call-out

Before keeping a candidate call-out, run the **affirmability test**: would the user need to look at code to evaluate this? If yes, it is plan-body content -- cut. If no, one of the following must be true:

- **Real fork**: another reasonable agent might choose differently
- **Non-obvious behavioral choice**: a default the agent picked that materially affects what the plan does
- **Non-obvious exclusion**: an item was deliberately excluded that the user might want to add back in
- **Cheap-now-expensive-later correction**: a bet the user is well-placed to redirect now

### The detail test (per call-out and per summary bullet)

1-2 lines max, conversational not documentary.

### How many call-outs are right?

| Plan depth | Typical | Cap |
|---|---|---|
| Lightweight | 0-2 | 3 |
| Standard | 1-3 | 4 |
| Deep | 2-5 | 6 |

**If the stage-2 pass exceeds the tier cap, re-cut at a higher level of abstraction.**

### Anti-patterns in call-outs

- Names a file path or module name
- Names a flag, env var, or exact env value
- Specifies a JSON shape, response format, or exact data structure
- Names HTTP status codes, event names, or exact error wording
- Describes implementation flow
- States a mechanical choice with no real alternative

---

## When to skip the blocking confirmation

Auto-proceed fires only when **plan depth is Lightweight AND zero call-outs survive**. For Standard or Deep plans, always fire the confirmation gate.

---

## Granularity: name the decision; don't expand it (shared)

Each call-out should be affirmable or rejectable by the user **without reading code**. Name the decision at the granularity that lets the user say "yes" or "I want X instead."

---

## Soft-cut on circularity (shared)

Track which call-outs the user touched per round. The soft-cut fires **only when the same call-out is revised twice**.

When the soft-cut fires, present two options:
- `Proceed and continue to [research / plan-write]`
- `Hold off -- keep discussing before continuing`

---

## Headless mode (shared)

When invoked from an automated workflow (no synchronous user):
- Compose the internal draft (stage 1) as usual, but skip stage 2.
- Route internal-draft content with mode-aware shape:
  - **Stated** -> Requirements
  - **Out-of-scope** -> Scope Boundaries
  - **Inferred** -> `## Assumptions` section (non-interactive plans only)

---

## Self-redirect (shared)

If the user response indicates they're in the wrong skill or want a different workflow:
- Stop `plan`
- Suggest the alternative skill
- Offer to load it in-session
- Don't push back or argue

---

## Doc shape after confirmation

After user confirmation, Phase 5.2 writes the plan doc. Internal-draft content dissolves into the plan's body sections:

| Internal-draft element | Where it goes in the plan |
|---|---|
| Summary (stage 2) | `## Summary` |
| Stated bullets | `## Requirements` and `## Problem Frame` |
| Inferred bullets | `## Key Technical Decisions` and Implementation Units. In non-interactive mode, route to `## Assumptions`. |
| Out-of-scope bullets | `## Scope Boundaries` |
