---
title: "feat: Session tabs as pinned working set"
type: feat
status: completed
date: 2026-07-15
origin: docs/brainstorms/2026-07-15-session-tabs-requirements.md
---

# feat: Session tabs as pinned working set

## Summary

Add a top session tab bar backed by a main-owned durable open-set (ordered session IDs + last focus + MRU). Selecting a session open-or-focuses a tab; tabs stay when idle; close never stops the agent (confirm when live). Restore into the primary window beats cold-start auto-select. Sidebar library and Activity stay as today.

---

## Problem Frame

Parallel multi-project work already runs concurrently (session-keyed agents; window-keyed selection), but the UI only surfaces a single focused session plus an Activity list that drops finished work. Users lack a durable “open set” that survives idle state and restart. Product rules are fixed in the origin requirements doc (see origin).

---

## Requirements

Trace to origin `docs/brainstorms/2026-07-15-session-tabs-requirements.md`:

- R1–R5, R16, R18–R19 — tab bar, open-on-select, close ≠ delete/stop, library stays, MRU focus, live delete drops tab, empty → draft
- R6–R7 — Activity kept; non-tab working/waiting/attention/unread via Activity
- R8–R9 — conditional multi-project labels; status on open tabs + mark-seen rules
- R10–R11, R17 — primary-window restore; drop missing; no draft restore; supersede auto-select
- R12–R14 — single draft slot (replace project + clear unsent); horizontal overflow
- R15 — single center pane
- R4 close UX — close control, middle-click, Cmd/Ctrl+W; confirm when live

**Origin flows:** F1–F4  
**Origin acceptance examples:** AE1–AE10  

---

## Scope Boundaries

- Do not remove Activity or the project-grouped session library
- No split-pane multi-session view
- No auto-open tab for every background job
- No multi-window tab-set restore (primary window only)
- No drag-reorder, tab groups, vertical tabs, auto-cap/eviction
- No change to session JSON schema beyond separate UI working-set persistence

### Deferred to Follow-Up Work

- Per-window independent tab-set persistence
- Soft tab caps / LRU eviction
- SessionHeader slim-vs-keep layout polish (pixel-level)
- Off-screen overflow attention chevron cues beyond auto-scroll-into-view

---

## Context & Research

### Relevant Code and Patterns

- Shell / select path: `electron/src/renderer/components/ChatView.tsx` (`handleSessionSelect`, cold-start auto-select, delete fallback to `remaining[0]`, Cmd+1–9)
- Library + Activity: `electron/src/renderer/components/LeftSidebar.tsx`, `session-activity-section.tsx`
- Center identity: `electron/src/renderer/components/session-header.tsx`
- Hooks: `electron/src/renderer/hooks/useSession.ts`, `useSessionActivity.ts`, `useChat.ts`
- Main session: `electron/src/main/session/manager.ts` (`_selectedByOwner`, `switchTo`), `activity.ts`, `storage.ts`
- IPC: `electron/src/main/ipc/session.ts`, `session-activity.ts`; channels in `electron/src/shared/types/ipc.ts`; preload `electron/src/preload/index.ts`
- Workspace/draft: `electron/src/main/project/workspace.ts`
- Shortcuts: `electron/src/renderer/keyboard/registry.ts`, `useGlobalShortcuts.ts`
- Concurrent model (selected ≠ working): `docs/handoffs/2026-07-11-concurrent-session-workspaces.md`
- Tests: `electron/tests/unit/session-persistence.test.ts`, `session-activity.test.ts`, `session-workspace-ipc.test.ts`, `keyboard-registry.test.ts`; integration `chat-sidebar.test.ts`, `app-shell.test.ts`

### Institutional Learnings

- No formal `docs/solutions/` entry for this domain; rely on concurrent-session handoff + activity tombstone/prune patterns from concurrent-session review reports
- Selection is navigation only — never cancel agents on switch/close tab

### External References

- None — strong local patterns for IPC, selection, and activity

---

## Key Technical Decisions

- **Main-owned durable working set:** Persist ordered open session IDs, last focused ID, and MRU stack in a small main-process store (e.g. `~/.orchid/ui-state.json` or sibling module under `session/`), not renderer `localStorage` and not inside session JSON files. Matches durable product state living under `~/.orchid/` and lets delete/list validation stay authoritative.
- **IPC for open-set mutations:** Expose get + mutators (open-or-focus, close-tab, replace set on restore apply) validated with Zod; renderer mirrors for UI. Prefer explicit tab operations over overloading `session:load` alone so close-without-focus-change is clear.
- **Select path remains the open-or-focus entry:** All of sidebar, Activity, shortcuts, and tab clicks call the same ChatView select pipeline after updating open-set membership.
- **Replace cold-start auto-select:** On first ready list, apply restored open set (filter missing IDs); load last focus if present; else empty/draft (R17/R19). Never auto-pick library `[0]` when a working set exists or is empty by design.
- **Delete / close focus:** On session delete or focused-tab close, apply MRU among remaining open tabs (R16/R18); remove today’s “open `remaining[0]` from library” behavior for active delete.
- **Cmd/Ctrl+1–9 target open tab order**, not full library order.
- **Cmd/Ctrl+W** new shortcut closes focused tab with live confirm (R4).
- **Activity badges on tabs:** Join `useSessionActivity` by session id for open tabs only; markSeen parity already in ChatView.
- **Draft:** Keep existing draft cwd + null activeSession; one draft tab UI; New Chat for another project replaces binding and clears unsent text (R12); drafts not in durable set.

---

## Open Questions

### Resolved During Planning

- **Where does open-set live?** Main-owned durable file + IPC (see Key Technical Decisions).
- **Primary window restore only?** Yes (origin R10); single restored set applied to primary window on launch.
- **Cmd+1–9 semantics after tabs?** Open tab index, not library index.
- **Focus after close?** MRU among remaining open tabs (origin R16).

### Deferred to Implementation

- Exact confirm dialog copy and DaisyUI modal vs browser `confirm` for live close
- Whether hover-reveal vs always-visible close X is denser for many tabs (pixel)
- Atomic write details for ui-state file (follow session storage fsync/rename pattern if reused)
- Whether working-set IPC is a nested `session:working_set_*` family or a single channel with action enum

---

## High-Level Technical Design

> *Directional guidance for review, not implementation specification.*

```text
┌─────────────┐     open/close/restore      ┌──────────────────┐
│  Tab bar UI │ ──────────────────────────► │ WorkingSetStore  │
│  (renderer) │ ◄─── snapshot / events ──── │ (main, durable)  │
└──────┬──────┘                             └────────┬─────────┘
       │ select / close focused                      │
       ▼                                             ▼
┌─────────────┐   session:load activate    ┌──────────────────┐
│  ChatView   │ ─────────────────────────► │ SessionManager   │
│  useSession │ ◄── Session + workspace ── │ _selectedByOwner │
└──────┬──────┘                             └──────────────────┘
       │ status join
       ▼
┌─────────────┐
│ Activity    │  (process-wide; non-tab rediscovery)
└─────────────┘
```

**Open-set operations (conceptual):**

| Op | Effect |
|----|--------|
| openOrFocus(id) | If missing, append id; set focus; update MRU; persist; activate session for window |
| closeTab(id) | Remove id; if was focus → MRU remaining or draft; persist; do not forceStop |
| removeSession(id) | Same as close for set membership when session deleted |
| restore() | Load disk; filter to existing session ids; activate last focus if any |

---

## Implementation Units

- U1. **Working-set store + IPC (main)**

**Goal:** Durable ordered open IDs, last focus, MRU; Zod IPC; filter missing sessions on read.

**Requirements:** R10, R11, R17 (storage half), R2 order, R16 MRU data

**Dependencies:** None

**Files:**
- Create: `electron/src/main/session/working-set.ts` (or `ui-state.ts` colocated)
- Modify: `electron/src/main/ipc/session.ts` (or new `working-set.ts` IPC module registered from index)
- Modify: `electron/src/shared/types/ipc.ts`, `electron/src/preload/index.ts`
- Test: `electron/tests/unit/session-working-set.test.ts`, `electron/tests/unit/session-working-set-ipc.test.ts`

**Approach:**
- Pure store API: get snapshot; openOrFocus; close; remove; setFocus; clear; load/save
- Persist JSON under `~/.orchid/` with atomic write pattern consistent with session storage
- On load, intersect open IDs with `listSavedSessions` / manager list
- Do not stop agents on close/remove-from-set

**Patterns to follow:**
- `electron/src/main/session/activity.ts` (in-memory + clear API)
- `electron/src/main/session/storage.ts` (atomic write)
- `electron/src/main/ipc/session-activity.ts` (IPC + Zod)

**Test scenarios:**
- Happy path: open three ids → order append; focus last; persist reload restores order + focus
- Edge: open existing id only focuses, does not duplicate
- Edge: close non-focus leaves focus unchanged; close focus applies MRU of remaining
- Edge: remove missing id is no-op; restore drops deleted ids quietly
- Error: invalid IPC payload rejected by Zod
- Integration: close does not call forceStop / does not delete session file

**Verification:** Unit tests pass; channels allowlisted; no session JSON schema change.

---

- U2. **Wire select / delete / draft into working set (main + hooks)**

**Goal:** Every session activation updates open-set; delete drops tab + MRU; draft stays non-durable.

**Requirements:** R2, R4 (no stop), R12–R13, R16–R18

**Dependencies:** U1

**Files:**
- Modify: `electron/src/main/ipc/session.ts` (`load` activate path, `delete`, `clear_active`)
- Modify: `electron/src/renderer/hooks/useSession.ts`
- Create or modify: `electron/src/renderer/hooks/useSessionTabs.ts` (preferred thin mirror)
- Test: extend `electron/tests/unit/session-workspace-ipc.test.ts` or working-set IPC tests

**Approach:**
- On `session:load` with activate: openOrFocus(id) for that window’s primary working set
- On delete: remove id from set; if was focused, return next focus id (MRU) to renderer contract or let renderer re-query snapshot
- clear_active / draft: clear focus in set but do not persist a draft id
- Renderer hook exposes `openTabs`, `focusedId`, `openOrFocus`, `closeTab`, `restoreSnapshot`

**Patterns to follow:**
- `useSession.ts` load generation guards
- Concurrent handoff: selection ≠ work ownership

**Test scenarios:**
- Happy path: load session A then B → open set [A,B], focus B
- Happy path: delete focused B with A in set → focus A, B gone from set
- Edge: delete non-open session leaves set unchanged
- Edge: clear_active does not leave a durable “draft” id on disk
- Integration: switch session does not cancel other session’s agent (existing guarantee preserved)

**Verification:** IPC tests cover open-set side effects of load/delete; draft not in persisted file.

---

- U3. **Session tab bar UI + labels + status**

**Goal:** Top tab bar above center chat; labels; status dots; close control; multi-project conditional labels; horizontal scroll; auto-scroll focused into view.

**Requirements:** R1, R3, R8, R9, R14, R15 (placement)

**Dependencies:** U1, U2 (can stub snapshot for pure UI tests)

**Files:**
- Create: `electron/src/renderer/components/SessionTabBar.tsx`
- Modify: `electron/src/renderer/components/ChatView.tsx` (layout mount)
- Modify: `electron/src/renderer/styles/chat.css` or Tailwind classes as used by shell
- Test: `electron/tests/unit/session-tab-bar.test.ts` and/or integration `electron/tests/integration/session-tabs.test.ts`

**Approach:**
- Render open session tabs from summaries join + optional draft tab
- Active vs inactive chrome; status from activity map (working/waiting/needs_attention/unread)
- Label: session name; if ≥2 distinct project basenames in open set (incl. draft binding if shown), prefix project basename
- Close control on each tab; middle-click closes; wire to close handler (confirm owned by U4)
- Overflow: horizontal scroll; focusing a tab scrolls it into view
- Keep SessionHeader for path identity in v1 (no slim required)

**Patterns to follow:**
- `session-activity-section.tsx` status classes
- DaisyUI + existing chat layout grid

**Test scenarios:**
- Happy path: two open tabs show titles; active tab marked
- Happy path: multi-project open set shows project + name; single-project set shows name only
- Edge: unread cleared when tab focused (via existing markSeen path — assert hook call)
- Edge: many tabs container is horizontally scrollable / focused tab brought into view
- Integration: clicking tab invokes openOrFocus/load path (mocked orchid)

**Verification:** Tab bar visible in shell; Activity section still present in LeftSidebar.

---

- U4. **Close confirm, shortcuts, empty/draft, startup restore**

**Goal:** Product close rules, Cmd+W, retarget Cmd+1–9, replace auto-select, empty working set, draft reuse across projects.

**Requirements:** R4, R12, R16, R17, R19; AE2, AE4, AE5, AE7, AE9

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `electron/src/renderer/components/ChatView.tsx` (remove/replace didAutoSelect; delete handler; draft New Chat; shortcut handlers)
- Modify: `electron/src/renderer/keyboard/registry.ts` (+ tests)
- Modify: confirm UI component (inline modal or small `CloseTabConfirm.tsx`)
- Test: `electron/tests/unit/keyboard-registry.test.ts`; integration session-tabs / ChatView tests

**Approach:**
- Startup: after list ready + working set loaded → restore open ids (already filtered) + load focused; if none → enterDraft / empty (R19); never library auto-select when restore path runs
- Close tab: if activity state in working|waiting|needs_attention → confirm (keep running + close vs cancel); idle → close immediately
- Cmd/Ctrl+W → close focused tab (same path)
- Cmd/Ctrl+1–9 → openTabs[n-1]
- New Chat / project New Chat: single draft slot; different project replaces cwd binding and clears unsent composer text
- Closing last session tab → draft tab only

**Patterns to follow:**
- Existing `session.switch.*` handler wiring in ChatView
- Toast/notify patterns for non-blocking feedback (confirm is blocking)

**Test scenarios:**
- Covers AE4 / R17: restored focus wins over most-recent library session
- Covers AE9 / R19: close last tab → draft, not library[0]
- Covers AE2 / R4: close while working shows confirm; after confirm agent not stopped (mock)
- Covers AE7 / R16: close focused applies MRU
- Covers AE5 / R12: second New Chat reuses draft; cross-project New Chat clears unsent
- Happy path: Cmd+2 focuses second open tab
- Edge: Cmd+W with no session tabs is no-op or focuses draft only

**Verification:** Manual smoke: multi-project open, restart, close live with confirm, delete session with open tab.

---

## System-Wide Impact

- **Interaction graph:** ChatView select, LeftSidebar, Activity, keyboard registry, session load/delete IPC, optional config/theme-adjacent ui-state file
- **Error propagation:** Missing session ids drop quietly; IPC validation errors should not brick startup (fall back to empty set)
- **State lifecycle risks:** Ghost tabs if delete does not remove from set; stuck focus if MRU empty not handled; race between restore and list ready (gate on both)
- **API surface parity:** Preload + allowlists for new channels; ShortcutsHelp label updates for Cmd+W and “switch to tab N”
- **Integration coverage:** Restore vs auto-select; delete-with-open-tab; live close confirm; multi-project labels
- **Unchanged invariants:** Agents remain session-keyed; Activity process-wide; session files schema unchanged; single center pane

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Cold-start race (list vs working-set load) | Single bootstrap gate: both ready before choosing restore vs draft |
| Tab sprawl from open-on-select | Accepted v1 (origin); scroll only |
| Dual status surfaces confuse users | Reuse Activity state vocabulary; markSeen shared |
| Confirm on every live close feels heavy | Only working/waiting/needs_attention; idle free |
| Multi-window users open second window | v1: restore primary only; second window empty set |

---

## Documentation / Operational Notes

- Update shortcuts help entries for tab switch + close
- No user migration beyond writing new ui-state file on first use
- Consider `/ce-compound` after ship for working-set vs Activity split

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-15-session-tabs-requirements.md](../brainstorms/2026-07-15-session-tabs-requirements.md)
- Related handoff: [docs/handoffs/2026-07-11-concurrent-session-workspaces.md](../handoffs/2026-07-11-concurrent-session-workspaces.md)
- Related code: `electron/src/renderer/components/ChatView.tsx`, `electron/src/main/session/manager.ts`, `electron/src/main/session/activity.ts`
- Conventions: `electron/CLAUDE.md`
