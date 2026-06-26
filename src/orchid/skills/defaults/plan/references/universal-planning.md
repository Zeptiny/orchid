---
description: Universal planning workflow for non-software tasks -- domain-agnostic planning with answer-seeking and plan-seeking dispositions.
---

# Universal Planning Workflow

This file is loaded when `plan` detects a non-software task (Phase 0.1b). It replaces the software-specific phases (0.2 through 5.1) with a domain-agnostic planning workflow.

## Before starting: verify classification

- **Is this actually a software task?** A study guide about Rust is non-software. A Rust library refactor is software. If this is actually software, return to Phase 0.2 in the main SKILL.md.
- **Is this a trivial single-fact lookup?** Only a question answerable from one fact with no research, retrieval, or judgment skips planning -- answer it directly and stop. A question that needs multiple steps, any retrieval, or synthesis does **not** qualify.

---

## Disposition: plan-seeking vs. answer-seeking

- **Plan-seeking** -- the deliverable is a *plan*: a trip itinerary, a study curriculum, an event runbook, a project plan. -> Follow Steps 1-3 below.
- **Answer-seeking** -- the deliverable is an *answer*: an investigative or analytical question. -> Follow the **Answer-seeking flow** below; skip Step 3.

If a request blends both, do the answer-seeking research first, then produce the plan artifact.

---

## Answer-seeking flow

The planning instinct still applies -- but the plan is *working scaffold*, not an artifact. State it in chat, execute it, discard it. No plan file is written.

### State a brief plan-of-attack, then proceed

Say how the question will be answered, right-sized to it. This is **non-blocking** -- announce the approach and continue immediately. Do not ask the user to approve the plan.

### Execute the plan

Carry out the approach. When the answer depends on facts the model can't reliably supply from memory, gather them using research (decompose into focused questions, dispatch in parallel, collate). Skip research for anything the model already knows well.

**Ground answers about the user's own code, repo, or named artifacts in the actual sources -- not memory.**

### Deliver the answer

Answer in chat. Do **not** write a plan file. If the investigation produced something the user might want to keep, offer to save it; otherwise just give the answer.

### Veil of value: what to surface, what to hide

- **Surface** (question-domain -- reads as value): the approach to the user's actual question.
- **Hide** (skill-domain -- process exhaust): which skill, mode, or phase is running; routing decisions.
- **Never hide** (audit content -- affects trust): caveats, gaps, and uncertainty.

---

## Step 1: Assess Ambiguity and Research Need

**Would 1-3 quick questions meaningfully improve this plan?**

- **Default: ask 1-3 questions** when the answers would change the plan's structure. Always include a final option like "Skip -- just make the plan with reasonable assumptions".
- **Skip questions entirely** only when the request already specifies all major variables.

**Research need -- does this plan depend on facts that change faster than training data?**

| Research need | Signals | Action |
|--------------|---------|--------|
| **None** | Generic, timeless, or conceptual plan | Skip research |
| **Recommended** | Plan references specific locations, venues, dates, prices, schedules, seasonal availability | Research before planning. Decompose into 2-5 focused research questions and dispatch parallel searches. |

## Step 1b: Focused Q&A

Ask up to 3 questions targeting the unknowns that would most change the plan. Present options and wait for the user's reply.

**How to ask well:**
- Offer informed options, not open-ended blanks.
- Use multi-select when several independent choices can be captured in one question.
- Always include a final option like **"Skip -- just make the plan with reasonable assumptions"**.

## Step 2: Structure the Plan

Create a structured plan guided by these quality principles. Do NOT use the software plan template.

### Format: when to prescribe vs. present options

| Task type | Best format |
|-----------|------------|
| **High personal preference** (food, entertainment, activities) | Curated options per category |
| **Logical sequence** (study plan, project timeline, multi-day trip) | Single prescriptive path with clear ordering |
| **Hybrid** (event with fixed structure but variable details) | Fixed structure with choice points marked |

### Quality principles

- **Actionable steps**: Each step is specific enough to execute without further research
- **Sequenced by dependency**: Steps are in the right order, with dependencies noted
- **Time-aware**: When relevant, include timing, durations, deadlines, or phases
- **Resource-identified**: Specify what's needed -- tools, materials, people, budget, locations
- **Contingency-aware**: For important decisions, note alternatives or what to do if plans change
- **Appropriately detailed**: Match detail to task complexity

## Step 3: Save or Share

After structuring the plan, ask the user how they want to receive it.

**Options:**

1. **Save to disk** -- Write the plan as a markdown file. Use filename convention: `YYYY-MM-DD-<descriptive-name>-plan.md`. Start with a `# Title` heading, followed by `Created: YYYY-MM-DD`. No YAML frontmatter.
2. **Done** -- the conversation was the value, no artifact needed.

Do not offer `work` (software-only) for non-software plans.
