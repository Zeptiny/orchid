---
description: Approach altitude instructions -- how to produce a grounded approach-plan (a plan for how the deliverable will be made) and hold at a checkpoint.
---

# Approach Altitude

Loaded from SKILL.md Phase 0.1a when a request is answered one level up -- produce a grounded **approach-plan** (a plan for *how the deliverable will be made*), hold at a checkpoint, then execute now or save for later. Entered explicitly ("plan for a plan") or via an accepted proactive offer. Domain-general: the deliverable may be a document, a synthesis, a study artifact, or a software implementation plan. The boundary this preserves is **code vs. knowledge-work**, not plan vs. execute -- `plan` never writes or runs code; code execution always belongs to `work`.

## Stage 1: Light recon (cheap grounding)

Before composing the approach-plan, skim the provided inputs enough to ground the approach in specifics -- not the full read; that is the deliverable's work, deferred to execution.

- **Bound the recon per input type** so the checkpoint stays cheap. Directional guidance: for a PDF, section headers + first/last pages + a few sampled sections; for a long transcript, sampled spans plus topic shifts; for a codebase, entry points and the relevant module shape.
- **Ground in specifics:** name the concrete bridges the approach will make, not a generic recipe.
- **Degrade gracefully.** If the inputs are absent or arrive later, fall back to proposing from the request alone and flag the approach-plan as provisional/ungrounded.

## Stage 2: Compose the approach-plan (chat-first)

Deliver the approach-plan in chat. It is **file-optional** -- the user decides whether to persist it. Keep it scannable. Cover, right-sized to the request:

- **How each input will be handled** -- what you'll mine from each, grounded in the recon.
- **How they combine** -- the synthesis strategy / sequencing; this is usually the risky part.
- **The shape of the deliverable** -- structure/outline of what executing this will produce.
- **The forks worth confirming** -- the few decisions where the user's steer materially changes the result.
- **Open questions** -- anything genuinely unresolved.

## Stage 3: Checkpoint

Hold at the approach. Present options:

1. **Execute now** -- proceed to produce the deliverable.
2. **Save for later** -- persist the approach-plan to `docs/plans/`.

## Stage 4: Route

**Save for later.** Persist the approach-plan to `docs/plans/` so it survives. Offer to deepen it.

**Execute now -- code deliverable.** Continue into the normal `plan` flow (Phase 0.1b onward) to produce the implementation plan, then hand off to `work`.

**Execute now -- non-code deliverable.** Write the marker `execution: knowledge-work` into the plan frontmatter. Persist the marked plan to `docs/plans/`. Fire the `work` skill, passing the plan path.

## Boundaries: not the other approach surfaces

- **Answer-seeking's plan-of-attack** (`references/universal-planning.md`): non-blocking (states the approach and proceeds immediately), discards its scaffold, produces a chat answer. Approach altitude is domain-general, **holds at a checkpoint** for a user decision, and produces a **persistable, deepenable** approach-plan.
- **Scoping synthesis** (Phase 0.7): a *scope* checkpoint for a deliverable already committed to. Approach altitude is an *altitude* checkpoint that decides whether to commit to the deliverable at all.
- **Deepening** (Phase 5.3): operates on a plan that already exists. Approach altitude operates *before any artifact exists*.
