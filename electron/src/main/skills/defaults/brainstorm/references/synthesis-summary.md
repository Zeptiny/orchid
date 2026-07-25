---
description: Synthesis summary rules for brainstorm -- two-stage shape, keep tests, detail tests, tier-aware bullet budgets, anti-patterns, soft-cut behavior, doc-shape routing.
---

# Synthesis Summary

**Synthesis != requirements doc.** The synthesis is NOT a preview, draft, or substitute for the requirements doc -- it's the scope checkpoint that doc-write consumes as input. The requirements doc itself is written in Phase 3 from the confirmed synthesis.

**Two-stage shape: internal draft, then chat-time scoping synthesis.** The synthesis is composed in two stages. Stage 1 is an internal three-bucket draft (Stated / Inferred / Out of scope) the agent uses to think comprehensively about scope. Stage 2 is the scoping synthesis presented to the user -- shaped like what two product collaborators would confirm before writing a PRD, not like a comprehensive audit and not like a one-line preview. The user only sees stage 2.

This content is loaded when Phase 2.5 fires -- after Phase 2 (approaches chosen) and before Phase 3 (write requirements doc). The synthesis is the user's last opportunity to correct the agent's interpretation before the doc lands.

---

## Stage 1: internal three-bucket draft

The internal draft is structured in three labeled buckets. Items may appear in two buckets when meaningfully both.

- **Stated** -- what the user said directly (in the original prompt, prior conversation, dialogue answers, approach selection in Phase 2). Items here have explicit user-language anchors.
- **Inferred** -- what the agent assumed to fill gaps. Scope boundaries the user never explicitly named, success criteria extrapolated from intent, technical assumptions made because the brief interview didn't probe them.
- **Out of scope** -- deliberately excluded items. Adjacent work the agent considered but decided not to include, refactors, nice-to-haves, future-work items.

This draft is internal. Do not paste it verbatim into chat. Compose it as a thinking step, then derive stage 2 from it.

---

## Stage 2: the chat-time scoping synthesis

The scoping synthesis has up to four named sections, each **render-conditional** on having something to say. Empty sections are omitted, not padded.

1. **What we're building** (always present) -- 1-3 sentences. The shape that emerged from dialogue, forward-looking, plain words.
2. **Key trade-offs** (conditional) -- 1-3 bullets, each with a brief why. Render only when real trade-offs were made in dialogue.
3. **What's not in scope** (conditional) -- 1-3 bullets, or fold into a single sentence. Render only when deferred items would surprise a downstream reader if absent.
4. **Call outs** (conditional) -- 0-3 bullets. Residual forks the dialogue didn't resolve: post-dialogue consequences, silent agent inferences, or scope bets the user is seeing for the first time.

### Path A vs Path B: the gate that fires the confirmation question

- **Path A -- no blocking questions fired AND tier is Lightweight**: announce-mode. Emit "What we're building" prose only, then proceed to Phase 3 doc-write in the same turn.
- **Path B -- at least one blocking question fired, OR tier is Standard / Deep-feature / Deep-product**: full tier-aware scoping synthesis with confirmation gate.

### Keep tests per section

Each conditional section has its own keep test. Sections are render-conditional -- an empty section is omitted, not padded with weak items.

**Trade-offs keep test:** would the user be surprised if I didn't surface this acknowledgment?

**Deferred keep test:** is a reasonable downstream reader likely to ask "why isn't X here?"

**Call-outs keep test (the affirmability test):** would the user need to read code to evaluate this? If yes, it is doc-body content -- cut. If no, one of the following must be true:
- **Real scope fork** -- another reasonable agent might choose a different scope on this dimension
- **Non-obvious scope inclusion** -- a behavior the agent assumed is in scope that the user might want excluded
- **Non-obvious scope exclusion** -- an item the agent moved to deferred that the user might want in scope
- **Cheap-now-expensive-later correction** -- a scope bet that's cheap to fix now but expensive after the requirements doc lands
- **Non-obvious consequence of multi-turn answers** -- a downstream effect of combining user-stated answers

### Total bullet budget across sections 2-4

| Tier | Typical total | Hard ceiling |
|---|---|---|
| Lightweight | 0-1 | 2 |
| Standard | 2-4 | 5 |
| Deep -- feature | 3-5 | 7 |
| Deep -- product | 4-7 | 9 |

**Above the hard ceiling, the synthesis is misshapen -- re-cut at a higher level of abstraction.**

### Detail level: conversational, not documentary

Each bullet is **1 line ideally, 2 lines maximum**. Two tests:

- **Read-aloud test**: would two product collaborators *say* this bullet?
- **Single-sentence test**: can the bullet land in one sentence?

### Anti-patterns

- **Naming implementation detail in any bullet**: file paths, module names, exact JSON keys, HTTP status codes, error message wording, SQL syntax.
- **Re-stating a Q&A turn verbatim**: transcript, not scoping synthesis.
- **Re-stating the Phase 2 approach the user already picked**.
- **Padding a section to meet a bullet count**: render-conditional means empty is allowed.
- **Pasting the three-bucket internal draft verbatim into chat**.

---

## Prompt templates

### Path B template (questions were asked)

```
Based on our dialogue, here's the scope I'm proposing for the requirements doc:

**What we're building:** [1-3 sentences]

**Key trade-offs:** [render only when real trade-offs exist]
- [explicit choice + brief why]

**What's not in scope:** [render only when deferred items would surprise a reader]
- [deferred item]

**Call outs:** [render only when one or more survived the keep test]
- [scope-level fork or non-obvious consequence]

Confirm and I'll write the requirements doc next, drawing on our dialogue and this synthesis. Or tell me what to change.
```

### Path A template (no questions were asked)

```
Proposing: [1-3 line shape].

No open decisions -- writing the requirements doc now. Interrupt if the shape is wrong.
```

Proceed to Phase 3 doc-write in the same turn.

---

## Soft-cut on circularity (not iteration count)

Track which scoping synthesis items the user touched per round. The soft-cut blocking question fires **only when the same item is revised twice**. New-item revisions across rounds proceed without limit.

**Identity across rounds is by decision dimension, not surface wording or section.**

When the soft-cut fires, present two options:
- `Proceed and write the requirements doc`
- `Hold off -- keep discussing before the doc`

---

## Self-redirect

If the user response indicates they're in the wrong skill or want a different workflow:
- Stop brainstorm
- Suggest the alternative skill the user appears to want
- Offer to load it in-session
- Do not push back or argue

---

## Doc shape after confirmation

After user confirmation, Phase 3 writes the requirements doc. The internal draft does NOT carry into the doc as a `## Synthesis` section. Only the "What we're building" prose embeds, as `## Summary`. Internal-draft content dissolves into the doc's body sections:

| Internal-draft element | Where it goes in the doc |
|---|---|
| "What we're building" prose | `## Summary` |
| Stated bullets | `## Requirements` (numbered R-IDs) and `## Problem Frame` |
| Inferred bullets | `## Key Decisions` (with rationale) |
| Out-of-scope bullets | `## Scope Boundaries` |
