# refactor: UI Standardization — DaisyUI-as-engine, Primitives-as-API

**Status:** Draft
**Origin:** User request on the components branch — provide standardization, move away from plain CSS and away from direct DaisyUI usage in feature JSX, so a visual change touches one owner file rather than many scattered screens.

## Problem Frame

The current renderer styles from three competing sources of truth at once:

1. **Direct DaisyUI classes in feature JSX** — `className="btn btn-primary btn-sm"`, `input input-bordered w-full`, `alert alert-warning`, etc. A surface-level change (e.g. restyle a button's density) requires editing every feature file that calls the DaisyUI class directly.
2. **`orchid-*` CSS composites in `components.css`** — present and good, but not the only source of truth for the surfaces they describe.
3. **Residual CSS in `chat.css`** — 2,016-line "legacy bridge" that styles sessions, panels, config, onboarding, model picker chrome, shortcuts help, and markdown overrides. The contract already says "do not add new rules here; shrink over time." No test enforces that.

The audit confirmed the scale of drift outside the `components/ui/` boundary:

| DaisyUI root | Hits | Files | Notes |
|---|---|---|---|
| `btn` | 93 | 23 | Heaviest; `OnboardingScreen` alone has 15 |
| `alert` | 42 | 15 | `OnboardingScreen` 10; providers cluster 22 |
| `input` | 41 | 11 | `Preferences/GeneralTab` 11 |
| `card`/`card-body` | 14 | 8 | All mid-migration (`config-card` + DaisyUI on same element) |
| `badge` | 12 | 3 | 10 in `ConnectionModelsDialog` |
| `loading` | 11 | 10 | Pure `loading loading-spinner loading-xs` |
| `select` | 8 | 6 | Preferences + Wizard + Onboarding |
| `checkbox` | 4 | 4 | All `checkbox-sm` / `checkbox-primary` |
| `dropdown` | 3 | 2 | Footer + ModelPicker (mid-migration) |
| `tabs`/`tab` | 2 | 1 | ConfigView (mid-migration with `config-tab`) |
| `steps`/`step` | 2 | 1 | OnboardingScreen |
| `modal`/`modal-action` | 2 | 1 | ConfigView |
| `progress`/`radial-progress` | 2 | 2 | Sidebar + Footer (mid-migration) |
| `table` | 1 | 1 | ModelPicker (mid-migration with `model-picker-table`) |
| `join` | 1 | 1 | ScopeToggle |

**Total ≈ 236 direct DaisyUI hits in feature code.** The `components/ui/` directory has 9 primitives (`IconButton`, `Panel`, `SectionHeader`, `FormField`, `DialogSurface`, `PopoverList`, `ShortcutBar`, `StateMessage`, `StatusBadge`) — those already own DaisyUI internally and are the right model. Gaps: no `Button` (general), `TextInput`, `Select`, `Checkbox`, `Spinner`, `Alert`, `Tabs`, `Steps`, `ConfigCard`, `DropdownMenu`.

The existing contract test (`tests/integration/renderer-style-contract.test.ts`) currently only scans for Tailwind *arbitrary-value* tokens, not DaisyUI class-name drift. `chat.css` is documented frozen but not testably frozen.

## Scope

### Stated
- Unify styling ownership behind `components/ui/` primitives: feature JSX no longer mentions DaisyUI class roots directly.
- Freeze `chat.css` (testably) and drain it surface-by-surface into `components.css` and new primitives.
- Make the contract test enforce the new rules so the standardization survives hurries and code-review.

### Inferred
- Pin the styling model in the contract README: DaisyUI is the *engine*, primitives are the *API*. DaisyUI class names are allowed only inside `components/ui/`.
- Selectively replace DaisyUI semantics with own-composites where DaisyUI's markup is awkward — dialog and dropdown (already started via `DialogSurface` / `PopoverListbox` logic).

### Non-goals
- **Do not** drop the DaisyUI plugin or rewrite every DaisyUI semantic as `orchid-*` `@apply` rules.
- **Do not** introduce a second styling library, CSS Modules, or styled-components.
- **Do not** change shell topology — left session nav → session tabs → chat/composer → overlays — per contract `src/renderer/styles/README.md`.
- **Do not** redesign session tabs, the chat center, settings, onboarding IA, or workspace header.
- **Do not** introduce new components like `tabs`, `tooltip`, `menu` purely for completeness — only build primitives for DaisyUI roots audited as actually used (`btn`, `input`, `select`, `checkbox`, `loading`, `alert`, `badge`, `card`, `tabs`, `steps`, `dropdown`, `table`, `modal`, `progress`).
- **Do not** apply arbitrary Tailwind values (`text-[10px]`, `z-[1000]`) — already forbidden and locked by the existing test.

## Success Criteria

- **S1.** No `.tsx`/`.jsx` outside `src/renderer/components/ui/` contains any DaisyUI root class name (`btn`, `input`, `select`, `checkbox`, `radio`, `toggle`, `loading`, `alert`, `badge`, `status`, `card`, `tabs`, `tab`, `steps`, `step`, `dropdown`, `modal`, `table`, `tooltip`, `kbd`, `range`, `progress`, etc.) in a `className` attribute — enforced by the contract test.
- **S2.** The contract test fails when `chat.css` grows beyond its baseline line count (or, optionally, on any new rule subject that isn't already present).
- **S3.** `chat.css` line count trends monotonically down — initial baseline 2016, target ≤ 1200 by end of phase 4, ≤ 400 once all listed surfaces migrate.
- **S4.** No raw non-token colors (`oklch(..)`, `#hex`, `rgb(`, `hsl(` except inside `index.css` fallback `:root` and runtime theme files) in any `src/renderer/styles/*.css` — enforced by the contract test.
- **S5.** All 5 runtime themes (`default`, `solarized-light`, `bluey`, `windows-xp`, `green-terminal`) remain visually identical for unchanged shells and controls (manual + existing `renderer-style-contract.test.ts` checks remain green).
- **S6.** Existing arbitrary-utility lock remains green; `APPROVED_ARBITRARY_UTILITIES` and `BASELINE_ARBITRARY_UTILITIES` stay empty sets.
- **S7.** Existing source-level contracts (`chat-rendering-contract.test.ts`, `composer-contract.test.ts`) remain green unchanged.

## High-Level Technical Design

### Target model — DaisyUI-as-engine, primitives-as-API

```
feature .tsx JSX
   │   imports <Button>, <TextInput>, <Alert>, ...
   ▼
components/ui/*.tsx          ← ONLY place allowed to name DaisyUI classes
   │   composes DaisyUI + Tailwind + orchid-* composites
   ▼
DaisyUI v5 (CSS plugin) + Tailwind v4 utilities
   ▲
orchid-* @apply composites in components.css
   ▲
chat.css residual rules — frozen, drained as surfaces migrate
```

### Why not replace DaisyUI entirely (Option B)

The audit shows the hot DaisyUI roots (`btn`, `input`, `select`, `checkbox`, `loading`, `badge`, `steps`) are used cleanly and would offer no real benefit if reimplemented as `@apply` composites — we'd carry DaisyUI's markup opinions plus a parallel `orchid-*` set. A full replacement would double maintenance and re-implement ARIA focus traps DaisyUI already provides. We adopt **selective B** only where DaisyUI's opinionated markup fights us — dialog and dropdown — where primitives (`DialogSurface`, `PopoverList`) are already half-built.

### Enforcement model: baseline-then-shrink

The contract test gains two new scanners that ship green on Day 1:

1. **JSX-DaisyUI scanner**: walks `.tsx?` under `src/renderer/` (excluding `src/renderer/components/ui/`, `src/renderer/themes/`) and flags any `className` token whose first word matches a DaisyUI root set. A `BASELINE_DAISYUI_HITS` set snapshots the current findings as `file:root` tuples. Test fails when (a) a non-baselined `file:root` appears, or (b) baseline count for a file grows beyond snapshot. Drives baseline to zero as migration progresses.
2. **chat.css growth guard**: snapshots current line count; fails on increase. Optionally also scans for new selector subjects by `wc -l` plus a `wc` of `}` count.
3. **Non-token color scanner**: scans `.css` under `src/renderer/styles/` (excluding the `:root` fallback block in `index.css`); flags `oklch(...)`, `#hex`, `rgb(`, `hsl(` literals. Baseline set captures the 11 known `oklch(...)` occurrences in session-tab/name-editor blocks so those can be migrated without breaking the test partway.

Each migration PR trims the corresponding baseline entries — visible progress *and* a hard guarantee no regression.

## Patterns to Follow

- `IconButton` (`src/renderer/components/ui/IconButton.tsx`) — the canonical pattern: typed `size`/`variant` unions, `Record<size, string>` class maps, `forwardRef`, `label` required for a11y, `loading` state via DaisyUI's `loading loading-spinner`.
- `StatusBadge` (`src/renderer/components/ui/StatusBadge.tsx`) — full tone × size × outline × dot coverage; most complete example.
- `Panel` (`src/renderer/components/ui/Panel.tsx`) — polymorphic `as` prop, tone map, `orchid-*` composite hook.
- `PopoverListbox` logic (`popover-listbox-logic.ts`, `usePopoverListbox.ts`) — for any dropdown-like primitive; do not reinvent keyboard handling.
- Existing `orchid-*` composites — when the same utility/context set is reused, add to `src/renderer/styles/components.css` `@layer components` rather than expanding a primitive's prop API.

## Phased Work

The work is sequenced so each phase is independently shippable. **Phase 1 foundations ship first; Phase 2 primitives depend on Phase 1 tests being in place; Phases 3–4 migrate callers and drain chat.css in parallel pairs; Phase 5 closes the token gap.**

---

## Phase 1 — Foundation: contract + enforcement harness

### U1. Update the styling contract README

**Goal:** Reflect the chosen target model in `src/renderer/styles/README.md`.

**Requirements:** S1, S2, S4 (document basis).

**Files:**
- `src/renderer/styles/README.md` — write the new rules.

**Approach:**
- Replace the "Class selection order" section: the new order is `(1) Recognized primitive in components/ui/` → `(2) orchid-* composite` → `(3) Predefined Tailwind utilities for layout` → `(4) Custom exceptions`. DaisyUI component classes are *not* a top-level priority order entry any more; they are internal to `components/ui/`.
- Add an "Ownership matrix" section: each DaisyUI root has a single owner primitive file in `components/ui/`. Feature code may not reference DaisyUI roots directly.
- Document `chat.css` as frozen with a shrink rule — new rules may not be added; migrated surfaces delete their blocks.
- Document the non-token color rule.
- Preserve the existing "Layout preservation (non-negotiable)" section unchanged.
- Preserve DaisyUI's CSS plugin registration (`@plugin "daisyui"` in `index.css`) — DaisyUI is still wired; engines are not removed.

**Test scenarios:**
- `tests/integration/renderer-style-contract.test.ts` "Contract Documentation" group continues to pass (still contains "class selection", "approved exceptions", "DaisyUI", "orchid-", all 5 theme names).

**Verification:** README changes; no behavioral change. Existing contract tests stay green.

---

### U2. Enforcement harness in the contract test

**Goal:** Three new scanners (JSX-DaisyUI, chat.css growth, non-token color) wired into `tests/integration/renderer-style-contract.test.ts`, all green on Day 1 via captured baselines.

**Requirements:** S1, S2, S4.

**Files:**
- `tests/integration/renderer-style-contract.test.ts` — add 3 describe blocks + 3 baseline snapshots.

**Approach:**
- **JSX-DaisyUI scanner.** Reuse the existing `walkRendererFiles` helper from the arbitrary-utility block. Extract all tokens from `className` and `class` attributes. DaisyUI root set = `RESERVED_MODIFIER_ROOTS` already declared in the test (btn, input, select, textarea, alert, badge, status, loading, collapse, modal, tabs, tab, steps, step, dropdown, table, card, kbd, tooltip, checkbox, radio, toggle, range, progress, etc.). Token match rule: token's first `-`-delimited segment, or the whole token if no `-`, is in the root set; exclude `orchid-*`, all custom-prefixed classes (`config-*`, `session-*`, `orchid-*`, `mock-*`, `provider-*`, `command-*`, `tool-*`, `slash-*`, `inspector-*`, `context-*`, `chat-*`, `panel-*`, `right-panel-*`, `left-panel-*`, `main-pane`, `config-tabs` aliases), keeping the existing `BASELINE...` allowlist discipline. Capture baseline as a stable sorted array of `${relPath}:${root}` tuples for all current offenders. Test asserts: every current finding is in baseline, no new finding outside baseline. Baseline shrinks per migration PR.
- **chat.css growth guard.** Snapshot: `chatLineCount = read('src/renderer/styles/chat.css').split('\n').length` (≈ 2016 on this branch) and `chatBlockCount = count of lines starting with '}' or containing '{' and '}'`. Test asserts both are ≤ baseline. Updating the baseline is a deliberate edit (re-enter the new lower number).
- **Non-token color scanner in `.css`.** Scan `src/renderer/styles/*.css` except a `:root` block in `index.css`. Match `oklch(`, `#[0-9a-fA-F]{3,8}\b`, `rgb(`, `hsl(`, `rgba(`, `hsla(`. Capture baseline set of `file:line:value` tuples (the 11 known `oklch()` in session tabs/name editor plus 3 `#000` in model-picker `color-mix` fallbacks). Test fails on new color literals outside baseline.
- All scanners **exclude** `src/renderer/themes/` (runtime theme CSS uses colorWithOp utility, allowed), `src/renderer/components/ui/`, and `src/renderer/styles/index.css` `:root` fallback block (lines ~23–37).

**Test scenarios:**
- Day 1: each scanner passes because baseline equals current state.
- Regression: adding a fresh `btn btn-primary` to any feature file outside `ui/` fails the scanner (baseline unchanged).
- Migration PR: removing `btn` usage from `OnboardingScreen.tsx` and trimming the corresponding baseline rows keeps the scanner green, with a smaller baseline.

**Verification:** `npm test -- renderer-style-contract` green. New scanner blocks present in the report.

---

## Phase 2 — Core primitives in `components/ui/`

Each primitive ships in a single PR (adds the file, no caller migration yet — that happens in Phase 3/4 with baseline trims). Primitives own DaisyUI internally per S1.

### U3. `Button` — the biggest one (covers ~80 of 93 btn hits)

**Goal:** A typed button primitive that owns all `btn` semantics DaisyUI currently provides to features.

**Requirements:** S1 (closes the largest drainer).

**Dependencies:** U1, U2.

**Files:**
- `src/renderer/components/ui/Button.tsx` — new.

**Approach:**
- Variants: `primary | ghost | error | warning | neutral | link` (DaisyUI's `btn-*` set).
- Sizes: `xs | sm | md | lg`.
- Shapes: `default | square | circle` — matches DaisyUI `btn-square` / `btn-circle`.
- `loading?: boolean` — renders `loading loading-spinner` per DaisyUI convention; mirrors `IconButton`.
- `icon?: IconName` and `iconRight?: IconName` — leading/trailing icon slot (covers cases currently writing `btn ... gap-1` with inline SVG). Use existing `Icon` from `src/renderer/components/Icon`.
- Polymorphic `as?: 'button' | 'a'` — covers `<a className="btn btn-primary">` patterns in onboarding nav if any exist; default `button`. Mirrors the contract allowance.
- `forwardRef`; `disabled`, `type`, and all `ButtonHTMLAttributes<HTMLButtonElement>` pass through.
- `children` is the label; if `children` is omitted and only `icon` is provided, the consumer should prefer `IconButton`. Consider documenting this in the contract rather than runtime-warning.
- Internal DaisyUI class map: `btn`, `btn-{variant}`, `btn-{size}`, `btn-square`/`btn-circle`, `loading loading-spinner loading-xs/sm`.

**Patterns to follow:** `IconButton.tsx`, `StatusBadge.tsx`.

**Test scenarios:**
- Snapshot or render: each variant/size combination produces expected classNames — no `undefined` and no missing `btn`.
- Loading state: when `loading=true`, button renders a spinner child and the label shifts to aria-busy per DaisyUI convention.
- `as="a"` renders `<a>` with `btn` classes preserved.
- Disabled propagates and disables click handlers (DaisyUI `btn-disabled` / `disabled` attribute).
- forwardRef ref points to the underlying DOM node.

**Verification:** `Button.tsx` ships; no consumers yet. `tsc` and `eslint` pass.

---

### U4. `TextInput` — covers 41 input hits

**Goal:** Owns DaisyUI `input input-bordered input-sm` set.

**Files:**
- `src/renderer/components/ui/TextInput.tsx` — new.

**Approach:**
- `forwardRef<HTMLInputElement>` wrapping DaisyUI `input`.
- Sizes: `xs | sm | md` (DaisyUI has `input-xs`/`input-sm`, no md special — default blank).
- `bordered?: boolean` (default true) → `input-bordered`. Most Preferences callers use `input input-bordered w-full`; providers use `input w-full` (unbordered). The `bordered` flag captures both.
- `invalid?: boolean` → DaisyUI `input-error` (used by validation in Preferences).
- Forward `id`, `name`, `value`, `defaultValue`, `onChange`, `placeholder`, `type`, etc.
- Wrap with `FormField` integration: optional `label`/`hint`/`error` — *or* leave labelling to `FormField` composition (recommended — matches existing `FormField` design). Keep the primitive single-element to avoid scope creep.

**Test scenarios:**
- Sizes produce stable class strings.
- `bordered=false` omits `input-bordered`.
- `invalid=true` adds `input-error`.
- Ref forwarding works.
- Pass-through id, value, onChange at runtime (unit test with a controlled input).

**Verification:** `TextInput.tsx` ships.

---

### U5. `Select` — covers 8 select hits

**Files:** `src/renderer/components/ui/Select.tsx` — new.

**Approach:**
- `forwardRef<HTMLSelectElement>` wrapping DaisyUI `select`.
- Sizes: `xs | sm | md`.
- `bordered?: boolean` (default true) → `select-bordered`.
- `invalid?: boolean` → `select-error`.
- Children expected to be `<option>` elements — keep `<select>` semantically open; do not build an option list API (would duplicate `PopoverList`).
- `disabled`, `value`, `onChange`, `name`, `id` forwarded.

**Test scenarios:**
- Sizes/bordered/invalid class maps render correctly with `<option>` children.
- Ref forwarding.
- Disabled state.

**Verification:** `Select.tsx` ships.

---

### U6. `Checkbox` — covers 4 checkbox hits

**Files:** `src/renderer/components/ui/Checkbox.tsx` — new.

**Approach:**
- `forwardRef<HTMLInputElement>` wrapping DaisyUI `checkbox`.
- Size: `xs | sm | md`.
- Tone: `primary | secondary | accent | neutral | error | success | warning` (DaisyUI tone modifiers).
- API matches native checkbox: `checked`, `defaultChecked`, `onChange`, `indeterminate` (controlled via ref dispatch — DaisyUI supports this; expose `indeterminate` as a prop forwarding through `useEffect`).
- Optional `label?: ReactNode` — when provided, renders the DaisyUI `<label className="label">...<Checkbox/></label>` form (covers `checkbox checkbox-primary mt-1` cases in Onboarding and Preferences that currently pair with adjacent text).

**Test scenarios:**
- Tone/size class maps.
- Label orphans vs paired (renders inside `<label className="label">`).
- Indeterminate attribute applies (DOM property set).
- onChange fires with event.

**Verification:** `Checkbox.tsx` ships.

---

### U7. `Spinner` — covers 11 loading hits

**Files:** `src/renderer/components/ui/Spinner.tsx` — new.

**Approach:**
- Tiny primitive. Props: `size?: 'xs' | 'sm' | 'md' | 'lg'`, `variant?: 'spinner' | 'dots' | 'ring' | 'ball' | 'bars'` (DaisyUI set; default `spinner`).
- Class output: `loading loading-{variant} loading-{size}`.
- Optionally render inside other primitives (`Button.loading`, `IconButton.loading`, `StateMessage.kind=loading`) — those internal call-sites may switch to internal use once it exists; that's an internal refactor and **does not** count as a feature-file DaisyUI hit currently (loading in features like Sidebar/Footer/MessageWidget/ToolActivityGroup/ToolCallBlock is the migration target).

**Test scenarios:**
- All variants×sizes produce expected class strings.
- No `undefined`/missing classes.

**Verification:** `Spinner.tsx` ships; internals of `IconButton`, `StateMessage` can adopt it later.

---

### U8. `Alert` — covers 42 alert hits

**Goal:** Standardize the second-largest DaisyUI surface in features.

**Files:** `src/renderer/components/ui/Alert.tsx` — new.

**Approach:**
- Tone: `info | success | warning | error` → `alert alert-info` etc.
- `soft?: boolean` → `alert-soft` (DaisyUI v5 modifier; used by `command-toast` mid-migration surface).
- `variant?: 'default' | 'block' | 'outline'` → DaisyUI `alert-block`, `alert-outline`.
- Optional `icon?: IconName` (DaisyUI Alert shows leading icon natively; if absent let DaisyUI draw default).
- Optional `action?: ReactNode` (DaisyUI alert has a trailing slot for actions — e.g. `<button>` "see logs").
- Optional `title?: ReactNode` and `children?: ReactNode` (DaisyUI alert allows title + body pair). Render `<div className="grid-col-[1fr]">` title/text layout when title present.
- Polymorphic `as?: 'div' | 'section'` — generally a `<div role="alert">`.
- Forward `onClose` to render a soft `alert` with `relative close` button (if the existing call-sites need dismissible) — but audit shows no current alert has a close button; defer this.

**Test scenarios:**
- Tone maps; `soft` toggles `alert-soft`; `variant="block"` toggles `alert-block`.
- Title + body renders the DaisyUI two-line grid.
- `action` slot renders as trailing element with `ms-auto` alignment per DaisyUI docs.
- `role="alert"` set on root.

**Verification:** `Alert.tsx` ships.

---

### U9. `Tabs` and `Tab` — covers 2 hits (ConfigView)

**Goal:** Replace the mid-migration `config-tabs tabs tabs-boxed`/`config-tab tab tab-active` dual-ownership pattern with a typed primitive.

**Files:**
- `src/renderer/components/ui/Tabs.tsx` — new. Exports `Tabs`, `Tab`, `TabList`, `TabPanel` as appropriate; mirror a minimal controlled or uncontrolled API.

**Approach:**
- Controlled via `value`/`onValueChange` or uncontrolled via `defaultValue`. Keep small — wrap DaisyUI `tabs tabs-boxed` and `tab tab-active`.
- `variant?: 'boxed' | 'bordered' | 'lift' | 'pill'` (DaisyUI tabs layout modifiers — switch from boxed to others later without features editing).
- Internally routes the active state to `tab tab-active`.
- Optional `orchid-*` composite: `orchid-config-tabs` is the existing mid-migration alias — the primitive owns both the `tabs`/`tab-active` DaisyUI classes *and* the `orchid-*` composite; ConfigView drops both raw forms.

**Test scenarios:**
- Active tab toggles `tab-active` when value changes.
- `variant` toggles layout class.
- Keyboard arrow navigation within the tab list (DaisyUI gives this via `role="tab"` semantics) — verify `tablist`/`tab` ARIA roles are present.

**Verification:** `Tabs.tsx` ships.

---

### U10. `ConfigCard` — covers 14 card hits and the `config-card` mid-migration pattern

**Goal:** Owns the repeating `config-card card bg-base-100 border border-base-300` / `config-card card border border-primary/30 bg-primary/5` chrome across Preferences tabs and `ConnectionList`.

**Files:**
- `src/renderer/components/ui/ConfigCard.tsx` — new. Includes `ConfigCardTitle`, `ConfigCardRow`, `ConfigCardActions` subcomponents as the existing `config-card-*` class set.

**Approach:**
- Variants: `default | active` — `default` → `config-card card bg-base-100 border border-base-300`; `active` (selected row) → `config-card card border border-primary/30 bg-primary/5`.
- `body?: 'stack' | 'row'` → compose `<ConfigCardBody>` rendering `card-body p-4` (stack) versus `config-card-row card-body p-4 flex-row items-center gap-4` (row). Matches audit pattern in `ModelAssignments.tsx` L127 (`flex-row items-center`).
- Subcomponents delegate to small `orchid-*`/composite classes already in `components.css` rather than each tab re-deriving titles/desc/rows.

**Patterns to follow:** existing `config-card*` class set in `chat.css` block 15 — the `ConfigCard` primitive should replace the *class literal* usage in JSX; the CSS rules can move to `components.css` `@layer components` as part of the chat.css drain (see U14).

**Test scenarios:**
- variant default/active renders expected class strings.
- body=stack vs row renders respective flex classes.
- Subcomponents compose when nested.

**Verification:** `ConfigCard.tsx` ships.

---

### U11. `DropdownMenu` — covers 3 dropdown hits + the `dropdown-content` mid-migration pattern

**Goal:** Replace mid-migration `dropdown dropdown-top dropdown-end` + `dropdown-content orchid-{panel}` with a typed primitive that reuses the existing `PopoverListbox` logic.

**Files:**
- `src/renderer/components/ui/DropdownMenu.tsx` — new.
- Reuse `src/renderer/components/ui/usePopoverListbox.ts`, `popover-listbox-logic.ts`.

**Approach:**
- Composition: `<DropdownMenu trigger={...}> content </DropdownMenu>` where the dropdown uses the existing popover listbox hooks (open state, outside click, keyboard).
- Use this primitive for Footer context menu and ModelPicker trigger currently using `dropdown` + `orchid-footer-context-panel` / `orchid-model-picker-menu`. Existing `PopoverList` already uses this logic for value pickers — `DropdownMenu` is the generalized content variant for arbitrary children.
- Optional: fold `PopoverList` to compose `DropdownMenu` internally — but that's a refactor of an existing primitive; mark as deferred (preserve `PopoverList` for now).

**Test scenarios:**
- Trigger click opens menu with `aria-expanded`, `aria-haspopup`.
- Outside click closes.
- Escape closes; focus returns to trigger.
- `placement` prop positions the menu (use the existing `PopoverPlacement`).
- Keyboard arrow Navigation delegates to children listbox where applicable.

**Verification:** `DropdownMenu.tsx` ships. `PopoverList` untouched.

---

## Phase 3 — Migrate callers and trim baselines (per-surface PRs)

Each migration PR is independent and trims the corresponding rows from `BASELINE_DAISYUI_HITS`, `BASELINE_NON_TOKEN_COLORS`, and `chatLineCount`. PRs in this phase may run in parallel subject to no two PRs editing the same file.

### U12. Migrate Onboarding and Provider Wizard

**Goal:** Largest single hotspot — `OnboardingScreen.tsx` (~27 hits) plus `ConnectionWizard.tsx` (~11) — routed through the new primitives.

**Dependencies:** U3, U4, U5, U6, U8, U10; parallel with U1–U2.

**Files:**
- `src/renderer/components/Onboarding/OnboardingScreen.tsx`
- `src/renderer/components/Providers/ConnectionWizard.tsx`

**Approach:**
- Replace `btn btn-primary` etc. → `<Button variant="primary">`; replace `input input-bordered w-full` → `<TextInput bordered />`; `select select-bordered w-full` → `<Select bordered />`; `checkbox checkbox-primary mt-1` → `<Checkbox tone="primary" label={...} />`; `alert alert-warning` → `<Alert tone="warning">`.
- `steps steps-horizontal` and `step step-primary`: defer to U14 (Steps primitive) if scoped, or migrate with a small inline `Steps` helper that wraps DaisyUI `steps/step` (no consumers elsewhere so wait — actually add as a small primitive in U14 if audit shows only this file).
- Stop passing `modal modal-open`, `modal-action` directly in `ConfigView`? That belongs to U14 — `DialogSurface` owns it.
- Drain the `chat.css` Onboarding overlay block (lines 15–180, ~166 lines) and Provider wizard block (lines 34–107, ~74 lines) into `components.css` `@layer components` as `orchid-onb-*`/`orchid-provider-wizard-*` composites or, where possible, fully express on primitives and delete the CSS.

**Test scenarios:**
- Render snapshot of OnboardingScreen shows identical visual chrome (manual review per theme).
- Each step indicator renders with `step`/`step-primary` per current state; back/next button chains work.
- Provider Wizard save/cancel still works with `<Button>` variant replacement.
- No regression in first-run flow tests (if any) — search `tests/integration/` for onboarding smoke tests.

**Verification:** JSX-DaisyUI scanner reveals zero `btn|input|select|checkbox|alert|steps|modal` in those files; baseline trimmed.

---

### U13. Migrate Preferences tab suite — the biggest input/select hotspot

**Goal:** Replace ~25 `input input-bordered w-full` and ~8 `select select-bordered w-full` hits plus `config-card`, `alert`, `loading` usage across the Preferences tab suite, by routing through `TextInput`, `Select`, `ConfigCard`, `Alert`, `Spinner`, `FormField`, and the drained `orchid-config-card-*` composites.

**Dependencies:** U3–U8, U10; Phase 1 for trims.

**Files (all in `src/renderer/components/Preferences/`):**
- `GeneralTab.tsx` — 11 input hits + 2 select + 1 checkbox
- `RAGTab.tsx` — 6 input hits
- `MCPServersTab.tsx` — 4 input + 4 `config-card`/`card-body` + 1 alert
- `AgentsTab.tsx` — 3 input + 1 select + 4 btn + 2 `config-card` + 1 alert + 1 loading
- `PersonalitiesTab.tsx` — 1 input + 1 select + 4 btn + 2 `config-card` + 1 alert + 1 loading
- `SkillsTab.tsx` — 2 input + 1 select + 4 btn + 2 `config-card` + 1 alert + 1 loading
- `MultiSelectList.tsx` — 1 input + 2 btn + 1 checkbox
- `ModelAssignments.tsx` — 1 alert + 2 `config-card`
- `ScopeToggle.tsx` — `join join-horizontal` (leave one-off inline; document in README as approved exception schema)

**Approach:**
- Compose each field row as `<FormField label="..." hint="..."><TextInput ... /></FormField>` so the label/density alignment is owned once.
- Replace `<div className="alert alert-error ...">` with `<Alert tone="error" className="...">` — size modifiers (`py-2 text-sm mb-3`) pass through as `className` overrides on the primitive.
- Replace `<div className="config-card card bg-base-100 border border-base-300">` with `<ConfigCard>`. Replace `card-body p-4` with `<ConfigCard.Body>` (variant `stack`) or `<ConfigCard.Body variant="row">`.
- Replace `loading loading-spinner loading-xs` with `<Spinner size="xs" />`.
- `<button className="btn btn-ghost btn-xs font-normal text-primary hover:bg-primary/10">` becomes `<Button variant="ghost" size="xs" className="font-normal text-primary hover:bg-primary/10">` — the Tailwind extras stay since they're *composition* utilities, not DaisyUI roots. Document this in the README as the only place ad-hoc Tailwind modifiers are expected on Button.

**Test scenarios:**
- Each tab visually identical across the 5 theme files (manual review).
- Validation flows still work — `TextInput invalid` is wired so error messages still surface from `FormField.error`.
- All Preferences contract tests in `tests/unit/` stay green.

**Verification:** JSX-DaisyUI scanner no longer flags any Preferences file; baseline trimmed.

---

### U14. Migrate Providers cluster — `btn`/`badge`/`alert` hotspot

**Goal:** `ConnectionModelsDialog.tsx` (23 hits — 10 badge, 9 btn, 4 alert), `ConnectionList.tsx` (15 hits — 9 btn, 6 alert, 2 `config-card`), `ConnectionWizard.tsx` (overlaps with U12 — file shared, decide inclusion here or in U12), `ProviderStatus.tsx` (4 alert + 1 btn).

**Dependencies:** U3, U8 (Alert), U10 (ConfigCard), U11 (DropdownMenu if applicable). May overlap with U12.

**Files (in `src/renderer/components/Providers/`):**
- `ConnectionModelsDialog.tsx`, `ConnectionList.tsx`, `ConnectionWizard.tsx`, `ProviderStatus.tsx`

**Approach:**
- Replace badge → route via existing `StatusBadge` (`StatusBadge tone="neutral" size="sm" outline={false}` variant or its `ghost` behavior). The present direct `badge badge-ghost badge-sm` patterns become `<StatusBadge tone="neutral" size="sm" className="badge-ghost">` if `StatusBadge` doesn't currently include ghost variant — add `ghost` to `StatusBadge.tsx`'s tone map before migrating (small pre-step inside this unit).
- Replace every `alert alert-info`/`alert alert-warning` with `<Alert tone={...}>`.
- Replace every `btn btn-ghost btn-sm` etc. with `<Button>`.
- Drain the matching `chat.css` blocks as part of the same PR.

**Test scenarios:**
- Connection wizard form submission works.
- Provider status indicator (alert + primary button) still renders per contract on ConnectionList.
- No regression in `tests/integration/provider-status-contracts.test.ts`.

**Verification:** Scanner baseline trimmed; no DaisyUI roots in `components/Providers/*.tsx`.

---

### U15. Migrate chat-shell and sidebar chrome — left sidebar, session tabs, footer

**Goal:** The mid-migration surfaces: `Footer.tsx` (dropdown/radial-progress/footer-context-btn), `ModelPicker.tsx` (dropdown-content + table), `SessionNameEditor.tsx` (input xs), `SessionTabBar.tsx` (session-tab-close uses btn), `LeftSidebar.tsx` (12 btn hits, many mixed with `orchid-*`/`session-*`), `Sidebar.tsx`, `ToolActivityGroup.tsx`, `session-activity-section.tsx`, `DefinitionActions.tsx` (3 btn hits — uses `IconButton` + raw `btn-square`), `CommandPalette.tsx` (`input input-sm orchid-command-palette-search-field`), `ScopeToggle.tsx` (`join`), `ChatView.tsx` (`btn btn-ghost btn-xs btn-circle` mixed with `orchid-*`).

**Dependencies:** U3, U4, U7, U8, U11.

**Files: `src/renderer/components/`
- `Footer.tsx`, `ModelPicker.tsx`, `SessionNameEditor.tsx`, `SessionTabBar.tsx`, `LeftSidebar.tsx`, `Sidebar.tsx`, `ToolActivityGroup.tsx`, `session-activity-section.tsx`, `CommandPalette.tsx`, `ScopeToggle.tsx`, `ChatView.tsx`, `ConfigView.tsx` (for the `tabs`/`modal-action` migration), `ChatStream.tsx`, `ErrorBanner.tsx`, `InputArea.tsx`, `MessageWidget.tsx` (alert mid-migration).

**Approach (group to avoid parallel editing conflicts):**
- Subgroup A: `Footer.tsx`, `ModelPicker.tsx` — switch `dropdown` wrapper to `DropdownMenu`; replace `input input-sm` with `<TextInput size="sm">`; switch `radial-progress` to `<Progress radial />` (build small `Progress` primitive as needed — or defer radial-progress as an approved exception since it's only in Footer; recommend `Progress` primitive in U16 extension if needed).
- Subgroup B: `SessionTabBar.tsx`, `SessionNameEditor.tsx`, `LeftSidebar.tsx`, `Sidebar.tsx` — replace every `btn btn-*` with `<Button>` or `<IconButton>` (most are ghost icon buttons — `IconButton` already covers them, just remove the doubled `btn-*` className).
- Subgroup C: `CommandPalette.tsx`, `ScopeToggle.tsx`, `ChatView.tsx`, `ConfigView.tsx` — `input input-sm orchid-command-palette-search-field` → `<TextInput size="sm" className="orchid-command-palette-search-field">`; replace `tabs tabs-boxed`/`tab tab-active` with `<Tabs>` from U9; replace `modal-action` by routing the inner buttons via `DialogSurface`'s footer slot (extend `DialogSurface` with a `footer?: ReactNode` slot pre-step inside this unit); replace `alert` mid-migration *composer gate* in `InputArea.tsx` with `<Alert>`.
- Subgroup D: `ErrorBanner.tsx`, `MessageWidget.tsx`, `ChatStream.tsx`, `ToolCallBlock.tsx`, `ToolActivityGroup.tsx` (`loading`, `alert` mid-migration) — replace with `<Alert>` and `<Spinner>`.

**Drain plan:** pair each subgroup with chat.css block drain (see Phase 4).

**Test scenarios:**
- `chat-rendering-contract.test.ts` continues to pass (orchid-msg classes preserved, DaisyUI chat wrappers absent).
- `composer-contract.test.ts` continues to pass (InputArea uses `textarea textarea-bordered` + `IconButton`) — note `textarea` is a DaisyUI root per the audit set; this single hit is the documented composer contract; include it in the baseline allowlist or migrate to a future `TextArea` primitive (defer; out of scope here — baseline allowlist).
- Session tab close buttons still retain `session-tab-close` custom class for the chat-rendering contract.
- Manual visual review of footer context menu, session tabs, sidebar nav across 5 themes.
- Command palette keyboard nav (`composer-contract.test.ts` checks `aria-modal`/search field).

**Verification:** JSX-DaisyUI scanner baseline shrinks noticeably; chat.css block 10/11 trimmed.

---

## Phase 4 — `chat.css` drain

These units pair with the corresponding Phase 3 caller migrations in the same PR so the source of truth moves to one place at once. Listed separately because they target the CSS layer.

### U16. Drain keyboard shortcuts help modal block

**Goal:** Move the all `orchid-shortcuts-help-*` block (lines 1847–2016, ~170 lines, no DaisyUI mixing) to `components.css` `@layer components` as `@apply` rules using semantic tokens, or migrate the markup to `DialogSurface` + primitive composition (`ShortcutBar`, `SectionHeader`, `Panel`) so the styling lives on primitives.

**Files:** `src/renderer/styles/chat.css`, `src/renderer/styles/components.css`, `src/renderer/components/ShortcutsHelp*` (whichever owns the help modal), `src/renderer/styles/README.md` (mention as approved exception case).

**Approach:** Prefer primitive composition over JS→CSS migration when feasible. If the markup is `<aside className="orchid-shortcuts-help-dialog">…`, rewrite to `<DialogSurface variant="overlay" panelClassName="orchid-shortcuts-help-dialog">…` and keep the residual CSS in `components.css` rather than `chat.css`.

**Test scenarios:** Manual visual identity across themes; `chat.css` line count drops ≥ 150.

**Verification:** `wc -l chat.css` ≤ baseline minus 150.

---

### U17. Drain config/settings + model picker chrome blocks

**Goal:** Move blocks 15 (config/settings, ~509 lines) and 16 (model picker chrome, ~285 lines, mixed `orchid-*`) to `components.css`. This pairs with Phase 3 U13 (Preferences) and U15-A (ModelPicker).

**Files:** `chat.css`, `components.css`, preferences and model picker feature files.

**Approach:** Migrate CSS into `orchid-config-tabs`, `orchid-config-card-*` (absorbed by `ConfigCard` primitive where markup allows), `orchid-model-picker-*` composites in `components.css` `@layer components`, using `@apply` and semantic tokens. Replace three `#000` fallback literals in `color-mix()` with a named tailwind/DaisyUI color (`var(--overlay-color)`) and document as an explicit exception if it must stay.

**Test scenarios:** Preferences dialog and ModelPicker match design across themes; non-token color scanner loses 3 baseline rows.

**Verification:** chat.css line count ≤ baseline minus 600+ after U13+U15+U17.

---

### U18. Drain session tabs, session list, side panel, panels blocks

**Goal:** Move blocks 10 (session tabs, ~164 lines, contains 11 raw `oklch(...)` literals), 12 (session list, ~349 lines), 7–8 (side/main panels and panel headers, ~180 lines), 13 (inspector rows, ~63 lines).

**Files:** `chat.css`, `components.css`, session/panel/sidebar feature files from U15-B.

**Approach:**
- Convert raw `oklch(var(--b2) / 0.55)` to `@apply bg-base-200/55` etc. — DaisyUI exposes base-* tokens with alpha variants via Tailwind. Replaces 11 non-token literals with 0 by end of unit.
- Tab/active row states become `orchid-session-tab` and `orchid-session-tab-active` composites in `components.css` `@layer components` (own the `--space-*` borders, gaps, hover).
- Sidebar `panel-header`/`panel-body`/`panel-footer` move to composites; `RightPanel`/`LeftPanel` `orgid-*` (already exists in `components.css`) absorbs them.

**Test scenarios:** All 5 themes render Sidebar/SessionTabs/SessionList identically pre/post. Non-token color scanner loses 11 baseline rows. chat.css shrinks ~750 lines.

**Verification:** chat.css line count ≤ baseline minus ~1400 cumulative.

---

### U19. Drain onboarding + provider wizard blocks

**Goal:** Move blocks 2 (onboarding overlay/container, ~166 lines) and 3 (provider wizard, ~74 lines) into `components.css` `orchid-onb-*` / `orchid-provider-wizard-*` composites or primitive composition (`DialogSurface variant="overlay"`). Pairs with U12.

**Files:** `chat.css`, `components.css`, `OnboardingScreen.tsx`, `ConnectionWizard.tsx`.

**Approach:** The onboarding overlay is a fullscreen `<DialogSurface variant="overlay" overlayClassName="orchid-onb-overlay" panelClassName="orchid-onb-container">`; the steps row uses DaisyUI `steps` (primitive `Steps` if added else approved in-line usage). Provider wizard is a `<DialogSurface variant="modal">` routed through existing primitives.

**Test scenarios:** First-run onboarding walkthrough + provider connection wizard render identical chrome across themes. chat.css drops 240 lines.

**Verification:** `wc -l chat.css` ≤ baseline minus ~1650 cumulative.

---

### U20. Drain residual blocks (context panel rows, markdown in assistant, compact badges, mock-aligned tools)

**Goal:** Finish closing chat.css. Move blocks 5 (chat footer), 6 (context panel rows), 4 (mock-aligned tooling — collapse, slash-menu, command-toast), 17 (`orchid-tool-block .badge` overrides), 18 (markdown content for assistant messages).

**Files:** `chat.css`, `components.css`, `markdown.css` (block 18 belongs here anyway), the feature files owning the offending classes.

**Approach:**
- Block 18 (markdown in assistant) belongs in `markdown.css` already per the contract — trivial move.
- Mock-aligned tool classes move into `components.css` `orchid-tool-block` and `orchid-slash-menu-*` where not already present.
- Compact badge rules become `StatusBadge` size override props or `@apply` rules in `components.css`.

**Test scenarios:** Markdown rendering snapshots unchanged; slash menu and command-toast visuals identical; chat.css at ≤ 400 lines.

**Verification:** `wc -l chat.css` ≤ 400. chat.css growth guard's baseline updated downward to ≤ 400.

---

## Phase 5 — Token discipline closeout

### U21. Build and enforce the non-token color scanner (final tightening)

**Goal:** After U18/U20 remove the remaining raw `oklch(...)` literals and `#000` fallbacks, drop the non-token color scanner baseline to empty and assert against regression.

**Dependencies:** U2 (scanner wired), U17, U18, U20.

**Files:** `tests/integration/renderer-style-contract.test.ts` — set `BASELINE_NON_TOKEN_COLORS = []`.

**Approach:**
- Once all known non-token color literals are migrated (11 oklch in session tabs + 3 #000 in model picker `color-mix`), the baseline becomes empty. The scanner fails on any new color literal.
- Document the four `:root` fallback tokens in `index.css` (lines 23–37) as the *only* allowed raw-color site; runtime theme files in `src/renderer/themes/*.css` join the same exclusion list the JSX-DaisyUI scanner already applies.
- Document an approved-exception allowlist for `color-mix(... var(--overlay-color) 55% transparent)` patterns where DaisyUI tailwind tokens can't express a layered overlay; otherwise route to Tailwind `/opacity` syntax.

**Test scenarios:**
- Any new `oklch(0.5 0.1 200)` added to `components.css` fails the test.
- Existing runtime theme files do not fail (in scanner exclusion list).

**Verification:** Baseline set empty; scanner strict.

---

### U22. Final contract README sync + audit narrator

**Goal:** Make the README describe the final state, including ownership matrix, chat.css size guarantee, non-token color rule, and a per-primitive owner table.

**Files:** `src/renderer/styles/README.md`, optionally `CONCEPTS.md` at repo root if domain vocabulary is helpful.

**Approach:**
- Add the **Ownership matrix** — one row per primitive in `components/ui/`, listing the DaisyUI roots it owns.
- Replace the existing *Approved exceptions* section with the final allowlist (currently: `textarea textarea-bordered` in `InputArea.tsx` per `composer-contract.test.ts`; or a deferred migration to a future `TextArea` primitive explicitly listed for a follow-up plan).
- Update the import graph comment in `index.css` to note chat.css has shrunk to ≤ 400 lines.

**Test scenarios:** `renderer-style-contract.test.ts` "Contract Documentation" assertions still match ("class selection", "approved exceptions", "DaisyUI", "orchid-", 5 theme names).

**Verification:** README current; no test drift.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Migrating a feature surfaces a regression missed by visual review (the contract tests are source-level grep, not visual). Add smoke screenshot tests for the 5 themes on at least one Preferences tab, Onboarding step, and ChatView after Phase 3 completes. | Defer to a follow-up plan; flag as a Deferred Question. |
| `StatusBadge` doesn't have a `ghost` variant but providers cluster uses `badge-ghost`. | Add `ghost` to `StatusBadgeTone` as a pre-step in U14 before migrating `ConnectionModelsDialog`. |
| `DialogSurface` lacks a `footer` slot but ConfigView uses `modal-action`. | Extend `DialogSurface` with a `footer?: ReactNode` slot as a pre-step in U15-C. |
| Baseline trimming could regress a feature silently if the scanner's root-set misses a DaisyUI variant. | Snapshot test: snapshot every feature file's DaisyUI roots *before* migration; scanner requires the union to never grow. Use the existing `RESERVED_MODIFIER_ROOTS` set so the audit root count is consistent. |
| `chat.css` drain could surface cascading dependencies (e.g. `config-card` rules enforced by the class's CSS cascade). | Move a block only when its feature's markup has already migrated to the primitive (`ConfigCard`), then verify via 5-theme visual smoke. |
| Phase 3/4 PRs are large and touch many files. | Each Phase 3 subgroup is independent and atomic; ship as one PR per subgroup with the chat.css block drain in the same PR. |
| Onboarding is first-run critical — visual regression could block first-run UX. | Manual review per theme across all 5 themes per U12 PR; pair with onboarding smoke tests where present. |

## Deferred Implementation Questions

1. **`TextArea` primitive** — `InputArea.tsx` uses `textarea textarea-bordered` and the composer contract enforces this. Out of scope for this plan; include in the baseline allowlist and open a follow-up plan once composer regression base is solid.
2. **`Steps` primitive** — only used in `OnboardingScreen.tsx` (and not by any other consumer). Either add a tiny `Steps` primitive in this plan or keep as inline DaisyUI usage with an explicit baseline allowlist for `steps`/`step` at `OnboardingScreen.tsx`. Recommendation: add the primitive if there's a second future consumer; otherwise baseline allowlist.
3. **`Progress` / `radial-progress`** — used in `Sidebar.tsx` (linear progress) and `Footer.tsx` (radial-progress mid-migration). Tiny primitive; easy to add. Recommendation: include as a Phase-2-extension unit if Footer migration reveals friction; otherwise allowlist `radial-progress` at `Footer.tsx` per its `orchid-footer-context-radial` composite.
4. **Visual regression** — the existing tests are source-grep contracts, not visual diffs. The plan relies on manual review during migration; a Playwright screenshot baseline is a separate, future effort (the repo already has Playwright available under `output/playwright/`).
5. **`PopoverList` consolidation** — `PopoverList` is the value-picker flavour; `DropdownMenu` (U11) is the content flavour. Folding one into the other is a refactor deferred to avoid churn during the standardization pass.

## Out of Scope

- New product features, new sidebar navigation concepts, topology redesign — all forbidden by README non-negotiable.
- New themes (the existing 5 are sufficient for this work).
- Removing the DaisyUI plugin or replacing its CSS primitives (`btn`, `input`, …) with own `@apply` rules en masse.
- A second styling library (CSS Modules, styled-components).
- Visual regression screenshot baselines (deferred — see Deferred Implementation Questions).

## System-Wide Impact

- `src/renderer/components/ui/` grows from 9 to ~20 primitive files (~2,000 new lines of typed components), each owning a single DaisyUI root family.
- Feature files remove ≈236 direct DaisyUI class hits; JSX body of typical feature shrinks.
- `chat.css` shrinks from 2,016 lines to ≤ 400 (≈ −1600 lines, ~80% reduction).
- `components.css` grows by the equivalent composites that absorb drained chat.css rules — net no growth because most drained rules become primitives (in TSX) not `@apply` `orchid-*` composites.
- `tests/integration/renderer-style-contract.test.ts` gains 3 new scanners, grows by ~250 lines.
- `src/renderer/styles/README.md` rewritten to reflect the new ownership model.
- No runtime behavior changes; no API surface changes; no IPC; no main-process changes.