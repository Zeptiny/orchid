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

---

## R-issue-112. SSH Remote Machines — Follow-ups

**Status:** Deferred from 2026-08-23-001 (shipped as units U1–U11)
**Priority:** varies per item — see each entry
Follow-up work from the SSH remote-machines feature (`electron/docs/remote-machines.md`). The v1 scope shipped with the pre-installed CLI, key-only auth, per-host data, and Linux/macOS remotes; these entries cover what that scope deliberately left out.

### a. Auto-provisioning the agent onto remotes
**Status:** Deferred (user decision at scoping)
**Priority:** Medium — removes the largest manual step in onboarding
Detect a missing `orchid-agent` on a remote, push a bundled copy (or package install), and manage its updates over SSH. **Why deferred:** v1 requires the binary pre-installed; pushing executables onto remote hosts needs its own trust/install story (which package, which checksum, which update channel) that overlaps the packaging open question below.

### b. Password / askpass SSH auth
**Status:** Deferred
**Priority:** Low — key/agent auth covers the primary workflow
Support password or SSH-askpass prompts instead of `BatchMode=yes` key-only auth. **Why deferred:** interactive prompts across the machine connection lifecycle (including automatic reconnects with no user present) need a credential-capture and storage design; v1 fails closed with an actionable `auth-failed` hint instead.

### c. Cross-machine analytics aggregation
**Status:** Deferred
**Priority:** Low — each host's ledger remains authoritative
Aggregate AnalyticsView across hosts (per-machine and combined cost/usage views). **Why deferred:** the attempt ledger is host-local by design (no cross-machine replication); aggregation requires either a pull/merge read-model or federated queries, neither of which the offline-continuation requirement shaped in v1.

### d. Remote file browser / remote workspace tree
**Status:** Deferred
**Priority:** Medium — quality-of-life for remote workspaces
A file browser or workspace tree for remote machines (the native folder picker is disabled for remotes; workspace binding is a typed path). **Why deferred:** needs a host-method surface for listing/browsing the remote filesystem plus renderer UI, none of which the v1 typed-path binding required; also expands the host's readable-surface security story.

### e. Windows remotes validation
**Status:** Deferred — untested, not known-broken
**Priority:** Low-Medium
Validate the daemon (socket paths, detached spawn, native modules on Windows Node) against Windows remotes. **Why deferred:** Linux/macOS remotes are the v1 matrix; Windows adds an OpenSSH/daemon-detach/native-rebuild matrix nobody has run, and shipping it unvalidated would be worse than deferring.

### f. npm packaging + versioning of the orchid-agent binary
**Status:** Open question from the plan — packaging story unresolved
**Priority:** High for any remote onboarding beyond source checkouts
Name, publish, and version an npm package (or bundled artifact) for the `orchid-agent` CLI, versioned against the desktop app and the host protocol version. **Why deferred:** the distribution channel, protocol-version coupling, and remote native-dependency install story (`scripts/ensure-native-runtime.mjs` precedent) are release-engineering decisions, not code; today the supported path is building the agent from the repository.

### g. Multiple concurrent GUI clients on one host — richer ownership semantics
**Status:** Deferred — v1 routes to the requesting client
**Priority:** Medium once multi-client use is common
Today approvals/questions route to the client that requested the work; other connected clients see read-only pending state (and a reconnecting client adopts orphaned pendings). **Why deferred:** richer semantics (any-client answering, presence/claim arbitration, per-client view state) need protocol and UX design; v1's ownership already satisfies the single-user reconnect flows that drove the feature.

### h. AGENTS.md directory-tree docs pass for machines/ + host/
**Status:** Deferred — codebase doc is stale
**Priority:** Low — docs-only
The repository AGENTS.md directory tree still omits the new `src/main/machines/` tree and the host entries added after U3 (`host/server.ts`, `host/daemon.ts`, `host/client.ts`, `host/transport-inprocess.ts`, `host/local-host.ts`, `host/routing.ts`, `shared/host/protocol.ts` + `framing.ts`, `agent-entry.ts`). **Why deferred:** a mechanical docs pass, batched with the next AGENTS.md refresh rather than landing piecemeal; the per-module header comments are accurate in the meantime.
