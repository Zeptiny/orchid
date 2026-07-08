# Deferred Features — Todo for Later Implementation

Features deferred from the initial TS/Electron migration plan. Implement after engine parity is declared.

---

## R22. Annotated Diff Code Review

**Status:** Deferred from Phase 1
**Priority:** Medium — differentiating feature, but not required for parity
**Estimated effort:** 2-3 days

### What it is
When the code-review skill runs (6+ parallel reviewer subagents), results render as a navigable annotated diff view instead of a consolidated text report.

### Key features
- Monaco diff view with finding markers in the gutter
- Each finding is a marker on the exact line(s) it references
- Color-coded by reviewer persona:
  - correctness = blue
  - security = red
  - performance = yellow
  - maintainability = green
  - testing = purple
  - adversarial = orange
- Filterable by severity (P0, P1, P2, P3) and by persona
- Reasoning on hover (tooltip/popover)
- Navigation: click a finding in the findings panel → diff scrolls to that line
- Replaces the consolidated text report from the Python TUI

### Implementation sketch
- `electron/src/renderer/components/AnnotatedDiff/AnnotatedDiffView.tsx` — main view
- `electron/src/renderer/components/AnnotatedDiff/FindingMarker.tsx` — gutter marker component
- `electron/src/renderer/components/AnnotatedDiff/PersonaFilter.tsx` — persona filter checkboxes
- `electron/src/renderer/components/AnnotatedDiff/SeverityFilter.tsx` — severity filter
- `electron/src/renderer/components/AnnotatedDiff/ReasoningPopover.tsx` — hover tooltip
- Uses Monaco editor markers API for line-level annotations
- Findings data comes from code-review skill output (JSON format with file, line, title, severity, confidence, reasoning)

### Dependencies
- U6 (agent/skill loading — code-review skill must be ported)
- U10 (XState actors — subagent spawning for reviewers)
- U19 (Electron app shell)
- U20 (chat + sidebar — for rendering context)
- U22 (native tool widgets — Monaco diff widget can be reused)

### Test scenarios
- Code review with 10 findings → diff view with 10 markers at correct lines
- Colors match persona assignments
- Filter by severity → only matching markers shown
- Filter by persona → only matching markers shown
- Hover over marker → reasoning tooltip appears
- Click finding in panel → diff scrolls to marked line
- Empty review → placeholder message

---

## R19. Agent Graph as Primary Interface

**Status:** Deferred indefinitely
**Priority:** Low — interface will change significantly before this can be added

The agent hierarchy renders as a live node graph (react-flow or equivalent) where each node represents an agent showing status, tier, active tool, and token spend. Edges show delegation and context flow. This replaces the sidebar as the primary interface.

---

## R20. Diff-Gated Approval / Permission System

**Status:** Deferred
**Priority:** High — security feature, but requires holistic design

Any `edit`, `write`, or `execute_command` tool call renders a diff-gated approval panel showing the target, exact diff or command, predicted side effects, and rollback plan. The user can approve granularly (per-file, per-command) with three modes: always-prompt, yolo (auto-approve), decide-for-me.

### Interim measures (until R20 ships)
- Path sandboxing: restrict file operations to project directory (documented as known gap)
- SSRF protections: block private IPs, localhost, metadata endpoints in web_fetch
- MCP trust model: servers considered trusted (user-installed)
- Session file encryption: evaluate safeStorage for session data at rest
