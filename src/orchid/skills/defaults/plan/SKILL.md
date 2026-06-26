---
name: plan
description: 'Create structured plans for multi-step tasks -- software features, research workflows, events, study plans, or any goal that benefits from structured breakdown. Use when the user says "plan this", "create a plan", "how should we build", "break this down", or when a brainstorm doc is ready for planning.'
---

# Create Technical Plan

`brainstorm` defines **WHAT** to build. `plan` defines **HOW** to build it. `work` executes the plan. A prior brainstorm is useful context but never required -- `plan` works from any input: a requirements doc, a bug report, a feature idea, or a rough description.

**When directly invoked, always plan.** Never classify a direct invocation as "not a planning task" and abandon the workflow. If the input is unclear, ask clarifying questions or use the planning bootstrap (Phase 0.4) to establish enough context -- but always stay in the planning workflow.

This workflow produces a durable implementation plan. It does **not** implement code, run tests, or learn from execution-time results.

## Interaction Method

When asking the user a question, present options as a numbered list and wait for the user's reply. Include a free-text fallback. Never silently skip the question. Ask one question at a time. Prefer a concise single-select choice when natural options exist.

## Feature Description

**If no feature description is provided, ask the user:** "What would you like to plan? Describe the task, goal, or project you have in mind." Then wait for their response before continuing.

If the input is present but unclear or underspecified, do not abandon -- ask one or two clarifying questions, or proceed to Phase 0.4's planning bootstrap.

**IMPORTANT: All file references in the plan document must use repo-relative paths (e.g., `src/models/user.rb`), never absolute paths.**

## Core Principles

1. **Use requirements as the source of truth** - If `brainstorm` produced a requirements document, planning should build from it rather than re-inventing behavior.
2. **Decisions, not code** - Capture approach, boundaries, files, dependencies, risks, and test scenarios. Do not pre-write implementation code or shell command choreography. Pseudo-code sketches or DSL grammars that communicate high-level technical design are welcome when they help a reviewer validate direction.
3. **Research before structuring** - Explore the codebase, institutional learnings, and external guidance when warranted before finalizing the plan.
4. **Right-size the artifact** - Small work gets a compact plan. Large work gets more structure. The philosophy stays the same at every depth.
5. **Separate planning from execution discovery** - Resolve planning-time questions here. Explicitly defer execution-time unknowns to implementation.
6. **Keep the plan portable** - The plan should work as a living document, review artifact, or issue body without embedding tool-specific executor instructions.
7. **Carry execution posture lightly when it matters** - If the request, origin document, or repo context clearly implies test-first, characterization-first, or another non-default execution posture, reflect that in the plan as a lightweight signal.
8. **Honor user-named resources** - When the user names a specific resource -- a CLI, MCP server, URL, file, doc link, or prior artifact -- treat it as authoritative input, not a suggestion.

## Plan Quality Bar

Every plan should contain:
- A clear problem frame and scope boundary
- Concrete requirements traceability back to the request or origin document
- Repo-relative file paths for the work being proposed (never absolute paths)
- Explicit test file paths for feature-bearing implementation units
- Decisions with rationale, not just tasks
- Existing patterns or code references to follow
- Enumerated test scenarios for each feature-bearing unit
- Clear dependencies and sequencing

A plan is ready when an implementer can start confidently without needing the plan to write the code for them.

## Workflow

### Phase 0: Resume, Source, and Scope

#### 0.1 Resume Existing Plan Work When Appropriate

If the user references an existing plan file or there is an obvious recent matching plan in `docs/plans/`:
- Read it
- Confirm whether to update it in place or create a new plan
- If updating, revise only the still-relevant sections

**Deepen intent:** The word "deepen" (or "deepening") in reference to a plan is the primary trigger for the deepening fast path. When the user says "deepen the plan", "deepen my plan", "run a deepening pass", or similar, the target document is a **plan** in `docs/plans/`. Once the plan is identified and appears complete:
- Plans with YAML frontmatter: short-circuit to Phase 5.3 (Confidence Check and Deepening) in interactive mode.
- Plans without YAML frontmatter: route to `references/universal-planning.md` for editing or deepening instead.

Normal editing requests should NOT trigger the fast path -- they follow the standard resume flow.

#### 0.1a Recognize Approach-Altitude Requests

Some requests are better answered one level up: produce a grounded **approach-plan** -- a plan for *how the deliverable will be made* -- and hold there, rather than zero-shotting the deliverable.

**Explicit (always honored).** When the user asks for the approach itself -- "plan for a plan", "plan the approach", "plan how you'll do X" -- enter approach altitude and hold at the approach.

**Proactive (rare, conservative).** When the user gives a plain request with no approach-language, offer an approach-plan **only when both** method uncertainty and cost of getting it wrong are clearly high.

On entry, read `references/approach-altitude.md` and follow it. Otherwise continue to Phase 0.1b.

#### 0.1b Classify Task Domain

If the task asks to build, modify, refactor, deploy, or architect software (code, schemas, infrastructure), continue to Phase 0.2.

Otherwise, read `references/universal-planning.md` and follow that workflow instead. Skip all subsequent phases.

If the domain is genuinely ambiguous, ask the user before routing.

#### 0.2 Find Upstream Requirements Document

Before asking planning questions, search `docs/brainstorms/` for files matching `*-requirements.md`.

**Relevance criteria:** A requirements document is relevant if:
- The topic semantically matches the feature description
- It was created within the last 30 days
- It appears to cover the same user problem or scope

If multiple source documents match, ask which one to use.

#### 0.3 Use the Source Document as Primary Input

If a relevant requirements document exists:
1. Read it thoroughly
2. Announce that it will serve as the origin document for planning
3. Carry forward: Problem frame, Requirements and success criteria, Scope boundaries, Key decisions and rationale, Dependencies or assumptions, Outstanding questions
4. Reference important carried-forward decisions in the plan with `(see origin: <source-path>)`
5. Do not silently omit source content -- if the origin document discussed it, the plan must address it even if briefly

If no relevant requirements document exists, planning may proceed from the user's request directly.

#### 0.4 Planning Bootstrap (No Requirements Doc or Unclear Input)

If no relevant requirements document exists, or the input needs more structure:
- Assess whether the request is already clear enough for direct technical planning -- if so, continue to Phase 0.5
- If the ambiguity is mainly product framing, recommend `brainstorm` as a suggestion -- but always offer to continue planning here as well
- If the user wants to continue, run the planning bootstrap to establish:
  - Problem frame
  - Intended behavior
  - Scope boundaries and obvious non-goals
  - Success criteria
  - Blocking questions or assumptions

Keep this bootstrap brief. If the bootstrap uncovers major unresolved product questions, recommend `brainstorm` again.

#### 0.5 Classify Outstanding Questions Before Planning

If the origin document contains `Resolve Before Planning` or similar blocking questions:
- Review each one before proceeding
- Reclassify it into planning-owned work only if it is actually a technical, architectural, or research question
- Keep it as a blocker if it would change product behavior, scope, or success criteria

If true product blockers remain, surface them clearly and ask the user whether to resume `brainstorm` or convert them into explicit assumptions.

#### 0.6 Assess Plan Depth

- **Lightweight** - small, well-bounded, low ambiguity
- **Standard** - normal feature or bounded refactor with some technical decisions to document
- **Deep** - cross-cutting, strategic, high-risk, or highly ambiguous implementation work

#### 0.7 Scoping Synthesis

Surface call-outs to the user -- the specific forks in scope or approach where user input materially changes the plan -- so scope can be corrected **before Phase 1 research is spent**.

Fires **only in solo invocation** -- when Phase 0.2 found no upstream brainstorm doc AND Phase 0.4 stayed in `plan` AND Phase 0.5 cleared AND not on Phase 0.1 fast paths.

**Read `references/synthesis-summary.md` before composing the scoping synthesis.**

Compose an internal three-bucket scope draft (Stated / Inferred / Out of scope). Derive call-outs, then emit the appropriate template.

**Tier guard on auto-proceed:** auto-proceed fires only when plan depth is **Lightweight AND zero call-outs survive**. Standard and Deep plans always fire the confirmation gate.

### Phase 1: Gather Context

#### 1.1 Local Research (Always Runs)

Prepare a concise planning context summary:
- If an origin document exists, summarize the problem frame, requirements, and key decisions
- Otherwise use the feature description directly
- If `STRATEGY.md` exists, read it and include the relevant pieces
- If `CONCEPTS.md` exists at repo root, read it

Use `grep`, `glob`, and `read` to research:
- Technology stack and versions
- Architectural patterns and conventions to follow
- Implementation patterns, relevant files, modules, and tests
- `AGENTS.md` guidance that materially affects the plan
- Institutional learnings from `docs/solutions/`

#### 1.1b Detect Execution Posture Signals

Decide whether the plan should carry a lightweight execution posture signal. Look for signals such as:
- The user explicitly asks for TDD, test-first, or characterization-first work
- The origin document calls for test-first implementation
- Local research shows the target area is legacy, weakly tested, or historically fragile

#### 1.2 Decide on External Research

Based on the origin document, user signals, and local findings, decide **whether** external research adds value.

**Always lean toward external research when:**
- The topic is high-risk: security, payments, privacy, external APIs, migrations, compliance
- The codebase lacks relevant local patterns
- The user is exploring unfamiliar territory

**Skip external research when:**
- The codebase already shows a strong local pattern
- The user already knows the intended shape
- Additional external context would add little practical value

#### 1.4 Consolidate Research

Summarize: relevant codebase patterns, institutional learnings, external references, related issues/PRs, and constraints that should materially shape the plan.

### Phase 2: Resolve Planning Questions

Build a planning question list from gaps discovered in research.

For each question, decide whether it should be:
- **Resolved during planning** - the answer is knowable from repo context or user choice
- **Deferred to implementation** - the answer depends on code changes or runtime behavior

Ask the user only when the answer materially affects architecture, scope, or risk.

### Phase 3: Structure the Plan

#### 3.1 Title and File Naming

- Draft a clear, searchable title using conventional format such as `feat: Add user authentication`
- Determine the plan type: `feat`, `fix`, or `refactor`
- Build the filename: `docs/plans/YYYY-MM-DD-NNN-<type>-<descriptive-name>-plan.md`

#### 3.3 Break Work into Implementation Units

Each unit should represent one meaningful change that an implementer could typically land as an atomic commit.

Good units are:
- Focused on one component, behavior, or integration seam
- Usually touching a small cluster of related files
- Ordered by dependency
- Concrete enough for execution without pre-writing code

Each unit carries a stable plan-local **U-ID** (`U1`, `U2`, ...). U-IDs survive reordering, splitting, and deletion.

#### 3.4 High-Level Technical Design

When the plan's technical approach has shape that prose alone doesn't carry well, include a High-Level Technical Design section. The exact form (component diagram, sequence, swim lane, flowchart, state machine, decision matrix) is the agent's call per artifact.

See `references/plan-sections.md` for the section catalog.

#### 3.5 Define Each Implementation Unit

Each unit is a level-3 heading carrying a stable U-ID prefix: `### U1. [Name]`.

For each unit, include:
- **Goal** - what this unit accomplishes
- **Requirements** - which requirements or success criteria it advances (cite R-IDs)
- **Dependencies** - what must exist first (cite by U-ID)
- **Files** - repo-relative file paths to create, modify, or test
- **Approach** - key decisions, data flow, component boundaries
- **Execution note** - optional, only when the unit benefits from a non-default execution posture
- **Patterns to follow** - existing code or conventions to mirror
- **Test scenarios** - enumerate the specific test cases the implementer should write
- **Verification** - how an implementer should know the unit is complete

#### 3.6 Keep Planning-Time and Implementation-Time Unknowns Separate

If something is important but not knowable yet, record it explicitly under deferred implementation notes rather than pretending to resolve it in the plan.

### Phase 4: Write the Plan

**NEVER CODE during this skill.** Research, decide, and write the plan -- do not start implementation.

Use one planning philosophy across all depths. Change the amount of detail, not the boundary between planning and execution.

#### 4.1 Plan Depth Guidance

**Lightweight** - compact, usually 2-4 implementation units.

**Standard** - full core template, usually 3-6 implementation units. Include risks, deferred questions, and system-wide impact when relevant.

**Deep** - full core template plus optional analysis sections, usually 4-8 implementation units. Group units into phases when that improves clarity.

#### 4.2 Section Contract and Rendering

Compose the plan using two paired references:

- `references/plan-sections.md` -- the section contract (what the plan contains).
- `references/markdown-rendering.md` -- how markdown presents the sections.

Omit "include when material" sections that don't carry information for this specific plan.

#### 4.3 Planning Rules

- **All file paths must be repo-relative** -- never use absolute paths
- Prefer path plus class/component/pattern references over brittle line numbers
- Do not include implementation code -- no imports, exact method signatures, or framework-specific syntax
- Pseudo-code sketches and DSL grammars are allowed when they communicate design direction
- Mermaid diagrams are encouraged when they clarify relationships or flows
- Do not include git commands, commit messages, or exact test command recipes
- Do not expand implementation units into micro-step instructions
- Do not pretend an execution-time question is settled just to make the plan look complete

### Phase 5: Final Review, Write File, and Handoff

#### 5.1 Review Before Writing

Before finalizing, check:
- The plan does not invent product behavior that should have been defined in `brainstorm`
- Every major decision is grounded in the origin document or research
- Each implementation unit is concrete, dependency-ordered, and implementation-ready
- Each feature-bearing unit has test scenarios from every applicable category
- Deferred items are explicit
- U-IDs are unique and follow the stability rule

If the plan originated from a requirements document, re-read that document and verify:
- The chosen approach still matches the product intent
- Scope boundaries and success criteria are preserved
- Blocking questions were either resolved, explicitly assumed, or sent back to `brainstorm`
- Every section of the origin document is addressed in the plan

#### 5.2 Write Plan File

**REQUIRED: Write the plan file to disk before presenting any options.**

Write to:
```
docs/plans/YYYY-MM-DD-NNN-<type>-<descriptive-name>-plan.md
```

**Write tight.** Hold every kept section to the prose-economy discipline in `references/plan-sections.md`.

Confirm (use absolute path so the reference is clickable):
```text
Plan written to <absolute path to plan>
```

#### 5.3 Confidence Check and Deepening

After writing the plan file, automatically evaluate whether the plan needs strengthening.

When deepening is warranted, read `references/deepening-workflow.md` for confidence scoring checklists, section-to-agent dispatch mapping, and execution instructions.

#### 5.4 Handoff

After the plan is written, read `references/plan-handoff.md` for post-generation options including:
- Execute the plan with `work`
- Review specific sections
- Done for now
