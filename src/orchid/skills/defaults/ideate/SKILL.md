---
name: ideate
description: 'Generate and critically evaluate grounded ideas about a topic. Use when asking what to improve, requesting idea generation, exploring surprising directions, or wanting the AI to proactively suggest strong options before brainstorming one in depth.'
---

# Generate Improvement Ideas

**Note: The current year is 2026.** Use this when dating ideation documents and checking recent ideation artifacts.

`ideate` precedes `brainstorm`.

- `ideate` answers: "What are the strongest ideas worth exploring?"
- `brainstorm` answers: "What exactly should one chosen idea mean?"
- `plan` answers: "How should it be built?"

This workflow produces a ranked ideation artifact — written to `docs/ideation/` when present, else a temp path (see Phase 4). It does **not** produce requirements, plans, or code.

## Focus Hint

Interpret any provided argument as optional context. It may be:

- a concept such as `DX improvements`
- a path such as `src/skills/`
- a constraint such as `low-complexity quick wins`
- a volume hint such as `top 3`, `100 ideas`, or `raise the bar`

If no argument is provided, proceed with open-ended ideation.

## Core Principles

1. **Ground before ideating** - Scan the actual codebase first. Do not generate abstract product advice detached from the repository.
2. **Generate many -> critique all -> explain survivors only** - The quality mechanism is explicit rejection with reasons, not optimistic ranking. Do not let extra process obscure this pattern.
3. **Route action into brainstorming** - Ideation identifies promising directions; `brainstorm` defines the selected one precisely enough for planning. Do not skip to planning from ideation output.

## Model Tiers

Sub-agent dispatch is tiered by task shape, never hardcoded to a model name:

- **Extraction tier** — evidence scouts and other retrieval/quoting work. Use the platform's cheapest capable model.
- **Generation tier** — evidence-driven ideation frames and basis verification. Use the platform's mid-tier model.
- **Ceiling tier** — ceiling ideation frames, cross-cutting synthesis, and final arbitration. Use the platform's strongest model.

**Degradation rule.** When the platform's subagent primitive does not support per-agent model selection, dispatch everything on the inherited model and keep the read budgets and dossier caps — cost control then comes from structure, not tiering.

Two overrides raise the whole ideation fleet to the ceiling tier: surprise-me mode (subject discovery is judgment-heavy and is the mode's whole value) and the `go deep` depth override (Phase 0.5).

## Execution Flow

### Phase 0: Resume and Scope

When the subject, mode, and format are already clear from the prompt, resolve this phase in one pass and move on — the gates below exist for ambiguity, not ceremony.

#### 0.1 Check for Recent Ideation Work

Look in `docs/ideation/` for ideation documents (`*.md`) created within the last 30 days.

Treat a prior ideation doc as relevant when:

- the topic matches the requested focus
- the path or subsystem overlaps the requested focus
- the request is open-ended and there is a recent open ideation doc

If a relevant doc exists, ask whether to:

1. continue from it
2. start fresh

If continuing:

- read the document
- summarize what has already been explored
- preserve the previous ideas and rejection summary
- update the existing file instead of creating a duplicate

#### 0.2 Subject-Identification Gate

Before classifying mode or dispatching any grounding, check whether the subject of ideation is identifiable. Every downstream agent — grounding and ideation — needs to know what it's working on. If the subject is ambiguous enough that reasonable sub-agents would diverge on what the topic even is (bare words like `improvements`, `ideas`, `birthday cakes`, `vacation destinations`), the output will be scattered.

**Questioning principles (apply in this phase and in 0.4):**

- Questions exist only to supply what sub-agents need to operate: an identifiable subject (this phase) and enough context for the agent to say something specific about it (0.4, elsewhere modes only). Nothing else.
- Never ask about solution direction, constraints, audience, tone, success criteria, or anything that characterizes the subject — those belong to `brainstorm`.
- Always keep "Surprise me" (letting the agent decide the focus) as a real option, not a fallback for when the user can't name a subject. Ideation is allowed to be greenfield by design.
- Stop as soon as the subject is identifiable or the user has delegated to "Surprise me." More than 3 total questions across 0.2 and 0.4 is a smell that ideation is not the right workflow — consider suggesting `brainstorm`.

**Detection — issue-tracker intent (repo mode only; subject-identifying).**

Issue-tracker intent requires an explicit reference to the tracker or to reports filed in it. Trigger only when the prompt uses phrases like `github issues`, `open issues`, `issue patterns`, `issue themes`, `what users are reporting`, or `bug reports` — the subject is "issues in the tracker." Proceed to 0.3 with issue-tracker intent flagged.

Do NOT trigger on arguments that merely mention bugs as a focus: `bug in auth`, `fix the login issue`, `the signup bug`, `top 3 bugs in authentication` — these are focus hints on regular ideation, not requests to analyze the issue tracker. A bare `bugs` with no tracker phrasing is handled by the vagueness check below, not here.

When combined (e.g., `top 3 issue themes in authentication`, `biggest bug reports about checkout`): detect issue-tracker intent first, volume override in 0.5, remainder is the focus hint. The focus narrows which issues matter; the volume override controls survivor count.

**Detection — subject identifiability.**

The test: would a reader, seeing only this prompt, know what subject the agent should ideate on? Vagueness is about what the words *refer to*, not phrase length: `browser sniff` is two words but plausibly names a feature (identifiable — proceed to 0.3); `quick wins` is two words but names only a quality (vague — ask the scope question). A prompt that refers to a catch-all quality, category, or placeholder (`improvements`, `bugs` alone, an empty prompt) is vague; one that names or plausibly names a specific feature, concept, document, flow, or topic is identifiable, in any domain.

**Being inside a repo does not settle vagueness.** `improvements` in any repo is still scattered across DX, reliability, features, docs, tests, architecture. The repo provides material for grounding *after* a subject is settled, not the subject itself. Do not silently interpret a vague prompt as "about this repo" and proceed.

**Genuine ambiguity (repo mode).** When real doubt remains on a short phrase, one cheap check settles it: Glob for the phrase in filenames, or Grep for it in README/docs. Any repo footprint → identifiable; none and still vague → ask. When in doubt otherwise, err toward asking — one question is trivial compared to dispatching a dozen agents on a scattered interpretation.

**The scope question.**

- **Stem:** "What should the agent ideate about?"
- **Options:**
  - "Specify a subject the agent should ideate on"
  - "Surprise me — let the agent decide what to focus on"
  - "Cancel — let me rephrase"

Routing:

- **Specify** → accept the user's follow-up as the subject. Re-apply the identifiability check once. If still ambiguous, ask once more with "Surprise me" still on the menu. Do not cascade toward specificity about *how* to solve — only about *what* the subject is.
- **Surprise me** → mark the run as **surprise-me mode**. The agent will discover subjects from Phase 1 material rather than carry a user-specified subject. This is a first-class mode — it changes how Phase 1 scans and how Phase 2 sub-agents operate (see those phases). **Dispatch routing for surprise-me is deterministic:** if CWD is inside a git repo, route to repo-grounded (the codebase supplies substance); otherwise route to elsewhere-software and require Phase 0.4 to collect at least one piece of substance (description, draft, or paste) before dispatching. Skip Decision 1/2 in Phase 0.3: with no user subject there is no prompt content to weigh, and surprise-me never routes to elsewhere-non-software (no way to infer naming/narrative/personal intent without a subject). The user can correct by interrupting and re-invoking with a named subject.
- **Cancel** → exit cleanly. Narrate that the user can rephrase and re-invoke.

#### 0.3 Mode Classification

Classify the **subject of ideation** (settled in 0.2) into one of three modes for dispatch routing. A user inside any repo can ideate about something unrelated to that repo; a user in `/tmp` can ideate about code they hold in their head.

**Surprise-me short-circuit.** When Phase 0.2 routed to surprise-me mode, skip the two-decision classification below and use the deterministic rule stated in 0.2: repo-grounded when CWD is inside a git repo, elsewhere-software otherwise. The ambiguity-confirmation step at the end of this section also does not fire for surprise-me — there is no user subject to be ambiguous about. State the chosen mode in one sentence and proceed to 0.4.

For specified subjects, make two sequential binary decisions, enumerating negative signals at each:

**Decision 1 — repo-grounded vs elsewhere.** Weigh prompt content first, topic-repo coherence second, and CWD repo presence as supporting evidence only.

- Positive signals for **repo-grounded**: prompt references repo files, code, architecture, modules, tests, or workflows; topic is clearly bounded by the current codebase. Issue-tracker intent from 0.2 is always repo-grounded.
- Negative signals (push toward **elsewhere**): prompt names things absent from the repo (pricing, naming, narrative, business model, personal decisions, brand, content, market positioning); topic is creative, business, or personal with no code surface.

**Decision 2 (only fires if Decision 1 = elsewhere) — software vs non-software.** Classify by whether the *subject* of ideation is a software artifact or system, not by where the individual ideas will eventually land. If the topic concerns a product, app, SaaS, web/mobile UI, feature, page, or service, it is **elsewhere-software** — even when the ideas themselves are about copy, UX, CRO, pricing, onboarding, visual design, or positioning *for that software product*. **Elsewhere-non-software** is reserved for topics with no software surface at all: company or brand naming (independent of product), narrative and creative writing, personal decisions, non-digital business strategy, physical-product design.

Contrast pair: "Improve conversion on our sign-up page" → elsewhere-software (the subject is a page, even though the ideas may be copy or CRO); "Name my new coffee shop" → elsewhere-non-software (the subject is a brand with no software surface).

State the inferred approach in one sentence at the top, using plain language the user will recognize. Never print the internal taxonomy label (`repo-grounded`, `elsewhere-software`, `elsewhere-non-software`) to the user — those names are for routing only. Adapt the template below to the actual topic; pick a domain word from the topic itself (e.g., "landing page", "onboarding flow", "naming", "career decision") instead of a mode label.

- **Repo-grounded:** "Treating this as a topic in this codebase — about X."
- **Elsewhere-software:** "Treating this as a product/software topic outside this repo — about X."
- **Elsewhere-non-software:** "Treating this as a [naming | narrative | business | personal] topic — about X."

Do not prescribe correction phrases ("say X to switch"). State the inferred mode plainly and proceed. If the user disagrees, they will correct in their own words or interrupt to re-invoke — reclassify and re-run any affected routing when that happens.

**Active confirmation on mode ambiguity.** Only fire when mode classification is genuinely ambiguous *after* 0.2 settled the subject — e.g., "our docs" could mean repo docs (repo-grounded) or public marketing docs (elsewhere-software). Most subjects settled in 0.2 classify cleanly here. When ambiguous, ask one confirmation question with two self-contained labels naming the two candidate interpretations in plain language (e.g., "Treat as repo docs in this codebase" vs "Treat as public marketing docs") — never leak internal mode names. Otherwise the one-sentence inferred-mode statement is sufficient; do not ask.

**Routing rule (non-software mode).** When Decision 2 = non-software, still run Phase 1 Elsewhere-mode grounding (user-context synthesis + RAG research by default). Then load `references/universal-ideation.md` and follow it in place of Phase 2's software frame dispatch and the Phase 5 menu narrative. This load is non-optional — the file contains the domain-agnostic generation frames, critique rubric, and wrap-up menu that replace Phase 2 and the post-ideation menu for this mode, and none of those details live in this main body. Improvising from memory produces the wrong facilitation for non-software topics. Do not run the repo-specific codebase scan at any point. The deliverable is auto-written here too (per `references/post-ideation-workflow.md` Phase 4).

#### 0.4 Context-Substance Gate (Elsewhere Modes Only)

Skip in repo mode — the repo provides the substance Phase 1 agents work from. In elsewhere modes (both software and non-software), Phase 1 agents depend on user-supplied context for substance. A bare prompt with no description or artifact leaves the user-context-synthesis agent with nothing to synthesize and weakens RAG research's relevance.

Apply the discrimination test: would swapping one piece of the user's stated context for a contrasting alternative materially change which ideas survive? If yes, context is load-bearing — proceed. If no, ask 1-3 narrowly chosen questions focused on **supplying substance, not characterizing the subject**:

- A brief description of the current state
- A paste of an existing draft or brief

Build on what the user already provided rather than starting from a template. Default to free-form questions; use single-select only when the answer space is small and discrete. After each answer, re-apply the test before asking another. Stop on dismissive responses ("idk just go") — treat genuine "no context" answers as real answers and note context is thin in the summary so Phase 2 can compensate with broader generation.

**Surprise-me exception.** When the run is in surprise-me mode and routed to elsewhere-software (per 0.2's deterministic routing for no-repo CWDs), at least one piece of substance is required — there is no subject AND no repo, so Phase 1 and 2 agents would have nothing to discover subjects from. Dismissive responses are not acceptable here; if the user still has no context after one ask, tell them the run needs a description or paste to proceed and end cleanly so they can re-invoke with material.

When the user provides rich context up front (a paste, a brief, an existing draft), confirm understanding in one line and skip this step entirely.

If this step materially changes the topic (not just adds context but shifts the subject), re-run 0.2 and 0.3 against the refined scope before dispatching Phase 1 — classify on what's actually being ideated on, not the scope at first read.

#### 0.5 Interpret Focus and Volume

Infer two things from the argument and any intake so far:

- **Focus context** — concept, path, constraint, or open-ended
- **Volume override** — any hint that changes candidate or survivor counts

Default volume:

- each ideation frame yields about 6-8 ideas (~36-48 raw across the six frames in the default path, or ~24-32 across 4 frames in issue-tracker mode; roughly 25-30 survivors after dedupe in the default path and fewer in the 4-frame path)
- keep the top 5-7 survivors

Honor clear overrides such as:

- `top 3`
- `100 ideas`
- `raise the bar`

**Depth override.** `go deep` (or equivalent) opts into maximum depth deliberately: every ideation agent moves to the ceiling tier, the Phase 2 verification read budget doubles, and Phase 3 adds a second critic. The default is the mixed-tier fleet — users opt into top-tier cost explicitly rather than inheriting it from whichever model the conversation happens to run on.

**Tactical scope detection.** Parse the focus hint (and any intake answers from 0.2 specify path) for tactical signals: `polish`, `typo`, `typos`, `quick wins`, `small improvements`, `cleanup`, `small fixes`. When present, lower the Phase 2 ambition floor — the user has explicitly opted into tactical scope. Default otherwise is step-function (see Phase 2 meeting-test floor).

Use reasonable interpretation rather than formal parsing.

### Phase 1: Mode-Aware Grounding

Before generating ideas, gather grounding. The dispatch set depends on the mode chosen in Phase 0.3. RAG-based codebase research runs in all modes when a codebase is available. When the user supplied a research artifact, the user-supplied research handling below also runs in all modes.

**Surprise-me grounding depth.** When Phase 0.2 routed to surprise-me mode, Phase 1 must produce richer material than specified mode — Phase 2 sub-agents will discover their own subjects from what Phase 1 returns, so texture matters:

- **Repo mode surprise-me:** the codebase-scan sub-agent samples a few representative files per top-level area (not just reads the top-level layout + AGENTS.md), surfaces recent PR/commit activity as signal about what's actively being worked on. Keep the scan bounded: representative, not exhaustive.
- **Elsewhere mode surprise-me:** user-context synthesis extracts themes, recurring language, tensions, and omissions from whatever the user supplied, rather than just restating it.
- Specified mode keeps the current shallower scan — the user's named subject anchors what's relevant, so broader exploration is unnecessary.

Run grounding agents in parallel in the **foreground** (do not background — results are needed before Phase 2):

**Repo mode dispatch:**

1. **Quick context scan** — dispatch a general-purpose sub-agent using the platform's cheapest capable model. Before dispatching, apply the routing test from "User-Supplied Research Artifacts" below to any root-level `*.md` file the focus hint names. Dispatch with this prompt:

   > Read the project's AGENTS.md (or CLAUDE.md only as compatibility fallback, then README.md if neither exists), then discover the top-level directory layout using `Glob` with pattern `*` or `*/*`. Also read `STRATEGY.md` if it exists — it captures the product's target problem, approach, persona, metrics, and tracks.
   >
   > **Two paths for other root-level `*.md` files**, depending on whether the focus hint names them:
   >
   > - **User-named references** — if the focus hint names a specific root-level `*.md` file, fully read that file and include its content under a heading `User-named references`. Phase 2 treats these as *constraint*, so sub-agents need actual content, not a gist.
   > - **Additional context** — for any other root-level `*.md` files (not named in the focus), read briefly and include a one-line gist under a heading `Additional context`. Phase 2 treats these as *background*, so a gist is sufficient.
   >
   > Return a concise summary (under 40 lines, longer if user-named references include substantive content) covering:
   >
   > - project shape (language, framework, top-level directory layout)
   > - notable patterns or conventions
   > - obvious pain points or gaps
   > - likely leverage points for improvement
   > - product strategy summary, if `STRATEGY.md` was present
   > - `User-named references` section (when the focus hint named root-level `*.md` files)
   > - `Additional context` section (when other root-level `*.md` files exist that the focus did not name)
   >
   > Keep the scan shallow otherwise — read only top-level documentation and directory structure. Do not do deep code search.
   >
   > Focus hint: {focus_hint}
   >
   > Research artifacts (gist-only under `Additional context` — do not fully read; a separate agent distills these): {research_artifact_files, or "none"}

2. **RAG-based codebase research** — use `rag_search` to find relevant code patterns, discussions, and prior work related to the focus hint. Pass the focus hint and a brief planning context summary. This replaces web-based research for repo-grounded ideation.

3. **Issue intelligence** (conditional) — if issue-tracker intent was detected in Phase 0.3, dispatch an issue-intelligence sub-agent with the focus hint. Run in parallel with the other agents.

   If the agent returns an error (gh not installed, no remote, auth failure), log a warning to the user ("Issue analysis unavailable: {reason}. Proceeding with standard ideation.") and continue with the remaining grounding.

   If the agent reports fewer than 5 total issues, note "Insufficient issue signal for theme analysis" and proceed with default ideation frames in Phase 2.

**Elsewhere mode dispatch (skip the codebase scan; user-supplied context is the primary grounding):**

1. **User-context synthesis** — dispatch a general-purpose sub-agent (cheapest capable model) to read the user-supplied context from Phase 0.4 intake plus any rich-prompt material, and return a structured grounding summary that mirrors the codebase-context shape (project shape → topic shape; notable patterns → stated constraints; pain points → user-named pain points; leverage points → opportunity hooks the context implies). This keeps Phase 2 sub-agents agnostic to grounding source.

2. **RAG-based research** — use `rag_search` to find relevant patterns and prior work related to the topic.

Issue intelligence does not apply in elsewhere mode.

#### User-Supplied Research Artifacts

Applies in all modes whenever the prompt or intake names a file of *gathered evidence* — a social-listening or search-research report, survey export, analytics dump, interview notes — at any path, inside or outside the repo.

**Routing test (directive vs evidence).** A named file is *directive* when ideas that ignore or contradict it would be wrong (a spec, a TODO list, feedback the user wants addressed) — in repo mode that is the User-named references path, and it rides in `<constraints>` at dispatch. A file is *evidence* when it is signal about the world that ideas may draw on and cite. Research artifacts are evidence: they enter the evidence layer, never `<constraints>` — engagement-ranked chatter must inform ideas, not veto them.

**Repo-mode coordination.** Apply this routing test *before* dispatching the Phase 1 quick context scan: when a research artifact is a root-level `*.md` the focus hint names, list it on the scan prompt's research-artifacts line so the scan gists it under `Additional context` instead of fully reading it into `User-named references`. Each file takes exactly one path — distillation here, never both.

**Enrichment, not substitution.** A supplied research artifact does not replace the RAG research dispatch — these artifacts typically cover source classes that RAG does not reach, and vice versa. Dispatch RAG research as normal.

Handling:

- **Small artifacts** that fold into the grounding summary without dominating the shared grounding block — include directly under `User-supplied research`.
- **Everything larger** — dispatch one extraction-tier sub-agent per artifact, in parallel with the other Phase 1 grounding agents.

#### Consolidated Grounding Summary

Consolidate all dispatched results into a short grounding summary using these sections (omit any section that produced nothing). Phase 1.5 will append a `Topic axes` section to this same summary after consolidation completes:

- **Codebase context** *(repo mode)* — project shape, notable patterns, pain points, leverage points OR **Topic context** *(elsewhere mode)* — topic shape, stated constraints, user-named pain points, opportunity hooks
- **User-named references** *(repo mode, when the focus hint named root-level `*.md` files)* — full content from directive files the user explicitly named in their prompt or focus. Phase 2 treats these as constraint
- **Additional context** *(repo mode, when other root-level markdown was discovered but not named)* — one-line gists per file. Phase 2 treats these as background, not direction
- **RAG research results** — relevant patterns and prior work found via `rag_search`
- **Issue intelligence** *(when present, repo mode only)* — theme summaries with titles, descriptions, issue counts, and trend directions
- **User-supplied research** *(when the user provided research artifacts)* — dossier gists with paths, or inline content for small artifacts

**Failure handling.** Grounding agent failures follow "warn and proceed" — never block on grounding failure. If RAG research fails, log a warning and continue. If elsewhere-mode intake produced no usable context, note in the grounding summary that context is thin so Phase 2 sub-agents can compensate with broader generation.

### Phase 1.5: Topic-Surface Decomposition

Before dispatching frame agents in Phase 2, decompose the topic into 3-5 orthogonal **axes** that name *what aspects of the subject to think about*. Phase 2 frames determine *how to think* (the lens); axes determine *what to think on* (the surface). Without an explicit axis list, parallel frames tend to converge on whichever interpretation of the subject is most salient at first read — other parts of the surface go unexamined regardless of how many frames run. Lens diversity alone does not produce surface coverage.

The axis analysis itself is a single orchestrator-side pass against the grounding summary already in context — no additional grounding read, no user-facing question. The evidence scouts below are the only dispatch in this phase.

**Axis criteria:**

- **3-5 axes.** Fewer than 3 means the topic is atomic — skip per the rule below. More than 5 fragments dispatch and produces thin coverage on each.
- **Orthogonal.** A single idea should naturally fall on one axis, not span multiple. Merge axes that overlap heavily.
- **Derived from grounding.** The grounding summary contains the substance the axes name; do not pick axes from a generic template (e.g., "discovery / engagement / retention" applied to every topic).
- **At the same level.** Don't mix "the entire pricing page" with "the $9.99 tier copy" in the same list.
- **Named in the topic's language.** "Send mechanics" beats "outbound flow optimization." Use words a reader of the topic would recognize, not meta-language about ideation.

**Worked examples (illustrative, not a template — derive from actual grounding):**

| Topic | Axes |
|---|---|
| Social sharing of crossfire and convergence pages | Send mechanics; discovery (receive side); arrival/dwell experience; compounding over time; actor types (first-party, expert, reader) |
| Improve our authentication system | Sign-in flow; session management; account recovery; permissions; identity providers |
| Dark mode for our app | Visual surfaces; toggle UX; system-preference detection; asset variants; edge cases (third-party content) |
| Cache invalidation in the data layer | Trigger surfaces; coordination across replicas; staleness tolerance per data class; observability of invalidation events |

**Skip condition.** Some subjects are atomic and resist meaningful decomposition — a single string output (a name, a tagline), a narrowly-scoped tactical fix ("the typo on line 47 of README"), or a topic where the candidate axes *are* the deliverable (e.g., "what surface should the API expose?"). When 3+ orthogonal axes that pass the criteria above cannot be generated, skip decomposition. Note `Decomposition skipped — atomic subject` in the grounding summary so the artifact records the choice.

**Surprise-me skip.** In surprise-me mode there is no settled subject to decompose — different frames will surface different subjects in Phase 2, and the cross-cutting synthesis step there serves the analogous coverage role. Skip Phase 1.5 in surprise-me mode and note `Decomposition skipped — surprise-me mode` in the grounding summary.

**Evidence scouts (repo mode, when axes exist).** Decomposition names what to look at; scouts gather what is actually there. The Phase 1 scan is an orientation gist — too thin for ideation agents to quote from — so dispatch one extraction-tier sub-agent per axis (max 5) in parallel. Pass each scout a kebab-case slug for its axis, with this prompt:

> Gather evidence about **{axis}** in this repo, scoped to {focus/subject}. Search first with `Glob` and `Grep`, then read targeted sections — budget ~20 reads, preferring ranges over whole files. Write an **evidence dossier**: at most 150 lines of verbatim quotes and short code snippets, each with a `file:line` pointer, covering pain points, workarounds, TODO/FIXME markers, surprising patterns, and leverage points on this axis. Extraction only — quote what the repo says; do not interpret, theme, or propose ideas. If the axis has little footprint, write less rather than padding. Return only a gist: 3-5 lines summarizing what the dossier holds, plus its absolute path and entry count.

Append the returned gists (with dossier paths) — not the dossier contents — to the consolidated grounding summary under `Evidence: <axis>`. The dossier files are the evidence layer Phase 2 agents read and cite from; keeping their bulk out of the orchestrator's context is the point of the file handoff, so do not read them into the main session. Skip scouts when decomposition was skipped (atomic subjects rarely need deep evidence — Phase 2 verification reads cover them), in surprise-me mode, and in elsewhere modes (no repo to scout; user-supplied context and RAG research are the grounding there).

Append the axis list (or skip-reason) to the consolidated grounding summary under a section labeled `Topic axes`. Phase 2 reads this section to thread axes into sub-agent prompts; Phase 3 uses it for axis-spread scoring; the Phase 4 artifact includes it under Grounding Context (per `references/ideation-sections.md`).

### Phase 2: Divergent Ideation

Generate the full candidate list before critiquing any idea.

Read `references/divergent-ideation.md` now — before building any ideation dispatch prompt. This load is non-optional. The file contains the fleet tiering and dispatch counts, the dispatch payload structure, the ambition charter (included verbatim in every dispatch), the six ideation frames, the per-idea output contract, the generation rules, the issue-tracker and surprise-me variants, and the post-merge synthesis and checkpoint steps — none of which appear in this main body. Dispatch prompts cannot be correctly constructed without it, and improvising them from memory produces unverifiable candidates — the precise failure this skill exists to prevent. The fleet counts are cost transparency, not the dispatch spec. "Quickly" means smaller volume targets, not skipping the reference.

After the merge, synthesis, and axis-coverage steps in that reference complete — and before writing and presenting the deliverable — load `references/post-ideation-workflow.md`. This load is non-optional. The file contains the adversarial filtering rubric, the auto-write + concise-summary flow (Phase 4), the artifact section contract, the quality bar, and the canonical Phase 5 next-steps menu — these details do not appear anywhere in this main body. Skipping the load silently degrades every subsequent step; the agent improvises the flow and menu from memory instead of following the documented ones. "Quickly" means fewer Phase 2 sub-agents, not skipping references. Do not load this file before Phase 2 agent dispatch completes.
