---
description: Plan section contract -- outcomes, hard floor, include-when-material catalog, prose economy rules, ID conventions, and metadata fields.
---

# Plan Sections

This reference describes what makes a great implementation plan. It does NOT
prescribe how the plan looks on the page -- rendering is handled by
`references/markdown-rendering.md`.

## The outcome

A great plan enables three audiences to act:

- **The implementing agent** (`work` or a human) starts from an informed
  baseline -- load-bearing decisions are named, research breadcrumbs orient
  their investigation, unit boundaries are clear.
- **The reviewer** identifies the load-bearing decisions and the boundaries
  of what's being changed in one pass.
- **The future reader** traces why the work was done, what shaped it, and
  where the artifacts live.

Sections earn their place by serving one of these audiences. Omit padding.

## Decide whether a plan doc is warranted at all

Not every invocation of `plan` should produce a plan document. For
genuinely atomic work, the doc is ceremony.

**Bias toward producing a plan.** The risk asymmetry favors writing one:
a thin plan doc for small work is mild ceremony, but skipping a plan when
one was warranted costs the implementer real time.

**Skip plan creation only when ALL of these hold:**
- The work is **atomic** -- fits in one commit, no meaningful unit boundaries.
- There are **no design choices that constrain implementation** -- no KTDs.
- There are **no scope boundaries worth pinning** in writing.
- **No upstream artifact** needs traceability through this plan.

## Hard floor

When a plan doc is warranted, these sections are present:

- **Summary** -- what the plan proposes, in 1-3 lines. Forward-looking.
- **Problem Frame** -- why the work is being done. Backward-looking.
- **Requirements** (with stable R-IDs) -- what must be true after the work ships.
- **Key Technical Decisions** (KTDs) -- the load-bearing choices that constrain implementation. Each entry is `<decision>: <rationale>`.
- **Implementation Units** (with stable U-IDs) -- the discrete units of work, sized so each is independently landable.

## Include when material

These sections are present when they carry information that isn't covered elsewhere. Filling a section with placeholder prose is worse than omitting it.

- **High-Level Technical Design** -- include when the technical approach has shape that prose alone doesn't carry well: architecture across components, sequencing across processes, state machines, branching gates.
- **Scope Boundaries** -- include when scope is contested or there are tempting non-goals worth naming explicitly.
- **Open Questions** -- include when there are genuinely unresolved items.
- **System-Wide Impact** -- include when the change affects cross-cutting concerns.
- **Risks & Dependencies** -- include when there are real risks worth flagging or material upstream dependencies.
- **Acceptance Examples** -- include when any requirement has a state-dependent or conditional shape.
- **Documentation / Operational Notes** -- include when documentation, monitoring, runbooks, or rollout steps need explicit notes.
- **Sources / Research** -- surface the research that orients the implementer or justifies load-bearing choices.

## Agent agency

The catalog is a floor, not a ceiling. When the plan's content doesn't fit any catalog section, introduce a new one. Content drives section choices, not vice versa.

## Prose economy

Hold every kept section to these:

- **One idea per sentence.**
- **A requirement or unit is one sentence of intent plus at most one qualifier.**
- **Cut hedges and intensifiers.**
- **Prefer the verb to the nominalization.**

**Resolve in place; don't stratify.** When a later decision supersedes earlier text, rewrite or remove the original.

**Named test, run before the plan is declared written:** could the implementer find a contradiction in each section in one pass?

## Plan metadata fields

### Required

- **`title`** -- verbatim plan title.
- **`type`** -- conventional-commit-prefix classification (`feat`, `fix`, `refactor`, etc.).
- **`date`** -- creation date in ISO 8601 (`YYYY-MM-DD`).

Plans carry **no `status` field** -- a plan is a decision artifact, not a tracked work item. Whether a plan shipped is derived from git, not stored in the doc.

### Optional but well-known

- **`origin`** -- repo-relative path to an upstream brainstorm requirements doc.
- **`deepened`** -- ISO 8601 date marking the first time the confidence check substantively strengthened the plan.
- **`execution`** -- execution domain: `code` (default when absent) or `knowledge-work`.

Field names are stable across plan revisions -- never rename or repurpose a field.

## ID and content rules

- **Stable IDs.** R-IDs, U-IDs, A-IDs, F-IDs, AE-IDs. IDs are stable across plan revisions -- never renumber.
- **Plain prefix.** `R1.`, `U1.` as bullet prefixes. Do not bold.
- **Repo-relative paths.** Always. Never absolute paths.
- **No process exhaust.** No "captured at Phase X" notes, no `## Next Steps` pointing to the next skill, no italic provenance lines.
- **Group Requirements by concern** when they span distinct logical areas. R-IDs stay continuous across groups.

## Rendering

See `references/markdown-rendering.md` for how to render these sections in markdown.
