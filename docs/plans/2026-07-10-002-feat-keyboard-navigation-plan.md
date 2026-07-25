---
title: "feat: Full keyboard navigation foundation for Electron UI"
type: feat
status: implemented
date: 2026-07-10
---

# feat: Full keyboard navigation foundation for Electron UI

## Summary

Make the Electron chat shell keyboard-complete for primary workflows by introducing a single shortcut registry, real modal focus traps with focus restore, session-list arrow navigation, left-rail toggle, and an in-app Shortcuts help surface. Wire the chat footer (and related hints) from the same registry so discovery cannot drift from handlers.

## Problem Frame

Keyboard support today is fragmented: `keydown` listeners live in `ChatView`, `Sidebar`, `InputArea`, `ConfigView`, `CommandPalette`, etc. The footer advertises only three shortcuts; `Mod+,` and `Mod+1–9` work but are undiscoverable. Focus traps on Preferences/Onboarding only set initial focus (no Tab cycle). The left session list and inspector have no listbox-style navigation. Closing the palette does not reliably restore composer focus.

## Goals / Non-Goals

### Goals

- G1. Single source of truth for global shortcuts (match + labels + grouping).
- G2. Real focus trap + focus restore for Command Palette, ConfigView, Onboarding (and Preferences if opened).
- G3. Session list: ↑/↓, Enter to open, optional Delete to remove (with existing delete path).
- G4. Toggle left sessions rail via shortcut; keep `Mod+B` for right inspector.
- G5. Shortcuts help modal (`Mod+/`) listing all registered bindings.
- G6. Footer idle hints driven by registry (not hard-coded strings).
- G7. Unit tests for match helpers and registry completeness; no commit (per request).

### Non-Goals / Deferred

- Chat stream message-by-message navigator (follow-up).
- Electron application menu accelerators (follow-up).
- F6 region cycling across all panes (follow-up; optional light “focus sessions / composer” commands only if cheap).
- Full ARIA live-region audit / screen-reader certification.
- Python TUI parity.
- Changing staged Esc interrupt semantics.

## Requirements

- R1. Registry module exports shortcut defs: `id`, `keys` (Mod-aware), `label`, `group`, optional `when`.
- R2. `Mod` matches Ctrl on Linux/Windows and Meta (Cmd) on macOS (and accept both where already true today).
- R3. Global handlers install once per surface via a shared hook; components register actions by id.
- R4. Shortcuts that type text (e.g. bare letters) must not fire when focus is in an editable field unless explicitly allowed (`allowInEditable`).
- R5. `Mod+K`, `Mod+N`, `Mod+B`, `Mod+,`, `Mod+1–9` keep current behavior; add `Mod+\` (or `Mod+Shift+B`) for left rail; `Mod+/` for help.
- R6. Focus trap: Tab/Shift+Tab cycle within dialog root; Esc handled by existing close paths; on open focus first focusable (or designated target); on close restore previously focused element.
- R7. Session rows form a keyboard list: one tab stop (or container focus), arrows move active option, Enter selects, focus follows selection visually.
- R8. Footer shows registry labels for: palette, inspector, new session (idle); help remains via `Mod+/` not necessarily footer-crowded.
- R9. Help modal lists all shortcuts by group; Esc / click outside / `Mod+/` again closes; trap focus.
- R10. No git commit from this workstream.

## Scope Boundaries

### In scope

| Area | Work |
|------|------|
| `electron/src/renderer/keyboard/*` | New modules |
| `ChatView`, `Footer`, `LeftSidebar`, `Sidebar`, `CommandPalette`, `ConfigView`, `OnboardingScreen` | Wire registry / traps / help |
| `PreferencesWindow` | Focus trap upgrade if still in tree (low risk) |
| Unit tests under `electron/tests/unit/` | Registry + match + trap helpers |
| Plan doc | This file |

### Out of scope

- README rewrite beyond optional tiny note (prefer in-app help first).
- ChatStream keyboard navigator.
- Main-process menu.
- Redesign of Esc multi-stage interrupt.

## Design

### Architecture

```
renderer/keyboard/
  types.ts              // ShortcutDef, ShortcutGroup, KeyChord
  match.ts              // eventMatchesChord(e, chord), isEditableTarget
  registry.ts           // SHORTCUTS[], getById, formatChord, groups for help
  useGlobalShortcuts.ts // window keydown → dispatch map of handlers
  useFocusTrap.ts       // trap + restore + initial focus
  useRovingListIndex.ts // activeIndex + arrow handlers for lists
  ShortcutsHelp.tsx     // modal UI (or under components/)
```

### Shortcut registry (v1)

| id | Chord | Group | Action owner |
|----|-------|-------|--------------|
| `palette.toggle` | Mod+K | Global | ChatView / palette |
| `session.new` | Mod+N | Sessions | ChatView |
| `session.switch.1`…`9` | Mod+1…9 | Sessions | ChatView |
| `inspector.toggle` | Mod+B | Layout | Sidebar / ChatView |
| `sessionsRail.toggle` | Mod+\ | Layout | ChatView |
| `settings.open` | Mod+, | Global | ChatView |
| `shortcuts.help` | Mod+/ | Global | ChatView |
| `config.save` | Mod+S | Config | ConfigView (when config open) |
| `composer.send` | Mod+S | Composer | InputArea only (document; local handler) |

Notes:
- `composer.send` / Enter / Esc interrupt stay local to `InputArea` (context-sensitive); help documents them as contextual.
- `config.save` only active when ConfigView mounted (handler registered there).

### Focus trap algorithm

On mount/open:
1. Store `document.activeElement` as restore target.
2. Query focusable: `a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])` within container.
3. Focus `initialFocusRef` or first focusable.
4. On `keydown` Tab: if last+Tab → first; first+Shift+Tab → last; preventDefault.
5. On unmount/close: restore focus to stored element if still in document.

Apply to: CommandPalette overlay content, ConfigView root (full-screen replacement), Onboarding root, ShortcutsHelp, PreferencesWindow.

### Session list keyboard

- Flatten visible session ids in display order (primary groups + expanded other projects).
- Container `role="listbox"`; rows `role="option"` `aria-selected`.
- `tabIndex={0}` on listbox; `tabIndex={-1}` on options; move `aria-activedescendant` or focus the active option (prefer focus-on-option for visible rings).
- ArrowUp/Down clamp; Enter calls `onSelect`; Delete/Backspace optional → `onDelete` for active (confirm not required if current delete is instant — match mouse behavior).
- When active session changes externally, sync activeIndex.

### Esc layering (document only + trap order)

Do not rewrite interrupt. Ensure traps and help close before interrupt handlers need Esc:
1. Nested dropups/menus
2. Shortcuts help
3. Command palette
4. Config unsaved dialogs
5. Config view
6. Onboarding
7. Streaming interrupt (InputArea)

Implementation: help/palette stop propagation or check open state first (already partially true).

### Footer

Replace hard-coded kbd spans with `formatChord` + labels for:
- `palette.toggle` → "commands"
- `inspector.toggle` → "inspector"
- `session.new` → "new session"

Optional fourth: tiny "Mod+/ help" if space allows; else only in help modal.

### CSS

Add shared `.focus-ring` / ensure session-item and dialog receive `:focus-visible` outline using theme tokens (`outline` / `primary`).

## Implementation Units

### U1. Keyboard core modules

- Create `match.ts`, `types.ts`, `registry.ts`, `useGlobalShortcuts.ts`, `useFocusTrap.ts`, `useRovingListIndex.ts`.
- Pure functions unit-tested.

### U2. Wire global shortcuts + help modal

- `ChatView`: replace inline Mod+K/N/,/1-9 with `useGlobalShortcuts`; add left-rail toggle + help open state.
- `ShortcutsHelp` component; open via registry.
- `Sidebar`: keep toggle via shared handler from ChatView OR register `inspector.toggle` only once in ChatView (prefer single owner in ChatView to avoid double-toggle).

### U3. Focus traps

- CommandPalette: trap + restore to composer (InputArea exposes ref or `data-orchid-composer` query).
- ConfigView, OnboardingScreen, PreferencesWindow, ShortcutsHelp: useFocusTrap.

### U4. Session list navigation

- LeftSidebar SessionList: roving index + roles + keys.
- Expand left rail if collapsed when focusing sessions via shortcut (if we add focus-sessions later; for toggle only expand on toggle open).

### U5. Footer + Config footer labels

- Footer from registry.
- Config footer already has Ctrl S / Esc — use `formatChord` for consistency.

### U6. Tests

- `tests/unit/keyboard-registry.test.ts`: all ids unique; match Mod+K; editable guard; formatChord.
- Optional: roving index clamp tests.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Double-handling Mod+B (Sidebar + ChatView) | Single registration in ChatView only |
| Mod+S send vs config save | Config only mounted when open; InputArea only on textarea keydown |
| Focus restore to detached node | Check `document.contains` |
| Trap fights nested model dropup | Dropups inside composer are outside trap; palette trap is self-contained |
| Session list + delete button | Arrow nav focuses row main control; delete via key only when list focused |

## Acceptance Criteria

- [x] Mod+K/N/B/,/1-9/\/ and Mod+/ work as specified
- [x] Palette Tab cycles inside; close restores focus to composer when it was focused
- [x] Session list arrows + Enter without mouse
- [x] Help modal shows all registry global shortcuts
- [x] Footer labels match registry chords
- [x] Unit tests pass; typecheck clean
- [x] No commit created by implementer

## Test Plan

1. `npm test` (unit) in `electron/`
2. `npm run typecheck`
3. Manual (if env allows): open app, keyboard-only: new session, palette, settings, help, session arrows, inspector/left toggle

## Plan Review

### Findings (addressed in implementation)

1. **Double Mod+B** — `Sidebar` currently owns `Ctrl+B`. Must remove that listener; single owner in `ChatView` via registry to avoid toggle thrash.
2. **Config vs Chat mount** — `App` swaps `ChatView` for `ConfigView`, so chat globals unmount. Config registers only save/close; help/palette unavailable while in config (acceptable).
3. **Composer restore target** — add `data-orchid-composer` on the textarea so traps restore without ref plumbing across the tree.
4. **Mod+\ portability** — backslash is awkward on some layouts; keep `Mod+\` as primary and document; do not also bind `Mod+Shift+B` in v1 to avoid conflict creep.
5. **Editable guard** — `Mod+/` and `Mod+K` must work even in textarea (`allowInEditable: true`). Bare keys never global.
6. **Palette open** — while palette/help open, still allow `Mod+K` / `Mod+/` to close; suppress `Mod+N` / session switch to avoid surprising side effects under overlay.
7. **Session Delete key** — match mouse: immediate delete, no extra confirm (existing behavior).
8. **PreferencesWindow** — unused by `App`; upgrade trap only if cheap, else skip to limit scope.
9. **Chat stream navigator** — confirmed deferred; do not half-implement.
10. **Tests** — prefer pure unit tests; avoid brittle DOM integration in Vitest node env (existing palette tests are stubs).

### Review verdict

Plan is right-sized for one implementation pass. Proceed with U1–U6; skip PreferencesWindow unless touched incidentally.
