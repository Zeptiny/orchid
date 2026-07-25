---
name: brainstorm
description: 'Explore requirements and approaches through collaborative dialogue, then write a right-sized requirements document. Use when the user says "let''s brainstorm", "what should we build", or "help me think through X", presents a vague or ambitious feature request, or seems unsure about scope or direction.'
---

# Brainstorm a Feature or Improvement

Brainstorming helps answer **WHAT** to build through collaborative dialogue. It precedes `plan`, which answers **HOW** to build it.

The durable output of this workflow is a **requirements document**. In other workflows this might be called a lightweight PRD or feature brief. Keep the workflow name `brainstorm`, but make the written artifact strong enough that planning does not need to invent product behavior, scope boundaries, or success criteria.

This skill does not implement code. It explores, clarifies, and documents decisions for later planning or execution.

**IMPORTANT: All file references in generated documents must use repo-relative paths (e.g., `src/models/user.rb`), never absolute paths. Absolute paths break portability across machines, worktrees, and teammates.**

## Core Principles

1. **Assess scope first** - Match the amount of ceremony to the size and ambiguity of the work.
2. **Be a thinking partner** - Suggest alternatives, challenge assumptions, and explore what-ifs instead of only extracting requirements.
3. **Resolve product decisions here** - User-facing behavior, scope boundaries, and success criteria belong in this workflow. Detailed implementation belongs in planning.
4. **Keep implementation out of the requirements doc by default** - Do not include libraries, schemas, endpoints, file layouts, or code-level design unless the brainstorm itself is inherently about a technical or architectural change.
5. **Right-size the artifact** - Simple work gets a compact requirements document or brief alignment. Larger work gets a fuller document. Do not add ceremony that does not help planning.
6. **Apply YAGNI to carrying cost, not coding effort** - Prefer the simplest approach that delivers meaningful value. Avoid speculative complexity and hypothetical future-proofing, but low-cost polish or delight is worth including when its ongoing cost is small and easy to maintain.

## Interaction Rules

These rules apply to every brainstorm, including the universal (non-software) flow routed to `references/universal-brainstorming.md`.

1. **Ask one question at a time** - One question per turn, even when sub-questions feel related. Stacking several questions in a single message produces diluted answers; pick the single most useful one and ask it.
2. **Prefer single-select multiple choice** - Use single-select when choosing one direction, one priority, or one next step.
3. **Use multi-select rarely and intentionally** - Use it only for compatible sets such as goals, constraints, non-goals, or success criteria that can all coexist. If prioritization matters, follow up by asking which selected item is primary.
4. **Ask the user directly in conversation** - Present options as a numbered list and wait for the user's reply. Include a free-text fallback so well-chosen options scaffold the answer without confining it. This default holds for opening and elicitation questions too, not only narrowing.
5. **Use an open-ended question only when the question is genuinely open** - Drop structured options when the answer is inherently narrative, when presented options would steer a diagnostic or introspective answer, or when you cannot write 3-4 genuinely distinct, plausibly-correct options without padding. The test: if you'd be straining to fill the option slots, the question is open — ask it open-ended. Rule 1 still applies: one question per turn.
6. **Open-ended questions earn their place only when they're specific enough to elicit a substantive answer** - Apply Rule 5 silently: just ask the question, never narrate the form choice. The question must give the user something concrete to anchor on. Good: *"What's the most concrete thing someone's already done about this — paid for it, built a workaround, quit a tool over it?"* — it names what counts as an answer. Too thin: *"What's your take?"* — nothing to bite into, and framings that imply a short answer ("briefly", yes/no) waste the open question the same way.

## Output Guidance

- **Keep outputs concise** - Prefer short sections, brief bullets, and only enough detail to support the next decision.
- **Use repo-relative paths** - When referencing files, use paths relative to the repo root (e.g., `src/models/user.rb`), never absolute paths. Absolute paths make documents non-portable across machines and teammates.

## Feature Description

**If no feature description is provided, ask the user:** "What would you like to explore? Please describe the feature, problem, or improvement you're thinking about."

Do not proceed until you have a feature description from the user.

## Execution Flow

### Phase 0: Resume, Assess, and Route

#### 0.1 Resume Existing Work When Appropriate

If the user references an existing brainstorm topic or document, or there is an obvious recent matching `*-requirements.md` file in `docs/brainstorms/`:
- Read the document
- Confirm with the user before resuming: "Found an existing requirements doc for [topic]. Should I continue from this, or start fresh?"
- If resuming, summarize the current state briefly, continue from its existing decisions and outstanding questions, and update the existing document instead of creating a duplicate

#### 0.1b Classify Task Domain

Before proceeding to Phase 0.2, classify whether this is a software task. The key question is: **does the task involve building, modifying, or architecting software?** -- not whether the task *mentions* software topics.

**Software** (continue to Phase 0.2) -- the task references code, repositories, APIs, databases, or asks to build/modify/debug/deploy software.

**Non-software brainstorming** (route to universal brainstorming) -- BOTH conditions must be true:
- None of the software signals above are present
- The task describes something the user wants to explore, decide, or think through in a non-software domain

**Neither** (respond directly, skip all brainstorming phases) -- the input is a quick-help request, error message, factual question, or single-step task that doesn't need a brainstorm.

**If non-software brainstorming is detected:** Read `references/universal-brainstorming.md` now and follow it -- it replaces Phases 0.2-4 entirely. The **Core Principles and Interaction Rules above still apply unchanged** -- including one-question-per-turn and asking the user directly in conversation -- and are the only part of this file that survives the route.

#### 0.2 Assess Whether Brainstorming Is Needed

**Clear requirements indicators:**
- Specific acceptance criteria provided
- Referenced existing patterns to follow
- Described exact expected behavior
- Constrained, well-defined scope

**If requirements are already clear:**
Keep the interaction brief. Confirm understanding and present concise next-step options rather than forcing a long brainstorm. Only write a short requirements document when a durable handoff to planning or later review would be valuable. Skip Phase 1.1 and 1.2 entirely -- go straight to Phase 1.3 or Phase 2.5 in announce-mode (synthesis emitted for visibility, no blocking confirmation), then to Phase 3.

#### 0.3 Assess Scope

Use the feature description plus a light repo scan to classify the work:
- **Lightweight** - small, well-bounded, low ambiguity
- **Standard** - normal feature or bounded refactor with some decisions to make
- **Deep** - cross-cutting, strategic, or highly ambiguous

If the scope is unclear, ask one targeted question to disambiguate and then proceed.

**Deep sub-mode: feature vs product.** For Deep scope, also classify whether the brainstorm must establish product shape or inherit it:

- **Deep -- feature** (default): existing product shape anchors decisions. Primary actors, core outcome, positioning, and primary flows are already established in the product or repo. The brainstorm extends or refines within that shape.
- **Deep -- product**: the brainstorm must establish product shape rather than inherit it. Primary actors, core outcome, positioning against adjacent products, or primary end-to-end flows are materially unresolved.

Product-tier triggers additional Phase 1.2 questions and additional sections in the requirements document. Feature-tier uses the current Deep behavior unchanged.

### Phase 1: Understand the Idea

#### 1.1 Existing Context Scan

Scan the repo before substantive brainstorming. Match depth to scope:

**Lightweight** -- Search for the topic, check if something similar already exists, and move on.

**Standard and Deep** -- Two passes:

*Constraint Check (inline)* -- Check project instruction files (`AGENTS.md`) for workflow, product, or scope constraints that affect the brainstorm. Also read `STRATEGY.md` if it exists -- the product's target problem, approach, persona, and active tracks are direct input to what this brainstorm should deliver. Also read `CONCEPTS.md` at repo root if it exists -- the project's authoritative vocabulary. Use these names in dialogue, approaches, and the requirements doc; map user-offered synonyms back. If any of these add nothing, move on.

*Topic Scan* -- Use `grep`, `glob`, and `read` to gather grounding for the brainstorm. Search for whether something similar already exists, the most relevant existing artifacts (brainstorms, plans, specs, feature docs), adjacent examples of similar behavior, and the current state of anything the topic would touch. Budget ~20 reads, preferring ranges over whole files. Extract only -- quote what the repo says; do not interpret or propose.

If the scan surfaces nothing relevant, say so and continue. Two rules govern technical depth during the scan:

1. **Verify before claiming** -- When the brainstorm touches checkable infrastructure (database tables, routes, config files, dependencies, model definitions), read the relevant source files to confirm what actually exists. Any claim that something is absent -- a missing table, an endpoint that doesn't exist, a dependency not in the Gemfile, a config option with no current support -- must be verified against the codebase first; if not verified, label it as an unverified assumption.

2. **Defer design decisions to planning** -- Implementation details like schemas, migration strategies, endpoint structure, or deployment topology belong in planning, not here -- unless the brainstorm is itself about a technical or architectural decision, in which case those details are the subject of the brainstorm and should be explored.

#### 1.2 Product Pressure Test

Before generating approaches, scan the user's opening for rigor gaps. Match depth to scope.

This is agent-internal analysis, not a user-facing checklist. Read the opening, note which gaps actually exist, and raise only those as questions during Phase 1.3 -- folded into the normal flow of dialogue, not fired as a pre-flight gauntlet. A fuzzy opening may earn three or four probes; a concrete, well-framed one may earn zero because no scope-appropriate gaps were found.

**Lightweight:**
- Is this solving the real user problem?
- Are we duplicating something that already covers this?
- Is there a clearly better framing with near-zero extra cost?

**Standard -- scan for these gaps:**

- **Evidence gap.** The opening asserts want or need, but doesn't point to anything the would-be user has already done. When present, ask for the most concrete thing someone has already done about this.
- **Specificity gap.** The opening describes the beneficiary at a level of abstraction where the agent couldn't design without silently inventing who they are. When present, ask the user to name a specific person or narrow segment, and what changes for that person when this ships.
- **Counterfactual gap.** The opening doesn't make visible what users do today when this problem arises. When present, ask what the current workaround is, even if it's messy -- and what it costs them.
- **Attachment gap.** The opening treats a particular solution shape as the thing being built, rather than the value that shape is supposed to deliver. When present, ask what the smallest version that still delivers real value would look like.

Plus these synthesis questions -- not gap lenses, product-judgment the agent weighs in its own reasoning:
- Is there a nearby framing that creates more user value without more carrying cost?
- Given the current project state, user goal, and constraints, what is the single highest-leverage move right now?

Favor moves that compound value, reduce future carrying cost, or make the product meaningfully more useful or compelling. Use the result to sharpen the conversation, not to bulldoze the user's intent.

**Deep** -- Standard lenses and synthesis questions plus:
- Is this a local patch, or does it move the broader system toward where it wants to be?

**Deep -- product** -- Deep plus:

- **Durability gap.** The opening's value proposition rests on a current state of the world that may shift in predictable ways. When present, ask how the idea fares under the most plausible near-term shifts.
- What adjacent product could we accidentally build instead, and why is that the wrong one?
- What would have to be true in the world for this to fail?

#### 1.3 Collaborative Dialogue

Follow the Interaction Rules above.

**Guidelines:**
- Ask what the user is already thinking before offering your own ideas. This surfaces hidden context and prevents fixation on AI-generated framings.
- Start broad (problem, users, value) then narrow (constraints, exclusions, edge cases)
- **Rigor probes fire before Phase 2 and are open-ended, not menus.** Each scope-appropriate gap found in Phase 1.2 fires as a **separate** direct open-ended probe -- one probe satisfies one gap, not multiple. Surface them progressively across the conversation -- interleaving with narrowing moves is fine -- as long as every gap found in Phase 1.2 has been probed before Phase 2.
- Clarify the problem frame, validate assumptions, and ask about success criteria
- Make requirements concrete enough that planning will not need to invent behavior
- Surface dependencies or prerequisites only when they materially affect scope
- Resolve product decisions here; leave technical implementation choices for planning
- Bring ideas, alternatives, and challenges instead of only interviewing

**Before exiting Phase 1.3: integration check.** Mentally combine what the user has said so far and surface any non-obvious consequences the dialogue hasn't probed. If user-stated X plus user-stated Y plus your-default-Z produces a downstream effect the user is unlikely to have tracked through one-question-at-a-time dialogue, probe it now while you're still in dialogue.

**Exit condition:** Continue until the idea is clear AND no integration-check questions are pending, OR the user explicitly wants to proceed.

### Phase 2: Explore Approaches

If multiple plausible directions remain, propose **2-3 concrete approaches** based on research and conversation. Otherwise state the recommended direction directly.

Use at least one non-obvious angle -- inversion (what if we did the opposite?), constraint removal (what if X weren't a limitation?), or analogy from how another domain solves this. The first approaches that come to mind are usually variations on the same axis. Hold each approach to an anti-genericness test: if it would appear in a generic listicle for this problem category, sharpen it against the grounding or drop it.

Present approaches first, then evaluate. Let the user see all options before hearing which one is recommended -- leading with a recommendation before the user has seen alternatives anchors the conversation prematurely.

When useful, include one deliberately higher-upside alternative:
- Identify what adjacent addition or reframing would most increase usefulness, compounding value, or durability without disproportionate carrying cost. Present it as a challenger option alongside the baseline, not as the default. Omit it when the work is already obviously over-scoped or the baseline request is clearly the right move.

At product tier, alternatives should differ on *what* is built (product shape, actor set, positioning), not *how* it is built. Implementation-variant alternatives belong at feature tier.

For each approach, provide:
- Brief description (2-3 sentences)
- Pros and cons
- Key risks or unknowns
- When it's best suited

**Approach granularity: mechanism / product shape, not architecture.** Approach descriptions name mechanism-level distinctions and product-relevant trade-offs. They do NOT name implementation specifics -- column names, table names, file paths, service classes, JSON shapes, exact method names. Those are `plan`'s job.

After presenting all approaches, state your recommendation and explain why. Prefer simpler solutions when added complexity creates real carrying cost, but do not reject low-cost, high-value polish just because it is not strictly necessary.

If one approach is clearly best and alternatives are not meaningful, skip the menu and state the recommendation directly.

If relevant, call out whether the choice is:
- Reuse an existing pattern
- Extend an existing capability
- Build something net new

### Phase 2.5: Synthesis Summary

**STOP. Before composing the synthesis, read `references/synthesis-summary.md`.** The two-stage shape (internal three-bucket draft -> chat-time scoping synthesis), the four scoping synthesis sections with their keep tests, the per-bullet affirmability and detail tests, the tier-aware bullet budget with re-cut rule, anti-pattern guidance, soft-cut behavior, self-redirect support, and internal-draft routing into doc body sections all live there.

Surface a scoping synthesis to the user before Phase 3 writes the requirements doc -- the user's last opportunity to correct scope before the artifact lands.

Fires for **all tiers** including Lightweight. Skip Phase 2.5 entirely on the Phase 0.1b non-software (universal-brainstorming) route.

**Path A vs Path B:** the scoping synthesis shape depends on TWO signals -- whether any blocking question fired AND what tier Phase 0.3 classified the scope as.

- **Path A -- no blocking questions fired AND tier is Lightweight**: announce-mode. Emit "What we're building" prose only (1-3 sentences), then proceed to Phase 3 doc-write in the same turn. No other sections, no confirmation question. Do NOT end the turn waiting for acknowledgment.
- **Path B -- at least one blocking question fired, OR tier is Standard / Deep-feature / Deep-product**: full tier-aware scoping synthesis with confirmation gate. Two scenarios fire Path B: (a) the user invested answer-time during dialogue, or (b) the user pre-loaded substantive scope content.

### Phase 3: Capture the Requirements

Write or update a requirements document only when the conversation produced durable decisions worth preserving -- see `references/brainstorm-sections.md` "Decide whether a doc is warranted at all" for the criteria and the bug-fix stress test. Skip document creation when the user only needs brief alignment and the decisions can flow downstream (`plan`, commit message, `docs/solutions/`) without a brainstorm artifact in the middle.

When a doc is warranted, compose it using:

- `references/brainstorm-sections.md` -- section contract (outcomes, hard floor, include-when-material catalog, agency rules, ID conventions).
- `references/markdown-rendering.md` -- how markdown presents the sections.

**Write tight.** A section being material is not license to pad it. Hold every kept section to the prose-economy discipline in `references/brainstorm-sections.md`: one idea per sentence, a requirement is intent plus at most one qualifier, defer forks to Outstanding Questions rather than specifying both arms, resolve superseded text in place rather than stacking strata. Before declaring the doc written, run the named test there -- could a reader find a contradiction in each section in one pass?

Write to `docs/brainstorms/YYYY-MM-DD-<topic>-requirements.md`. Confirm with the absolute path so the reference is clickable.

#### Vocabulary Capture -- after the requirements doc (only if CONCEPTS.md already exists)

**Skip this step entirely if `CONCEPTS.md` does not exist at repo root.**

Run this **after** the approaches, the scope synthesis, and the requirements doc. Scan the full dialogue and the requirements doc for **resolved** domain terms -- terms where the conversation actively pinned down a precise local meaning. For each resolved term: if missing, add it; if present but new precision surfaced, refine it; if already consistent, no action.

**Domain entities, named processes, and status concepts with project-specific meaning only.** Not file paths, class names, function signatures, or implementation decisions.

### Phase 4: Handoff

Read `references/handoff.md` now -- before presenting any options. The option set and its visibility conditions, the per-selection dispatch instructions, and the closing summary formats all live there.
