---
description: Section contract for brainstorm requirements documents -- outcomes, hard floor, include-when-material catalog, agency rules, ID conventions.
---

# Brainstorm Sections

This reference describes what makes a great brainstorm requirements document.
It does NOT prescribe how the doc looks on the page -- rendering is handled by
`references/markdown-rendering.md`.

## The outcome

A great brainstorm produces a doc that enables three audiences to act:

- **The planning agent** (`plan` or a human) produces an implementation
  plan without inventing user behavior, scope boundaries, or success
  criteria -- the brainstorm answered those.
- **The reviewer** sees the framing choices, distinguishes pinned from open,
  and catches scope gaps before planning.
- **The future reader** traces why the proposed thing matters, who it's for,
  and what success looks like.

Sections earn their place by serving one of these audiences. Omit padding.

## Decide whether a doc is warranted at all

Brainstorm dialogue does not always need to produce a durable document.
Skip document creation when **both** hold:

- The user only needs brief alignment -- no exploration produced novel scope,
  framing, or decisions worth preserving in IDed shape.
- Any durable decisions made during the dialogue can flow naturally to
  downstream artifacts (`plan`, the commit message, `docs/solutions/`)
  without a brainstorm doc as an intermediary.

The trigger for creating a doc is when the dialogue surfaced enough
structural decisions, scope boundaries, or acceptance criteria that
downstream consumers (planner, reviewer, future reader) need them in a
durable, IDed form -- not just as conversational artifacts.

**Stress test:** a brainstorm about a tiny bug fix where the user asks "fix
this with a null check or with upstream validation?" and the agent confirms
"upstream validation, here's why" doesn't need a brainstorm doc. The
decision flows to `plan` (or directly to commit message, or to
`docs/solutions/` if it's a pattern worth carrying) without a brainstorm
artifact in the middle.

## Match depth to content

When a doc IS warranted, depth matches what the dialogue produced. A
brainstorm with sparse content produces a sparse doc; one with rich content
produces a rich doc. Don't add ceremony to make a slim brainstorm look
substantial.

## Prose economy

Hold every kept section to these:

- **One idea per sentence.** A Summary is a handful of sentences, not one
  sentence with five semicolons and four parentheticals.
- **A requirement is one sentence of intent plus at most one qualifier.**
  When a requirement would specify two outcomes, state the intent and send
  the fork to Outstanding Questions.
- **Cut hedges and intensifiers.** "Critically", "deliberately", "explicitly",
  "genuinely", "actually", "simply" carry nothing a downstream agent acts on.
- **Prefer the verb to the nominalization.** "Demote the grid", not "the
  demotion of the grid is the deliberate change in this brief".

**Resolve in place; don't stratify.** When a later decision answers a parked
question or supersedes earlier text, rewrite or remove the original entry --
don't append a separate "resolutions" layer.

**Named test, run before the doc is declared written:** could a reader find a
contradiction in each section in one pass?

## Hard floor

When a doc is warranted, these are present.

- **Summary** -- what is being proposed, in 1-3 lines. Forward-looking.
- **Requirements** (with stable R-IDs) -- what must be true about the
  proposed thing. For very sparse brainstorms (<=3 simple items where the
  bullets ARE the summary), plain bullets without IDs are acceptable.
  When requirements span distinct concerns, group them under bold inline
  headers within the Requirements section. R-IDs stay continuous across
  groups.

## Include when material

The agent decides per brainstorm whether each section carries information
that isn't covered elsewhere. Filling a section with placeholder prose is
worse than omitting it.

- **Problem Frame** -- include when motivation isn't obvious from Summary
  alone. Backward-looking / situational.
- **Key Decisions** -- include when the brainstorm produced opinionated
  framing choices that constrain Requirements / Flows / Scope below.
- **Actors** -- include when the proposed thing has multi-party behavior.
- **Key Flows** -- include when the proposed thing has multi-step behavior.
- **Visualizations** -- include a diagram when the brainstorm contains a
  diagram-shaped concept that a picture carries faster than prose.
- **Acceptance Examples** -- include when any requirement has a
  state-dependent or conditional shape.
- **Success Criteria** -- include when there are quality / metric / handoff
  signals that Requirements don't already carry.
- **Scope Boundaries** -- include when scope is contested or there are
  tempting non-goals worth naming explicitly.
- **Dependencies / Assumptions** -- include when material upstream
  dependencies exist or when load-bearing assumptions need to be surfaced.
- **Outstanding Questions** -- include when there are unresolved items.
  Distinguish "Resolve Before Planning" from "Deferred to Planning".
- **Sources / Research** -- surface research that orients the planner or
  justifies framing choices.

## Agent agency

The catalog is a floor, not a ceiling. When the brainstorm's content doesn't
fit any catalog section, introduce a new one. Content drives section choices,
not vice versa.

## ID and content rules

- **Stable IDs.** R-IDs (Requirements), A-IDs (if Actors fire), F-IDs (if
  Flows fire), AE-IDs (if Acceptance Examples fire). No other ID namespaces.
- **Plain prefix.** `R1.`, `A1.`, `F1.`, `AE1.` as bullet prefixes. Do not
  bold.
- **Bold leader labels** inside Flows and Acceptance Examples.
- **Repo-relative paths.** Always. Never absolute paths.
- **No process exhaust.** No "captured at Phase X" notes, no `## Next Steps`
  pointing to `plan`, no italic provenance lines.
- **No implementation details by default.** Libraries, schemas, endpoints,
  file layouts, code structure stay out unless the brainstorm itself is
  inherently about a technical or architectural change.

## Discipline: Summary vs Problem Frame

| Section | Question it answers | Time direction | Length |
|---|---|---|---|
| `## Summary` | What is this doc proposing? | Forward-looking | 1-3 lines |
| `## Problem Frame` | Why does this proposal exist? | Backward-looking / situational | Paragraphs |

- **Summary doesn't need problem context.**
- **Problem Frame doesn't restate the proposal.**

## Rendering

See `references/markdown-rendering.md` for how to render these sections in markdown.
