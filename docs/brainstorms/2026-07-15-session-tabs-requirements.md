---
date: 2026-07-15
topic: session-tabs
---

# Session Tabs (Pinned Working Set)

## Summary

Add a top session tab bar as a durable, user-owned working set across projects. Selecting a session opens it as a tab that stays open until closed (including after the agent goes idle). The sidebar session library and Activity section remain; tabs do not replace them.

---

## Problem Frame

Orchid already supports many sessions across many projects, and agents can keep working while the user focuses elsewhere. The left sidebar lists sessions by project, and an Activity section surfaces live or unread work. The center pane still shows only one session at a time.

Activity is a poor stand-in for a working set: when a session finishes (or goes idle), it drops out of Activity even if the user still intends to return to it. Users end up hunting finished-but-relevant sessions in the project list, or relying on mental notes about which chats matter right now. Parallel multi-project work makes this worse—there is no stable “open set” that spans projects and survives idle state and app restarts.

---

## Key Flows

- F1. Open and switch via tabs
  - **Trigger:** User selects a session from the sidebar (or existing session-switch shortcuts)
  - **Steps:** Session opens or focuses as a tab; center pane shows that session; tab remains after work finishes
  - **Outcome:** User can jump among open sessions without re-finding them in the library
  - **Covered by:** R1, R2, R3, R15

- F2. Close a tab while work continues
  - **Trigger:** User closes a tab whose session is still working
  - **Steps:** Confirm close (keep agent running); on confirm, tab leaves the bar; agent keeps running; session remains in the library; Activity still shows live work; if the closed tab was focused, center focus moves per R16
  - **Outcome:** Work is not cancelled by closing a tab; user can re-open from Activity or the sidebar while still live; once idle, rediscovery is via the library
  - **Covered by:** R4, R5, R6, R7, R16

- F3. Restore working set after restart
  - **Trigger:** App launches after a previous run with open tabs
  - **Steps:** Prior open tab set and last focused tab are restored (superseding cold-start auto-select); missing sessions are dropped quietly
  - **Outcome:** The user’s working set is durable across restarts
  - **Covered by:** R10, R11, R17

- F4. New chat draft
  - **Trigger:** User starts New Chat (global or project-scoped)
  - **Steps:** At most one draft tab is shown/reused; after first message creates a session, the draft slot becomes that session’s tab
  - **Outcome:** Drafts don’t multiply empty tabs; real sessions join the working set normally
  - **Covered by:** R12, R13

---

## Requirements

**Tab bar and working set**
- R1. A session tab bar appears at the top of the main interface (above the center chat pane).
- R2. Selecting any session (sidebar click or existing session-switch shortcuts) opens that session as a tab if it is not already open, and focuses it if it is. Newly opened sessions append to the end of the tab bar; open order is persisted and restored with the working set. No drag-reorder in v1.
- R3. An open tab remains in the bar until the user closes it, including when the session is idle or finished.
- R4. Closing a tab removes it only from the working set; it does not delete the session and does not stop an in-flight agent. Each tab has an explicit close control; middle-click on a tab closes it; Cmd/Ctrl+W closes the focused tab. Closing never stops the agent. Closing a tab whose session is working, waiting, or needs attention requires a confirm step (close tab and keep running vs cancel the close); idle tabs close without confirm.
- R5. The left sidebar project-grouped session library remains the full session browser; tabs are a working set, not a replacement for the list.
- R16. Closing a non-focused tab does not change center focus. Closing the focused tab focuses the most recently focused remaining tab (MRU among remaining open tabs). Closing the last session tab enters the empty working-set state (R19).
- R18. If a session in the open set is deleted (or otherwise disappears while the app is running), remove its tab quietly (same as R11). If it was focused, apply R16. Never leave a ghost tab.

**Activity (kept)**
- R6. The sidebar Activity section remains and continues to surface live/unread/background work process-wide, including for sessions that are not open as tabs.
- R7. When a closed or non-tab session is working, waiting, needs attention, or unread, the user can still discover and open it via Activity (or the sidebar list). Activity—not the tab bar—is the sole surface for those states on sessions that are not open as tabs.

**Labels, status, multi-project**
- R8. Tab labels show the session name by default. When the open tabs span more than one project, each tab also shows the project identity (folder basename) with the session name.
- R9. Open tabs show execution status affordances for that session (working, waiting, needs attention, unread) so the user can scan the working set without relying only on Activity. Focusing a tab clears that session’s unread (same mark-seen semantics as today when the session is active). needs_attention remains until the underlying condition clears, even on the focused tab. working and waiting show on focused and unfocused tabs alike. Idle with no unread shows no attention badge.

**Persistence**
- R10. The open tab set and the last focused tab restore on app restart into the primary (main) window. v1 assumes single-window restore; multi-window independent tab sets are not required.
- R11. On restore, sessions that no longer exist are omitted from the tab set without error noise.
- R17. On app start, restored open tabs and last focus take precedence over any cold-start auto-select of the most recent library session. If no valid session remains to restore, enter the empty working-set state (R19). Only real session IDs are persisted; an open draft tab is not restored across restart.

**Drafts and overflow**
- R12. There is at most one New Chat draft tab at a time; starting another draft reuses that slot rather than stacking empty tabs. When New Chat is invoked for a different project than the current draft, the draft’s project binding is replaced and any unsent draft text is discarded (no confirm).
- R13. Once the draft becomes a real session (first message / session creation), that session occupies a normal session tab in the working set.
- R14. When tabs exceed available width, the bar scrolls horizontally (chevrons or equivalent as needed); overflow is not limited to a dropdown-only model for v1.

**Focus model**
- R15. The center pane continues to show exactly one focused session (or draft) at a time; selecting a tab switches focus and loads that conversation in the center pane.
- R19. Empty working set: with zero session tabs, show a single draft tab (R12); the tab bar remains visible. Do not auto-open sessions from the library into tabs. Cold start with nothing to restore uses the same empty/draft state.

---

## Acceptance Examples

- AE1. **Covers R2, R3, R9.** Given session A is selected and working, when the agent finishes and becomes idle, A’s tab remains open and its status affordance reflects idle/unread as appropriate.
- AE2. **Covers R4, R6, R7.** Given session B is open as a tab and still working, when the user attempts to close B’s tab, a confirm is shown; after confirm, B is no longer in the tab bar, the agent continues, and Activity still lists B until work ends; selecting B from Activity reopens a tab for B.
- AE7. **Covers R16.** Given tabs A (focused), B, C in MRU order A→B→C, when the user closes A, focus moves to B; when the user later closes a non-focused tab, focus stays on the current focused tab.
- AE8. **Covers R18.** Given session D is open as a tab (focused or not), when the user deletes D from the library, D’s tab disappears immediately without a blocking error; if D was focused, focus follows R16.
- AE9. **Covers R19.** Given one open session tab, when the user closes it, the bar shows a single New Chat draft tab and does not auto-select another library session.
- AE10. **Covers R7.** Given a session is not open as a tab and reaches needs_attention or unread, it appears in Activity; selecting it opens a tab with matching status affordance.
- AE3. **Covers R8.** Given open tabs only for project `orchid`, when the user opens a session from project `other-app`, tab labels begin showing project + session name for the open set.
- AE4. **Covers R10, R11, R17.** Given three open tabs and last focus on tab 2, when the app restarts, those three tabs restore with tab 2 focused (not the library’s most-recent session); if one session file was deleted, the remaining two restore without a blocking error. Given a prior run with only a draft open, restart does not restore a draft tab.
- AE5. **Covers R12, R13.** Given a New Chat draft tab is open, when the user starts New Chat again, the same draft tab is reused; after the first send creates a session, that session appears as a normal tab (not a permanent “untitled” draft alongside it). Given a draft bound to project A with unsent text, when the user starts New Chat for project B, the draft rebinds to B and the unsent text is cleared.
- AE6. **Covers R5, R6.** Given the tab bar is in use, the left session library and Activity section remain available and functional as before for browsing and live work.

---

## Success Criteria

- Users can keep a multi-project set of sessions open and switch among them without depending on Activity or re-scanning the full library after work finishes.
- Closing tabs never accidentally kills agent work; live work remains discoverable via Activity.
- After restart, the prior working set (and last focus) comes back so parallel work is not lost to a cold single-session default.
- A planner can implement without inventing product rules for open/close, status placement, draft uniqueness, multi-project labels, or restore behavior.

---

## Scope Boundaries

- Do not remove or replace the sidebar Activity section or the project-grouped session library.
- No split-pane / multi-session side-by-side view in one window.
- No auto-opening a tab for every background job without user select (Activity covers non-tab live work).
- No required multi-window tab-set product: v1 restores the working set into the primary window only; additional windows are out of scope for tab restore.
- No tab reordering, tab groups, vertical tabs, or browser-style history model in v1.
- No automatic tab cap or eviction in v1; working-set growth from open-on-select is accepted.
- No change to session persistence format beyond what is needed to remember the open working set and last focus.

---

## Key Decisions

- **Pinned working set, not live-only tabs:** Tabs stay when idle so finished-but-relevant sessions remain one click away.
- **Activity stays:** Tabs are additive. Closing a live tab confirms first so users know rediscovery will rely on Activity while live, then the library once idle; status on tabs covers the open set only.
- **Open on any select:** Any session focus from the library or shortcuts joins the working set—no separate pin action for v1. No auto-cap or auto-eviction in v1; the user owns close; horizontal scroll handles overflow (R14).
- **Conditional project labels:** Project name on tabs only when the open set spans multiple projects, reducing noise for single-project days.
- **Durable restore:** Working set survives restart into the primary window; missing sessions drop quietly; drafts do not restore.
- **Single draft slot + horizontal scroll:** Avoid draft tab sprawl; keep overflow simple for v1.
- **Single center pane:** Tabs switch focus; they do not introduce multi-pane chat.
- **MRU focus after close:** Closing the focused tab focuses the most recently focused remaining tab, not a spatial neighbor.

---

## Dependencies / Assumptions

- Existing session model already supports multi-session, multi-project (`cwd`), and process-wide Activity; this feature is primarily presentation and working-set state.
- Session select / switch shortcuts that exist today should open-or-focus tabs consistently with sidebar select.
- Restore assumes session IDs remain stable across restarts for sessions that still exist on disk.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R9][Technical] Exact status visual language on tabs relative to existing Activity and sidebar row indicators (consistency without clutter).
- [Affects R14][Technical] Scroll vs chevron control details and keyboard navigation within the tab bar.
- [Affects R4][Technical] Confirm-dialog copy and whether middle-click / Cmd+W share the same confirm for live tabs.
- [Affects R12][Technical] Draft tab label copy (“New chat” ± project) and SessionHeader keep-vs-slim layout once the tab bar lands.
