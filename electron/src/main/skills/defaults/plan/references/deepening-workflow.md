---
description: Deepening workflow for plan confidence check -- scoring checklists, section-to-agent mapping, execution modes, research synthesis, and plan update instructions.
---

# Deepening Workflow

This file contains the confidence-check execution path (5.3.3-5.3.7). Load it only when the deepening gate at 5.3.2 determines that deepening is warranted.

## 5.3.3 Score Confidence Gaps

Use a checklist-first, risk-weighted scoring pass.

For each section, compute:
- **Trigger count** - number of checklist problems that apply
- **Risk bonus** - add 1 if the topic is high-risk and this section is materially relevant
- **Critical-section bonus** - add 1 for `Key Technical Decisions`, `Implementation Units`, `System-Wide Impact`, `Risks & Dependencies`, or `Open Questions` in `Standard` or `Deep` plans

Treat a section as a candidate if:
- it hits **2+ total points**, or
- it hits **1+ point** in a high-risk domain and the section is materially important

Choose only the top **2-5** sections by score. If deepening a lightweight plan, cap at **1-2** sections.

**Section Checklists:**

**Requirements**
- Requirements are vague or disconnected from implementation units
- Success criteria are missing or not reflected downstream
- Units do not clearly advance the traced requirements

**Context & Research / Sources & References**
- Relevant repo patterns are named but never used in decisions
- High-risk work lacks appropriate external or internal grounding
- Research is generic instead of tied to this repo or this plan

**Key Technical Decisions**
- A decision is stated without rationale
- Rationale does not explain tradeoffs or rejected alternatives
- An obvious design fork exists but the plan never addresses why one path won

**Open Questions**
- Product blockers are hidden as assumptions
- Planning-owned questions are incorrectly deferred to implementation

**Implementation Units**
- Dependency order is unclear or likely wrong
- File paths or test file paths are missing
- Units are too large, too vague, or broken into micro-steps
- Test scenarios are vague or skip applicable categories
- Feature-bearing units have blank or missing test scenarios

**System-Wide Impact**
- Affected interfaces, callbacks, middleware, or parity surfaces are missing
- Failure propagation is underexplored

**Risks & Dependencies**
- Risks are listed without mitigation
- Security, privacy, performance, or data risks are absent where they obviously apply

## 5.3.4 Report and Dispatch Targeted Research

Before dispatching agents, report what sections are being strengthened and why:

```text
Strengthening [section names] -- [brief reason for each]
```

For each selected section, choose the smallest useful agent set. Use at most **1-3 agents per section** and usually no more than **8 agents total**.

**Deterministic Section-to-Agent Mapping:**

**Requirements / Open Questions**
- `repo-research-analyst` for repo-grounded patterns and conventions
- `spec-flow-analyzer` for missing user flows and edge cases

**Context & Research / Sources & References**
- `learnings-researcher` for institutional knowledge
- `framework-docs-researcher` for official framework behavior
- `best-practices-researcher` for external patterns

**Key Technical Decisions**
- `architecture-strategist` for design integrity and architectural tradeoffs

**High-Level Technical Design**
- `architecture-strategist` for validating technical design
- `repo-research-analyst` for grounding in existing patterns

**Implementation Units / Verification**
- `repo-research-analyst` for concrete file targets and patterns
- `pattern-recognition-specialist` for consistency and duplication risks

**System-Wide Impact**
- `architecture-strategist` for cross-boundary effects
- `security-sentinel` for auth, validation, exploit surfaces
- `data-integrity-guardian` for migrations and persistent state safety
- `performance-oracle` for scalability and latency

## 5.3.5 Choose Research Execution Mode

- **Direct mode** - Default. Use when the selected section set is small.
- **Artifact-backed mode** - Use only when the research scope is large enough that inline returns would create unnecessary context pressure.

## 5.3.6 Run Targeted Research

Launch the selected agents in parallel. If parallel dispatch is not supported, run them sequentially.

Prefer local repo and institutional evidence first. Use external research only when the gap cannot be closed from repo context.

## 5.3.6b Interactive Finding Review (Interactive Mode Only)

Skip in auto mode. In interactive mode, present each agent's findings to the user before integration. For each agent:

1. Summarize the agent and its target section
2. Present the findings concisely
3. Ask the user: **Accept** / **Reject** / **Discuss**

## 5.3.7 Synthesize and Update the Plan

Strengthen only the selected sections. Keep the plan coherent.

Deepening may tighten, not only grow. A section can be strengthened by cutting as well as adding.

Allowed changes:
- Tighten prose: cut hedges, split multi-idea sentences
- Clarify or strengthen decision rationale
- Tighten requirements trace or origin fidelity
- Reorder or split implementation units (but **never renumber existing U-IDs**)
- Add missing pattern references, file/test paths, or verification outcomes
- Expand system-wide impact, risks, or rollout treatment
- Add or update `deepened: YYYY-MM-DD` in frontmatter

Do **not**:
- Add implementation code
- Add git commands or commit choreography
- Rewrite the entire plan from scratch
- Renumber existing U-IDs
