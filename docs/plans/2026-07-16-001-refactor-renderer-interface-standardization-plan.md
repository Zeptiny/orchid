---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
title: "Renderer Interface Standardization with DaisyUI and Tailwind CSS"
date: 2026-07-16
plan_depth: deep
---

# Renderer Interface Standardization with DaisyUI and Tailwind CSS

## Goal Capsule

### Objective

Rework the Orchid Electron renderer into a maintainable, consistent interface built primarily from DaisyUI components and predefined Tailwind CSS utilities, with reusable React components and narrowly scoped custom CSS composites built with `@apply`.

The rework preserves the existing interface layout and information architecture: current shell, sidebars, session tabs, chat/composer center, settings, and onboarding structure remain as they are today. It preserves the five existing themes, keeps the flat chat presentation, uses DaisyUI for surrounding states, and includes correctness, accessibility, and interaction fixes whenever the affected component or flow is changed.

### Authority And Scope

1. The user-confirmed scope in this plan is authoritative: preserve the existing layout, preserve themes, preserve flat chat, use DaisyUI around chat, and include fixes in touched surfaces.
2. Existing renderer behavior and the contracts listed in this plan outrank visual convenience.
3. `electron/CLAUDE.md`, current renderer code, and existing renderer tests define repository conventions.
4. This plan does not read or depend on other interface plans.
5. Layout redesign is explicitly out of scope. Do not introduce a Focused Workspace shell, narrow global rail, workspace header redesign, contextual right inspector, workspace switcher redesign, or responsive drawer/overlay replacement of the current sidebars.

### Execution Profile

- Renderer-focused TypeScript/React refactor under `electron/src/renderer`.
- Renderer tests and the renderer build are in scope.
- Main-process, preload, shared IPC, persistence, and provider-domain changes are out of scope unless a touched renderer bug requires a narrowly related contract change.
- No production runtime dependency is required for the styling migration.
- A small renderer DOM-test harness is allowed as a development-only dependency if the existing Node/source tests cannot prove a primitive's interaction contract.

### Stop Conditions

The work is not complete while any of the following remains true:

- New or migrated static UI uses arbitrary Tailwind values where a predefined utility or approved composite would work.
- Custom CSS redefines DaisyUI reserved component selectors such as `.btn`, `.input`, `.alert`, `.modal`, or `.badge`.
- A theme, streaming state, keyboard flow, modal flow, session flow, or accessibility contract regresses.
- The existing shell layout, sidebar placement, session navigation structure, or chat/composer arrangement is redesigned rather than restyled in place.
- Legacy CSS is retained without an active consumer, documented exception, or test coverage.
- A touched high-confidence renderer correctness issue is knowingly left broken without an explicit deferral in the implementation notes.

### Tail Ownership

The implementation executor owns the implementation, test, cleanup, and browser-validation tail. The plan remains a decision and verification contract; it does not track execution progress.

## Product Contract

### Summary

Orchid's renderer currently combines DaisyUI, Tailwind utilities, arbitrary values, inline presentation styles, legacy semantic selectors, and a roughly 4,940-line global stylesheet. The rework establishes one styling contract and a small reusable component vocabulary without changing the product's chat, session, settings, onboarding, theme behavior, or interface layout.

### Problem Frame

The renderer has enough existing UI to make inconsistent styling expensive. Shared controls are implemented repeatedly, visual rules are split between JSX and `chat.css`, theme variables are duplicated across application tokens and DaisyUI tokens, and custom selectors overlap DaisyUI names. The lack of an `@apply` convention means each feature invents its own CSS boundary. The result is harder to scan, harder to change safely, and difficult to verify across five themes.

The immediate trigger is the current renderer audit surface: a roughly 4,940-line global `chat.css` mixes active and legacy rules, arbitrary/static values, inline presentation styles, and custom selectors that compete with DaisyUI. A targeted cleanup of a few controls would improve isolated files but would leave the global source of drift and allow the next feature to recreate it. This migration is therefore justified as a bounded renderer-wide contract change whose delivery outcome is that future UI work has one reviewable class decision path, shared behavior has one typed owner, and the existing five-theme behavior can be verified by the same repeatable matrix.

The migration must improve the structure without treating the renderer as a static page and without redesigning the shell. Chat streaming, session switching, keyboard navigation, focus traps, dynamic dimensions, runtime swatches, and provider/configuration gates are behavior-bearing surfaces and must remain stable while their presentation changes. Existing panel placement, sidebar structure, session tabs, and navigation topology stay in place; only classes, shared primitives, tokens, and presentation implementation move.

### Requirements

- R1. Predefined utility default: static layout, spacing, sizing, typography, border, color, and responsive styling uses predefined Tailwind utilities or DaisyUI classes.
- R2. Arbitrary-value discipline: arbitrary utilities in JSX are removed wherever a predefined utility or approved semantic composite can express the same intent. Remaining exceptions are listed, justified, and tested.
- R3. DaisyUI surrounding states: buttons, fields, alerts, badges, loading indicators, collapses, modals, tabs, steps, status indicators, dropdowns, and tables use DaisyUI classes where the component semantics fit.
- R4. Flat chat presentation: user and assistant messages remain flat rows using the existing message model; DaisyUI `chat` and `chat-bubble` classes are not introduced for message bodies.
- R5. Reusable React boundaries: repeated behavior or repeated semantic UI is extracted into typed React components. Simple one-off markup remains local rather than being hidden behind generic wrappers.
- R6. `@apply` composites: repeated visual composites use namespaced `orchid-*` classes in a shared CSS component layer and compose predefined utilities with `@apply`. DaisyUI primitives remain visible in JSX unless a composite genuinely owns their repeated contract.
- R7. Theme preservation: `default`, `solarized-light`, `bluey`, `windows-xp`, and `green-terminal` remain selectable, loadable, visually coherent, and compatible with the current runtime stylesheet switching behavior.
- R8. Token consistency: migrated CSS uses DaisyUI semantic tokens such as `base-100`, `base-200`, `base-300`, `base-content`, `primary`, `info`, `success`, `warning`, and `error`. App-specific variables remain only where the DaisyUI token set cannot express a product-specific state.
- R9. Behavior preservation: chat ordering, streaming, auto-scroll, tool grouping, markdown safety, session tabs, workspace/session navigation, composer keyboard behavior, provider/model gates, settings save flows, onboarding persistence, focus traps, and overlay dismissal retain their existing contracts.
- R10. Touched-flow correctness: when a migrated component exposes a known high-confidence renderer bug, the implementation fixes it in the same unit and adds regression coverage. This includes verifying the shared session-store contract and removing duplicate local ownership if it is present, plus composer send/cancel recovery, stream failure/scroll handling, zero-valued preference fields, and dead command-palette navigation where those surfaces are touched.
- R11. Accessibility and layout quality: interactive elements retain semantic HTML, accessible names, focus-visible states, keyboard support, `aria-expanded`/`aria-controls` relationships, dialog semantics, and stable dimensions without text overlap or panel overflow.
- R12. Verification and cleanup: the renderer typechecks, lints, builds, passes targeted tests and the full test command, passes a five-theme browser smoke matrix, and contains no unowned legacy CSS.
- R13. Scope control: the migration does not add unrelated product features, replace the theme loader, redesign the domain model, change main-process behavior, or redesign the interface layout/information architecture.
- R14. Existing layout preservation: the current shell topology remains the default. Existing sidebars, session tabs, chat/composer center, settings, onboarding, and overlay placement are restyled in place rather than restructured into a new shell pattern.
- R15. Existing session navigation continuity: the current session sidebar information architecture remains available in its existing placement and interaction model, including search, project grouping, pinned/recent sessions, drafts, activity indicators, and session actions where those already exist.
- R16. Restrained visual polish: the interface uses clear hierarchy, typography, compact controls, deliberate whitespace, subtle borders, and state-led surfaces without turning chat messages into cards, introducing marketing-style decoration, or inventing a new layout hierarchy.

### Actors

- A1. Orchid user: switches themes, opens sessions, chats, inspects tools, changes settings, and completes onboarding.
- A2. Renderer maintainer: adds or changes UI without inventing a new styling convention for each feature.
- A3. Implementation and review agent: migrates a bounded feature area, proves behavior, and removes obsolete presentation code.

### Key Flows

- F1. Theme and shell: the app loads one of the five themes, renders the existing shell and sidebars, and keeps the main pane usable.
- F2. Session navigation: the user uses the existing session tabs and sidebar surfaces to search, create, select, rename, close, delete, or switch between sessions and project groups without losing the active draft or loading stale state.
- F3. Chat turn: the user sends a message, sees streaming content and thought/tool activity, scrolls intentionally, cancels or interrupts, and receives success or failure feedback.
- F4. Composer and discovery: the user uses the textarea, slash menu, command palette, model picker, shortcuts help, and provider/workspace/model gates with keyboard and pointer input.
- F5. Settings and providers: the user edits configuration tabs, provider connections, model assignments, RAG settings, MCP settings, and unsaved-change dialogs.
- F6. Onboarding and overlays: the user completes or skips onboarding, opens provider dialogs, uses modal surfaces, and can dismiss or navigate them without focus escaping unexpectedly.

### Acceptance Examples

- AE1. Given any supported theme, when the shell, sidebar, chat, settings, and onboarding surfaces render, semantic colors and content remain legible and no surface falls back to an unrelated theme.
- AE2. Given a streaming turn, when new content, thought blocks, tool blocks, usage, or interruption state arrives, the flat message presentation and activity grouping remain intact and committed history is not rebuilt unnecessarily.
- AE3. Given the user has scrolled more than the existing threshold away from the bottom, when streaming content changes, the viewport does not force the user back to the bottom; at the threshold, existing auto-scroll behavior remains unchanged.
- AE4. Given settings is opened while chat is mounted, when a session or draft is selected, renamed, created, deleted, or rebound, the visible chat state reflects the same session source rather than a second stale hook instance.
- AE5. Given a composer send is blocked by workspace, provider, or model readiness, when the gate returns early, the composer recovers its send lock and remains usable without a reload.
- AE6. Given an IPC send or cancel operation fails or races with an interrupt, when the error resolves, optimistic state and controls return to a consistent state and the user can send again.
- AE7. Given a modal, picker, command palette, or collapse is open, when the user uses Escape, Tab, Enter, click-outside, or an icon-only action, focus, dismissal, and accessible state follow the existing contract.
- AE8. Given a preference field accepts zero, when the user enters zero and saves, the value is retained rather than rejected or snapped back because of truthiness checks.
- AE9. Given a static class or style is migrated, when the style-contract tests scan it, arbitrary values and reserved DaisyUI selector overrides are rejected unless the path and reason are listed as an approved exception.
- AE10. Given a viewport narrower than the normal desktop layout, when sidebars collapse or content grows, text wraps or truncates within its parent and no fixed control overlaps adjacent content.
- AE11. Given the existing shell, when sidebars, session tabs, chat, and composer are restyled, their relative placement and existing expand/collapse or visibility behavior remain unchanged.
- AE12. Given the existing session sidebar, when the user searches, groups, pins, creates, renames, closes, deletes, or selects a session, the same information and actions remain available in the current structure and stay synchronized with tabs and chat state.

### Success Criteria

- Static renderer presentation follows the class-selection and CSS-exception contract described in the Planning Contract.
- Shared controls and repeated surface patterns have one typed implementation instead of feature-local copies.
- `chat.css` is reduced to an aggregator or removed after all consumers and source-structure tests move to the new style layers.
- All five themes pass the same shell, chat, settings, onboarding, and overlay smoke matrix.
- The existing interface layout and session/sidebar information architecture remain intact; only presentation implementation and shared primitives change.
- High-confidence touched-flow correctness fixes are covered by tests and are not hidden in styling-only changes.
- A new maintainer can determine where to add a DaisyUI class, a Tailwind utility, a reusable component, or an exception without reading the entire stylesheet.

### Scope Boundaries

In scope:

- Renderer JSX structure only as needed to restyle existing surfaces, renderer hooks where required by touched-flow correctness, renderer styles, themes, component extraction, and renderer-focused tests.
- Standardized visual treatment for the current chat, shell, sidebars, composer, pickers, overlays, settings, providers, and onboarding surfaces.
- Accessibility and responsive fixes directly associated with migrated surfaces, without inventing a new shell topology.
- High-confidence renderer correctness fixes exposed by migrated components.

Out of scope:

- Main-process, preload, provider-driver, persistence, IPC schema, or shared-domain redesign.
- Replacing the current five-theme runtime loader with a different theme-management product.
- Introducing DaisyUI chat bubbles or changing conversation information architecture.
- Any interface layout redesign, including Focused Workspace, narrow global rail, workspace header redesign, contextual right inspector, new workspace switcher/manager mode, or replacing current sidebars with drawer/overlay navigation patterns.
- A new design language or information architecture beyond restrained visual polish of the existing surfaces.
- A broad rewrite of every renderer hook or a general state-management migration unrelated to touched-flow correctness.

### Dependencies

- Tailwind CSS 4.3.2, `@tailwindcss/vite`, and DaisyUI 5.6.16 remain the styling toolchain.
- React 19 and the existing Vite/TypeScript pipeline remain unchanged.
- Existing theme files and `applyTheme()` behavior remain available during migration.
- Existing Vitest suites and source/CSS contract tests remain the primary test infrastructure.
- Browser smoke validation must run against the renderer dev server or the packaged Electron renderer using the repository's available browser tooling.

### Outstanding Questions

No blocking questions remain. The following are explicitly deferred:

- Migrating runtime-loaded custom themes into compile-time `@plugin "daisyui/theme"` blocks can be evaluated after this migration once visual parity is proven.
- Any product-specific visual redesign or interface layout change, including Focused Workspace or other shell redesigns, requires a separate product decision and plan.
- Further product-specific visual redesign beyond the restrained flat-chat baseline requires a separate product decision and plan.

### Sources And Research

- Current renderer structure and conventions: `electron/CLAUDE.md`, `electron/src/renderer/App.tsx`, `electron/src/renderer/components/ChatView.tsx`, `electron/src/renderer/components/ChatStream.tsx`, `electron/src/renderer/components/LeftSidebar.tsx`, `electron/src/renderer/components/Sidebar.tsx`, `electron/src/renderer/components/ConfigView.tsx`, and `electron/src/renderer/components/Onboarding/OnboardingScreen.tsx`.
- Current styling and theme surface: `electron/src/renderer/styles/index.css`, `electron/src/renderer/styles/chat.css`, and `electron/src/renderer/themes/*.css`.
- Current behavior and source-contract tests: `electron/tests/integration/app-shell.test.ts`, `electron/tests/integration/architecture-validation.test.ts`, `electron/tests/integration/chat-sidebar.test.ts`, `electron/tests/integration/preferences-onboarding.test.ts`, `electron/tests/integration/provider-onboarding.test.ts`, and the renderer unit tests.
- Current renderer audit: `docs/code-review-reports/full-audit-2026-07-16/S5-renderer-ui.md`.
- Window constraints for responsive validation: `electron/src/main/index.ts` defines a 1200x800 default window with an 800x600 minimum.
- No applicable renderer-specific institutional learning was found in `docs/solutions/`.
- Tailwind CSS documents `@apply` for inlining existing utilities into custom CSS: [Tailwind functions and directives](https://tailwindcss.com/docs/functions-and-directives).
- Tailwind CSS documents `@theme` variables as the API for project design tokens: [Tailwind theme variables](https://tailwindcss.com/docs/theme).
- DaisyUI documents custom themes, `data-theme`, semantic color variables, component size tokens, and theme configuration: [DaisyUI themes](https://daisyui.com/docs/themes/), [DaisyUI config](https://daisyui.com/docs/config/), and [DaisyUI 5 release notes](https://daisyui.com/docs/v5/).

## Planning Contract

### Key Technical Decisions

- KTD1. Use an incremental strangler migration rather than replacing the renderer or stylesheet in one pass. This keeps each feature area buildable and makes visual and behavioral regressions attributable.
- KTD2. Keep DaisyUI component classes explicit in JSX for recognizable controls and states. Use predefined Tailwind utilities for layout and local composition. Do not create a generic React wrapper around every `btn`, `input`, or `badge`.
- KTD3. Create a small `components/ui` vocabulary only for repeated semantics or behavior: icon-only buttons, panels, section headers, state rows, fields, dialog surfaces, and picker/list surfaces. Feature components continue to own domain state and IPC orchestration.
- KTD4. Create namespaced `orchid-*` CSS composites in a shared component layer. Each composite uses `@apply` for predefined utilities and may use semantic DaisyUI colors. Do not define custom selectors with DaisyUI names or use raw color values in feature CSS.
- KTD5. (session-settled: user-directed; rejected alternative: replace the runtime loader with compile-time-only theme blocks.) Preserve the five theme files and runtime stylesheet swap during this migration. Normalize migrated UI toward DaisyUI semantic tokens and retain app-specific variables only for message-specific or renderer-specific states that cannot be represented by DaisyUI tokens. Do not introduce compile-time theme generation in the first pass.
- KTD6. (session-settled: user-directed; rejected alternative: use `chat` or `chat-bubble` for message rows.) Keep the flat message presentation. Use DaisyUI for alerts, badges, status indicators, loading states, collapses, dialogs, tables, tabs, and form surfaces around the conversation, but do not use `chat` or `chat-bubble` for message bodies.
- KTD7. Treat dynamic values as data, not static presentation. Runtime grid widths, textarea height, progress fractions, swatches, and viewport offsets may use inline CSS variables or styles when required; the exception must be isolated, named, and documented.
- KTD8. Standardize spacing and sizing by choosing the nearest predefined utility rather than preserving exact legacy pixel values. For example, use `mt-1`, `p-2`, `gap-2`, `text-xs`, `rounded-sm`, `w-64`, or `h-8` instead of bracket values. If exact geometry is behavior-critical, use a named composite or a dynamic CSS variable exception.
- KTD9. (session-settled: user-directed; rejected alternative: defer affected-component correctness fixes to a separate initiative.) Fix high-confidence renderer correctness issues in touched flows. The initial fix set includes verifying the shared session-store ownership between chat and settings and removing any duplicate local path if present, plus composer send-lock recovery, cancel/send failure cleanup, stream auto-scroll and buffered-tail behavior, zero-valued preference fields, and dead command-palette navigation when those surfaces are migrated.
- KTD10. Add targeted renderer DOM tests for reusable interactive primitives if existing Node/source tests cannot prove their contract. Keep pure transformation and keyboard logic in the existing Vitest style. Do not make full end-to-end DOM rendering a prerequisite for every presentational class change.
- KTD11. Keep `styles/index.css` as the canonical renderer stylesheet entry point and split concerns into shared component, markdown, and exception layers only after the build confirms Tailwind/DaisyUI processing order. Keep a temporary compatibility import while source-based tests and consumers are migrated.
- KTD12. Do not add a class-composition dependency solely for this migration. Use typed props and small local composition helpers; add a dependency only if repeated conditional class logic becomes a measurable maintainability problem.
- KTD13. (session-settled: user-directed; rejected alternative: adopt Focused Workspace or another shell redesign.) Preserve the existing interface layout and information architecture. Restyle the current shell, sidebars, session tabs, chat/composer center, settings, and overlays in place. Do not introduce a narrow global rail, workspace header redesign, contextual right inspector, workspace-manager mode, or drawer/overlay replacement of current sidebars as part of this plan.
- KTD14. Keep existing workspace and session navigation ownership as currently implemented, except where touched-flow correctness requires unifying duplicate session-store consumers. Do not invent new outer/inner scope UI surfaces during this migration.

### Visual Direction

The visual direction is restrained polish of the existing desktop shell, not a marketing surface, card dashboard, or new workbench topology. Design rules:

- Preserve the current shell hierarchy and panel placement. Styling migration must not invent a new navigation model.
- Persistent chrome, sidebars, tabs, chat, and composer keep their existing roles and relative structure.
- Modern visual polish comes from hierarchy, spacing, typography, semantic states, focus treatment, and restrained motion. Do not use gradients, decorative blobs, oversized hero treatment, or nested card stacks.
- Prefer nearest predefined utilities for spacing and sizing, but do not change expand/collapse behavior, panel ownership, or navigation topology to make styling easier.
- At 800x600, preserve current responsive behavior of the existing shell. Fix overflow/clipping introduced by restyling, but do not replace the current layout with a new overlay/drawer system unless that behavior already exists and is only being restyled.

### Styling Contract

#### Class selection order

1. Use a DaisyUI component class when the element has a matching component semantic: `btn`, `input`, `select`, `textarea`, `alert`, `badge`, `status`, `loading`, `collapse`, `modal`, `tabs`, `steps`, `dropdown`, `table`, `fieldset`, `card`, `kbd`, or `tooltip`.
2. Use predefined Tailwind utilities for layout and composition: `flex`, `grid`, `min-h-0`, `min-w-0`, `overflow-hidden`, `gap-2`, `p-3`, `text-sm`, `font-medium`, `truncate`, responsive grid utilities, and standard width/height utilities.
3. Use an `orchid-*` composite when the same set of utilities and state rules appears in multiple features or represents a product-specific surface contract.
4. Use custom declarations only for a documented exception or a CSS feature that cannot be expressed by the first three choices.

#### Ownership and precedence matrix

| Surface need | Primary owner | Use when | Example and boundary |
| --- | --- | --- | --- |
| Recognizable control or state semantics | DaisyUI classes in JSX | DaisyUI has a matching component contract and the markup is local or feature-specific | `btn`, `alert`, `badge`, `loading`, `modal`, `tabs`, `steps`, `input`, `select`, `kbd`; keep the DaisyUI class visible rather than hiding it in a generic wrapper. |
| One-off static geometry | Tailwind utilities in JSX | Layout, spacing, sizing, typography, and responsive composition are local and do not encode repeated behavior | `flex`, `min-h-0`, `gap-2`, `p-3`, `text-sm`, `w-64`; do not create CSS for a single use. |
| Repeated product-specific geometry or visual state | `orchid-*` CSS composite | At least two current consumers share the contract, or one surface has a behavior-critical product layout that must be centrally constrained | `.orchid-panel`, `.orchid-state-message`, or `.orchid-dialog`; define in `@layer components` with `@apply` and semantic tokens. |
| Repeated interaction semantics | Typed React primitive | At least two consumers share focus, keyboard, disclosure, loading, or accessible-name behavior | `IconButton`, `DialogSurface`, `PopoverList`, or `FormField`; the primitive owns markup/local interaction but not domain hooks or IPC. |
| Domain-specific one-off surface | Feature component | The markup or state orchestration has one clear owner and no reusable contract | Keep session, provider, chat, and preference decisions in their feature component while applying the matrix above. |
| Runtime or browser-only behavior | Exception layer or narrow inline value | A value is derived from state, emitted by Markdown/highlighting, or proven necessary by browser behavior | CSS variables for grid columns, runtime textarea height, dynamic swatches, Markdown selectors, scrollbars, and keyframes; document every exception. |

When multiple rows appear applicable, choose the first matching owner from top to bottom, then apply the lower-level choices inside that owner. A React primitive does not replace DaisyUI semantics; it standardizes the markup and behavior that expose them. A composite does not become a generic wrapper merely because it uses `@apply`.

#### Required rules

- Prefer DaisyUI semantic colors over app-specific color variables in new component markup.
- Prefer `rounded-sm`, `rounded-md`, `rounded-box`, `rounded-field`, or `rounded-none` over arbitrary radius values.
- Prefer standard spacing and text scale classes over arbitrary values.
- Keep icon-only actions as `IconButton` or a native `button` with `btn-square`/`btn-circle`, an accessible name, and a tooltip for unfamiliar actions.
- Keep text-bearing commands as text or icon-plus-text buttons; do not replace clear commands with unexplained icons.
- Keep dynamic style values in CSS custom properties or inline styles at the narrowest component boundary.
- Keep new shared and feature composites prefixed with `orchid-`; temporary legacy selectors are allowed only inside the documented compatibility bridge while their consumers are migrated.
- Never silently add a raw hex, RGB, hard-coded shadow, or hard-coded spacing value to migrated feature CSS.
- Do not use CSS Modules or introduce a second styling library.
- Do not restructure shell panels, navigation ownership, or information architecture as a styling convenience.

#### Approved exceptions

| Exception | Allowed location | Required treatment |
| --- | --- | --- |
| Theme variables and `color-scheme` | `electron/src/renderer/themes/*.css` | Define DaisyUI `--color-*` variables and only the app-specific variables still consumed by the renderer. |
| Markdown and syntax highlighting | `electron/src/renderer/styles/markdown.css` | Keep nested element/token selectors because React Markdown emits semantic elements and highlight classes. Use semantic theme variables. |
| Scrollbars | global exception layer | Keep browser-specific selectors; use theme variables and avoid feature-specific copies. |
| Animations and streaming cursor | exception layer | Keep keyframes and pseudo-elements when utility classes cannot express the behavior. |
| Runtime layout dimensions | `ChatView.tsx`, related shell style | Set CSS custom properties or inline values from state; keep static structure in classes. Preserve existing grid/panel topology. |
| Runtime textarea height | `InputArea.tsx` | Keep the existing resize behavior; do not encode generated pixel heights as static utility classes. |
| Runtime swatches and progress values | `ContextGrid.tsx`, `Footer.tsx`, `CommandPalette.tsx` | Keep dynamic colors/fractions as data; use classes for the surrounding geometry. |
| Focus and modal browser quirks | focused exception selectors | Keep only after a browser smoke test demonstrates the utility/DaisyUI equivalent is insufficient. |

Every exception must have a short comment or an entry in `electron/src/renderer/styles/README.md` explaining why a predefined class cannot replace it.

### Proposed Style Layer Structure

- `electron/src/renderer/styles/index.css`: Tailwind import, DaisyUI plugin configuration, global document/root rules, canonical imports, and global reset rules that are still required.
- `electron/src/renderer/styles/components.css`: `@layer components` composites using `@apply` and semantic DaisyUI tokens. All selectors are namespaced and reusable.
- `electron/src/renderer/styles/markdown.css`: Markdown element defaults, GFM lists/tables/task lists, code blocks, links, and syntax-token colors.
- `electron/src/renderer/styles/exceptions.css`: scrollbars, keyframes, streaming cursor, dynamic-layout hooks, and browser-specific exceptions with comments.
- `electron/src/renderer/styles/README.md`: the renderer styling contract, approved exception list, naming rules, and migration examples for future maintainers.
- `electron/src/renderer/styles/chat.css`: temporary compatibility aggregator during migration, then removed or reduced to a documented import bridge before final cleanup.

### Reusable Component Boundaries

The following are recommended starting points, not a mandate to extract every wrapper:

- `components/ui/IconButton.tsx`: icon-only button with accessible label, tooltip metadata, size/variant props, and disabled/loading state.
- `components/ui/Panel.tsx`: repeated bordered surface with optional header/footer slots; does not nest cards by default.
- `components/ui/SectionHeader.tsx`: title, optional count/status, disclosure state, and actions.
- `components/ui/StatusBadge.tsx`: maps domain status to DaisyUI badge/status classes without leaking color decisions into feature markup.
- `components/ui/StateMessage.tsx`: loading, empty, warning, and error states with consistent layout and action slots.
- `components/ui/FormField.tsx`: label, control, hint, error, and description structure for settings and wizards.
- `components/ui/DialogSurface.tsx`: modal shell, title/description/action regions, focus-trap integration, and consistent close behavior.
- `components/ui/PopoverList.tsx`: shared searchable/listbox surface used by `ModelPicker`, `SearchableOptionPicker`, command results, and similar menus where behavior matches.
- `components/ui/ShortcutBar.tsx`: repeated keyboard hint layout using `Keycaps`.

These components must remain presentational or behavior-local. They must not import `useChat`, `useSession`, provider hooks, or IPC APIs.

### High-Level Design

The target topology preserves the existing application structure:

```text
App
|-- Theme application and onboarding gate
|-- Existing shell
|   |-- Existing left sidebar / session navigation
|   |-- Existing session tabs and session controls
|   |-- Main pane
|   |   |-- Flat ChatStream and activity surfaces
|   |   |-- InputArea/composer
|   |   `-- Footer/context usage
|   `-- Existing right/context surfaces if present today
|-- Shared overlays
|   |-- Command palette
|   |-- Shortcuts help
|   |-- Pickers
|   `-- Dialog surfaces
|-- ConfigView and preference tabs
`-- Onboarding and provider wizard
```

The existing hooks remain the source of domain state. Component extraction moves markup, class selection, and local interaction behavior behind typed props. The shared session store remains the source for chat and settings consumers. State ownership changes only where the touched-flow correctness contract requires it, especially the current dual `useSession()` problem between chat and settings. Shell topology and navigation ownership are not redesigned.

### Sequencing

1. Freeze class and behavior contracts with baseline tests.
2. Establish theme/token and CSS-layer foundations.
3. Add shared UI primitives and dialog/picker surfaces.
4. Migrate the existing shell, sidebars, and session ownership correctness without changing layout topology.
5. Migrate chat and activity surfaces while preserving flat messages and stream memoization.
6. Migrate composer, footer, pickers, and command interactions.
7. Migrate configuration, providers, onboarding, and touched-flow correctness fixes.
8. Remove legacy CSS, run the full contract audit, and complete browser/theme validation.

#### Pilot checkpoint before renderer-wide expansion

After U1-U4, pause before migrating U5-U7 and validate a representative slice consisting of the canonical CSS layers, shared primitives, one shell/sidebar state, the command palette, and the model picker. The pilot passes only when the following are true:

- The renderer typechecks, lints, and builds with no newly introduced style-contract violations.
- `default`, `solarized-light`, `bluey`, `windows-xp`, and `green-terminal` render the pilot at 1200x800 and 800x600 without unreadable semantic states, clipped controls, or overlap.
- Keyboard focus, Escape dismissal, picker selection, sidebar disclosure, and dialog/popover boundaries pass their targeted tests and smoke checks.
- The existing shell layout remains recognizably the same: panel placement, navigation ownership, and expand/collapse behavior are unchanged.
- The compatibility bridge still contains every unmigrated consumer, and no legacy selector is deleted without its consumer inventory being updated.

If a pilot criterion fails, correct the contract or shared primitive before expanding the migration; do not compensate with feature-local arbitrary values or a layout redesign.

### Risks And Mitigations

- Risk: removing legacy selectors breaks source-structure tests or a hidden consumer. Mitigation: inventory consumers, migrate one area at a time, keep the compatibility aggregator temporarily, and update tests with each move.
- Risk: DaisyUI defaults fight the existing five themes. Mitigation: preserve the current theme loader, normalize semantic tokens first, and compare every theme before deleting app-specific variables.
- Risk: `@apply` hides important component behavior or fails because a plugin-generated class is not available in a split stylesheet. Mitigation: keep DaisyUI primitives explicit in JSX, validate each stylesheet through `npm run build:renderer`, and use `@reference` or the canonical stylesheet import only where required.
- Risk: ChatStream changes cause streaming jank or scroll regressions. Mitigation: preserve the history/live-tail split, existing pure helpers, scroll threshold, and targeted architecture tests; restyle the chat path after surrounding surfaces are stable.
- Risk: component extraction changes hook ownership and creates stale session state. Mitigation: define one session source for chat/settings, add a regression test before deleting the duplicate hook instance, and keep App's mounted ChatView behavior.
- Risk: visual standardization expands into a product or layout redesign. Mitigation: preserve the existing shell topology, restyle in place, and defer any Focused Workspace or other layout redesign to a separate plan.
- Risk: no existing renderer DOM-test harness leaves interaction regressions unproven. Mitigation: add targeted jsdom/React tests for shared interactive primitives only where pure/source tests cannot prove focus, keyboard, or dismissal behavior.

### System-Wide Impact

- Styling changes affect every renderer route because `index.css`, `chat.css`, and runtime theme links are global.
- Component extraction affects keyboard/focus behavior because command palette, pickers, dialogs, session rows, and onboarding have independent focus management.
- Session ownership and touched-flow fixes affect the relationship between `App`, `ChatView`, `ConfigView`, and `useSession`, but not the IPC contract.
- Stream rendering changes affect render frequency, auto-scroll, message grouping, markdown parsing, and tool activity; the implementation must preserve existing memoization boundaries.
- Source-based tests currently encode CSS filenames and selectors. They must be migrated alongside the stylesheet split rather than removed without replacement.
- Layout topology is intentionally unchanged; visual diffs should reflect class/token/control polish, not a new shell.

### Assumptions

- The closest predefined Tailwind spacing or sizing utility is preferable to exact legacy pixels when the exact value is not behavior-critical.
- Existing theme aesthetics are valuable even where they are stylistically different; the first migration optimizes consistency and maintainability without flattening each theme into the same palette.
- New reusable components should be added only after at least two consumers or one repeated behavior contract is identified.
- Browser QA can use the repository's available browser tooling or an equivalent manual Electron smoke run; the plan does not require a new production browser runtime.
- The current interface layout is the accepted product shell for this migration; layout redesign is a separate product decision.

## Implementation Units

### U1. Establish the renderer styling and behavior contract

**Goal:** Create the guardrails and baseline inventory that let later units remove arbitrary classes and legacy CSS without losing behavior.

**Requirements:** R1, R2, R8, R9, R12, R14.

**Dependencies:** None. This baseline unit must establish the contract before migration units begin.

**Files:**

- `electron/src/renderer/styles/index.css`
- `electron/src/renderer/styles/chat.css`
- `electron/src/renderer/components/**/*.tsx`
- `electron/tests/integration/app-shell.test.ts`
- `electron/tests/integration/chat-sidebar.test.ts`
- `electron/tests/integration/preferences-onboarding.test.ts`
- `electron/tests/integration/provider-onboarding.test.ts`
- New `electron/tests/integration/renderer-style-contract.test.ts`
- New `electron/src/renderer/styles/README.md`

**Approach:**

- Inventory static `className` strings, arbitrary utilities, inline styles, custom selectors, DaisyUI selector overrides, and CSS files before changing them.
- Define the approved exception paths and the reserved DaisyUI selector list in the style contract document and test helper.
- Make the contract test inspect class-bearing source rather than all bracket characters in TypeScript, avoiding false positives from arrays, generics, and indexed access.
- Add assertions that new feature CSS uses semantic tokens and that reserved DaisyUI classes are not redefined. During migration, record existing violations as an explicit baseline and fail on newly introduced violations; the zero-violation gate becomes mandatory after U8 cleanup.
- Record the current five theme names, current dynamic style exceptions, and existing shell layout preservation as compatibility requirements.

**Test scenarios:**

- Static class strings containing arbitrary utilities fail unless their file and class are explicitly approved.
- A dynamic runtime style in an approved component is not treated as a static class violation.
- CSS selectors named after DaisyUI components are rejected when they are custom redefinitions rather than usage or scoped overrides.
- All five theme names remain present in the theme registry and source files.

**Verification:** Run the new contract test, the existing CSS/source structure tests, and `cd electron && npm run build:renderer` before proceeding.

### U2. Establish theme tokens and canonical CSS layers

**Goal:** Replace the current mixed global style surface with a canonical stylesheet entry point and namespaced `@apply` composites while preserving runtime theme switching.

**Requirements:** R1, R2, R3, R6, R7, R8, R12.

**Dependencies:** U1. The style contract and baseline inventory must exist before CSS layers are split.

**Files:**

- `electron/src/renderer/main.tsx`
- `electron/src/renderer/App.tsx`
- `electron/src/renderer/styles/index.css`
- New `electron/src/renderer/styles/components.css`
- New `electron/src/renderer/styles/markdown.css`
- New `electron/src/renderer/styles/exceptions.css`
- `electron/src/renderer/styles/chat.css`
- `electron/src/renderer/themes/index.ts`
- `electron/src/renderer/themes/default.css`
- `electron/src/renderer/themes/bluey.css`
- `electron/src/renderer/themes/green-terminal.css`
- `electron/src/renderer/themes/solarized-light.css`
- `electron/src/renderer/themes/windows-xp.css`
- `electron/tests/integration/app-shell.test.ts`
- `electron/tests/integration/renderer-style-contract.test.ts`

**Approach:**

- Keep Tailwind and DaisyUI plugin setup in `index.css` and make it the only canonical renderer stylesheet entry point after import-order validation.
- Move global root/reset rules into `index.css`, repeated visual composites into `components.css`, Markdown/highlighting rules into `markdown.css`, and scrollbars/animations/dynamic hooks into `exceptions.css`.
- Use `@layer components` and `@apply` for stable `orchid-*` composites. Keep DaisyUI classes explicit in component markup when the component behavior is recognizable.
- Rename or remove custom `.btn`, `.btn-primary`, `.btn-ghost`, and related legacy rules instead of allowing them to compete with DaisyUI selectors.
- Normalize new and migrated styles to `--color-*` DaisyUI tokens. Keep app-specific variables only after confirming active consumers.
- Preserve `applyTheme()`, document-level `data-theme`, one active stylesheet link, persistence, and live theme changes. Do not migrate the five runtime theme files into compile-time DaisyUI theme blocks in this unit.
- Keep `chat.css` as a temporary compatibility bridge until all source tests and imports point at the new layers; remove it or reduce it to a documented bridge in U8.

**Test scenarios:**

- Renderer build succeeds with the split CSS files and any required `@reference` directives.
- Every theme changes the document attribute and active stylesheet link as before.
- Semantic color utilities resolve in dark, light, retro, and terminal themes without raw palette declarations in feature CSS.
- `@apply` composites compile and do not create a second reserved DaisyUI component implementation.

**Verification:** Run the theme/source tests, `npm run typecheck`, `npm run lint`, and `npm run build:renderer`.

### U3. Add reusable UI primitives and shared overlay surfaces

**Goal:** Establish a small typed component vocabulary for repeated controls, surfaces, states, dialogs, and pickers.

**Requirements:** R3, R5, R6, R10, R11.

**Dependencies:** U1 and U2. Primitives consume the established style layers and are checked by the baseline contract.

**Files:**

- New `electron/src/renderer/components/ui/IconButton.tsx`
- New `electron/src/renderer/components/ui/Panel.tsx`
- New `electron/src/renderer/components/ui/SectionHeader.tsx`
- New `electron/src/renderer/components/ui/StatusBadge.tsx`
- New `electron/src/renderer/components/ui/StateMessage.tsx`
- New `electron/src/renderer/components/ui/FormField.tsx`
- New `electron/src/renderer/components/ui/DialogSurface.tsx`
- New `electron/src/renderer/components/ui/PopoverList.tsx`
- New `electron/src/renderer/components/ui/ShortcutBar.tsx`
- `electron/src/renderer/components/Icon.tsx`
- `electron/src/renderer/components/Keycaps.tsx`
- `electron/src/renderer/components/ModelPicker.tsx`
- `electron/src/renderer/components/SearchableOptionPicker.tsx`
- `electron/src/renderer/components/CommandPalette.tsx`
- `electron/src/renderer/components/ShortcutsHelp.tsx`
- `electron/src/renderer/components/Providers/ConnectionWizard.tsx`
- New or updated `electron/tests/unit/renderer-ui-primitives.test.tsx`

**Approach:**

- Keep primitives presentational and behavior-local. They must not import domain hooks or call IPC.
- `IconButton` owns accessible naming, icon sizing, disabled/loading state, and tooltip behavior for unfamiliar icon-only actions.
- `DialogSurface` composes DaisyUI modal structure with the existing focus trap, Escape behavior, click-through prevention, and z-index ordering.
- `PopoverList` consolidates the shared search/listbox geometry and keyboard semantics used by model and option pickers without forcing command palette behavior into a generic component.
- `StateMessage`, `StatusBadge`, `Panel`, `SectionHeader`, and `FormField` compose standard DaisyUI/Tailwind classes and the shared `orchid-*` composites.
- Add a jsdom/React test harness only if the first primitive needs real DOM focus or keyboard assertions that current source/pure tests cannot cover. Keep the dependency development-only.

**Test scenarios:**

- Icon-only controls expose an accessible name and tooltip while text-bearing controls remain readable.
- Dialog focus enters the first intended control, cycles with Tab, returns on close, and dismisses only under the existing rules.
- Popover/listbox keyboard selection, filtering, empty state, disabled option state, and outside-click behavior match existing pickers.
- Shared field and state components render label, hint, error, loading, empty, and action states without layout shifts.

**Verification:** Run primitive tests, `focus-trap.test.ts`, existing command-palette tests, typecheck, lint, and renderer build.

### U4. Migrate the existing shell, sidebars, and session ownership

**Goal:** Restyle the current shell and sidebar surfaces while preserving the existing layout topology and removing stale session ownership paths exposed by the touched chat/settings components.

**Requirements:** R3, R5, R8, R9, R10, R11, R14, R15, R16.

**Dependencies:** U1, U2, and U3. Shell migration consumes the shared primitives and must land before dependent feature surfaces are finalized.

**Files:**

- `electron/src/renderer/App.tsx`
- `electron/src/renderer/components/ChatView.tsx`
- `electron/src/renderer/components/LeftSidebar.tsx`
- `electron/src/renderer/components/Sidebar.tsx`
- `electron/src/renderer/components/SessionTabBar.tsx`
- `electron/src/renderer/components/SessionNameEditor.tsx`
- `electron/src/renderer/components/session-header.tsx`
- `electron/src/renderer/components/session-activity-section.tsx`
- `electron/src/renderer/components/ContextGrid.tsx`
- `electron/src/renderer/hooks/useSession.ts`
- `electron/src/renderer/components/ConfigView.tsx`
- `electron/tests/integration/chat-sidebar.test.ts`
- `electron/tests/integration/architecture-validation.test.ts`
- `electron/tests/unit/session-workspace-sidebar.test.ts`
- New or updated session ownership regression tests

**Approach:**

- Split ChatView's shell markup from orchestration only as needed for restyling, without moving session generation guards, provider/model/workspace gates, or the keep-previous-paint behavior.
- Preserve the existing shell topology: current left sidebar/session navigation, session tabs, main chat/composer pane, and any existing secondary surfaces remain in their current roles and relative placement.
- Keep the current session sidebar as the browsing surface. Preserve search, project groups, pinned/recent sections, draft sessions, activity badges, bounded previews, keyboard navigation, and create/rename/close/delete actions where they already exist.
- Do not introduce a Focused Workspace redesign, narrow global rail, workspace header redesign, contextual right inspector, workspace switcher redesign, or workspace-manager mode.
- Replace static arbitrary grid values with predefined layout utilities where possible. Keep only state-derived column widths as a CSS custom-property exception with a stable center track that matches current behavior.
- Use `Panel`, `SectionHeader`, `IconButton`, `StatusBadge`, `StateMessage`, DaisyUI `status`, `badge`, `input`, and `btn` classes for sidebars and session rows.
- Preserve collapsed and expanded dimensions, `min-h-0`, overflow boundaries, project grouping, search behavior, active-session pinning, draft tabs, and close confirmation.
- Preserve the existing module-level `useSyncExternalStore` session store as the canonical source consumed by both ChatView and ConfigView. Remove any duplicate local session ownership found during migration and add a regression test proving both consumers observe session/list/workspace updates and generation guards through that shared snapshot.
- Add `aria-expanded` and `aria-controls` to collapsible sidebar sections and audit session row/tab roles so visual extraction does not preserve inaccessible interaction semantics.

**Test scenarios:**

- Selecting, creating, renaming, deleting, or rebinding a session from settings updates the mounted chat view.
- Collapsed and expanded rails retain stable widths and do not cause the main pane to overflow.
- Project groups preserve selection, collapse state, bounded previews, activity badges, search, and keyboard navigation.
- Session tab close confirmation, draft tab entry/exit, active-session pinning, and session loading states remain unchanged.
- Sidebar disclosure controls expose correct expanded/collapsed state to assistive technology.
- The existing shell layout remains recognizably unchanged after restyling: sidebars, tabs, chat, and composer keep their current placement and roles.
- At 800x600, current responsive behavior remains usable and restyling does not introduce new overlap or clipping.

**Verification:** Run session/sidebar, architecture, focus, keyboard, and relevant hook tests; then run renderer browser smoke at 1440x900, 1200x800, and 800x600 for the existing default shell states.

### U5. Migrate flat chat, activity states, and Markdown presentation

**Goal:** Restyle chat content around flat message rows and DaisyUI surrounding states while preserving streaming, grouping, scroll, markdown, and tool behavior.

**Requirements:** R3, R4, R8, R9, R10, R11.

**Dependencies:** U1, U2, and U3; follow U4 shell/session integration before finalizing chat-shell consumers.

**Files:**

- `electron/src/renderer/components/ChatStream.tsx`
- `electron/src/renderer/components/MessageWidget.tsx`
- `electron/src/renderer/components/ToolActivityGroup.tsx`
- `electron/src/renderer/components/ToolCallBlock.tsx`
- `electron/src/renderer/components/CollapsedChainStub.tsx`
- `electron/src/renderer/components/ChainFooter.tsx`
- `electron/src/renderer/components/ErrorBanner.tsx`
- `electron/src/renderer/components/ToolWidgets/LiveCommandInline.tsx`
- `electron/src/renderer/components/MarkdownContent.tsx`
- `electron/src/renderer/components/ContextGrid.tsx`
- `electron/src/renderer/hooks/useChat.ts`
- `electron/src/renderer/styles/markdown.css`
- `electron/src/renderer/styles/exceptions.css`
- `electron/tests/integration/architecture-validation.test.ts`
- `electron/tests/integration/chat-sidebar.test.ts`
- `electron/tests/unit/thought-grouping.test.ts`
- `electron/tests/unit/tool-grouping.test.ts`
- `electron/tests/unit/context-grid.test.ts`
- New or updated chat rendering contract tests

**Approach:**

- Keep `.msg`, `.msg-user`, and `.msg-assistant` behavior as flat message presentation, but move stable geometry and semantic color choices to namespaced composites and DaisyUI tokens.
- Use DaisyUI `collapse` for thought/tool disclosure, `alert` for error and warning states, `badge`/`status` for state labels, and `loading` for active streaming indicators.
- Keep Markdown element selectors and highlight token selectors in `markdown.css`; preserve GFM, syntax highlighting, safe links, no raw HTML, table/list/task-list behavior, and code block overflow.
- Preserve the committed-history/live-tail memoization boundary and chain grouping. Do not introduce a broad message-list wrapper that forces committed history to rerender on every token.
- Preserve the auto-scroll threshold and fix only touched stream defects: no forced scroll while the user is away from the bottom, buffered-tail handling when the live state is null, send failure cleanup, and the streaming cursor behavior.
- Keep dynamic context colors, usage fractions, and grid counts as data-driven styles with the approved exception treatment.

**Test scenarios:**

- User, assistant, system, thinking, tool-call, tool-result, error, interrupted, and empty states render with the expected flat structure.
- Thought and tool groups fold and expand at the same thresholds and preserve their settled/live states.
- Markdown renders links safely, keeps code tokens readable in every theme, and does not render raw HTML.
- Auto-scroll respects the exact threshold contract and does not yank a user who is reading older content.
- A send/stream failure removes or reconciles optimistic state and leaves the composer usable.

**Verification:** Run all grouping, context, architecture, chat/sidebar, and chat hook tests. Validate streaming, tool activity, markdown, and scroll behavior in the browser with a long response fixture or live development session.

### U6. Migrate composer, footer, pickers, and command interactions

**Goal:** Standardize the high-frequency input and discovery controls and fix touched composer/command interaction failures.

**Requirements:** R2, R3, R5, R8, R9, R10, R11.

**Dependencies:** U1 through U5. Composer and discovery controls depend on the shared primitives and the settled shell/chat layout.

**Files:**

- `electron/src/renderer/components/InputArea.tsx`
- `electron/src/renderer/components/Footer.tsx`
- `electron/src/renderer/components/ModelPicker.tsx`
- `electron/src/renderer/components/CommandPalette.tsx`
- `electron/src/renderer/components/SlashCommandMenu.tsx`
- `electron/src/renderer/components/ShortcutsHelp.tsx`
- `electron/src/renderer/components/Keycaps.tsx`
- `electron/src/renderer/hooks/useChat.ts`
- `electron/src/renderer/styles/exceptions.css`
- `electron/tests/integration/chat-sidebar.test.ts`
- `electron/tests/unit/use-chat-affinity.test.ts`
- `electron/tests/unit/keyboard-registry.test.ts`
- `electron/tests/unit/focus-trap.test.ts`
- Existing command-palette tests and new composer contract tests

**Approach:**

- Use DaisyUI `textarea`, `btn`, `dropdown`, `input`, `badge`, `loading`, `radial-progress`, and `kbd` classes with standard Tailwind layout utilities.
- Keep textarea auto-resize as a runtime height exception; static composer layout, controls, and states use predefined classes.
- Use shared picker and icon-button primitives while retaining typed provider/model selection and outside-click/focus behavior.
- Replace arbitrary palette positioning, width, radius, text, and row-gap values with predefined utilities or the named dialog/popover composites. Keep only dynamic theme swatches and viewport offsets as exceptions.
- Fix the send lock so every early gate and failure path releases it. Serialize staged Escape/cancel transitions so repeated Escape cannot overlap phases.
- Remove or wire the dead command-palette navigation event when the palette is touched; preserve commands that intentionally dispatch product events.
- Preserve Enter, Shift+Enter, Cmd/Ctrl+S, slash-command bypass, send/cancel labels, loading states, model labels, usage indicators, and shortcut hints.

**Test scenarios:**

- Enter sends, Shift+Enter inserts a newline, and Cmd/Ctrl+S follows the existing command contract.
- Workspace/provider/model gates return without leaving the send control locked.
- Failed send and cancel operations restore the correct composer state and allow a subsequent send.
- Command palette search, keyboard selection, theme swatches, command events, Escape, and close behavior remain correct.
- Model picker filtering, unavailable models, selected model, alignment, and placement remain correct.
- Footer usage, context, elapsed time, interruption, and shortcut indicators do not shift surrounding controls.

**Verification:** Run keyboard, focus-trap, command-palette, chat-affinity, composer, and existing integration tests; validate keyboard-only use in browser smoke.

### U7. Migrate configuration, providers, and onboarding surfaces

**Goal:** Standardize settings and first-run flows with DaisyUI forms and shared state surfaces while fixing correctness issues in touched preference and dialog components.

**Requirements:** R3, R5, R7, R8, R9, R10, R11.

**Dependencies:** U1 through U6. Settings, provider, and onboarding surfaces consume the canonical layers, overlays, and command/picker contracts.

**Files:**

- `electron/src/renderer/components/ConfigView.tsx`
- `electron/src/renderer/components/Preferences/AgentsTab.tsx`
- `electron/src/renderer/components/Preferences/DefinitionActions.tsx`
- `electron/src/renderer/components/Preferences/GeneralTab.tsx`
- `electron/src/renderer/components/Preferences/MCPServersTab.tsx`
- `electron/src/renderer/components/Preferences/ModelAssignments.tsx`
- `electron/src/renderer/components/Preferences/MultiSelectList.tsx`
- `electron/src/renderer/components/Preferences/PersonalitiesTab.tsx`
- `electron/src/renderer/components/Preferences/ProvidersTab.tsx`
- `electron/src/renderer/components/Preferences/RAGTab.tsx`
- `electron/src/renderer/components/Preferences/ScopeToggle.tsx`
- `electron/src/renderer/components/Preferences/SkillsTab.tsx`
- `electron/src/renderer/components/Preferences/TierModelsTab.tsx`
- `electron/src/renderer/components/Preferences/TierPicker.tsx`
- `electron/src/renderer/components/Providers/ConnectionList.tsx`
- `electron/src/renderer/components/Providers/ConnectionModelsDialog.tsx`
- `electron/src/renderer/components/Providers/ConnectionWizard.tsx`
- `electron/src/renderer/components/Providers/ProviderStatus.tsx`
- `electron/src/renderer/components/Onboarding/OnboardingScreen.tsx`
- `electron/tests/integration/preferences-onboarding.test.ts`
- `electron/tests/integration/provider-onboarding.test.ts`
- New or updated configuration form contract tests

**Approach:**

- Use DaisyUI `tabs`, `fieldset`, `label`, `input`, `select`, `textarea`, `checkbox`, `toggle`, `card`, `alert`, `badge`, `modal`, `steps`, and `loading` classes according to semantics.
- Use `FormField`, `Panel`, `SectionHeader`, `StateMessage`, `DialogSurface`, `StatusBadge`, and `PopoverList` to remove repeated form and state markup without merging unrelated tab state.
- Keep ConfigView's dirty/save, error, diagnostic, restart-required, and close-confirmation flows. Add dialog semantics and focus handling where the current overlay lacks them.
- Preserve onboarding step order, provider detection, model assignment, RAG setup, MCP selection, skip/complete persistence, and provider wizard capabilities.
- When touched, allow valid zero values in `GeneralTab` and `RAGTab`, type the configuration draft boundary instead of relying on broad casts, and preserve the existing model/provider selection contracts.
- Remove arbitrary form spacing, sizes, and card geometry in favor of predefined utilities or shared composites; keep only browser/focus exceptions in the exception layer.

**Test scenarios:**

- Every configuration tab renders loading, empty, warning, error, dirty, saving, and saved states with stable controls.
- Zero is accepted and persisted for valid numeric fields.
- Unsaved changes prompt offers save, discard, and cancel with correct focus and close behavior.
- MCP changes trigger restart handling; ordinary settings changes do not.
- Provider connection, model capability, status, and credential error states remain legible and actionable.
- Onboarding can skip, complete, add providers, select models, configure RAG/MCP, and persist theme/personality settings.

**Verification:** Run preferences/onboarding, provider onboarding, focus-trap, provider view-model, provider status, configuration, and model-selection tests; build and browser-test settings at narrow and wide widths.

### U8. Remove legacy styling, complete accessibility and touched-flow fixes, and verify the whole renderer

**Goal:** Finish the migration, remove dead styling and temporary bridges, and prove consistency, behavior, themes, and maintainability across the renderer.

**Requirements:** R1, R2, R7, R9, R10, R11, R12, R13, R14.

**Dependencies:** U1 through U7. Cleanup and final verification begin only after all migration consumers have moved.

**Files:**

- `electron/src/renderer/styles/index.css`
- `electron/src/renderer/styles/components.css`
- `electron/src/renderer/styles/markdown.css`
- `electron/src/renderer/styles/exceptions.css`
- `electron/src/renderer/styles/chat.css`
- `electron/src/renderer/styles/README.md`
- All migrated renderer components and hooks with unused imports/classes
- `electron/tests/integration/app-shell.test.ts`
- `electron/tests/integration/architecture-validation.test.ts`
- `electron/tests/integration/chat-sidebar.test.ts`
- `electron/tests/integration/preferences-onboarding.test.ts`
- `electron/tests/integration/provider-onboarding.test.ts`
- `electron/tests/unit/**/*.test.ts`

**Approach:**

- Delete unused legacy selectors and remove the compatibility aggregator only after source tests and imports no longer depend on it.
- Run the style-contract audit over all renderer class strings and custom CSS. Every remaining bracket utility, inline presentation style, raw color, reserved selector override, or exception must be justified by the exception registry.
- Remove dead class names from JSX and dead imports/components created by the migration. Do not leave parallel old/new implementations.
- Complete the touched-flow correctness list that was exposed by migrated surfaces: unified session ownership, composer lock/cancel recovery, stream failure/scroll reconciliation, valid zero preference values, and command-palette event wiring.
- Audit `aria-expanded`/`aria-controls`, dialog roles, accessible names, keyboard focus, disabled state, tooltip use, and semantic HTML across shared primitives and feature consumers.
- Run browser smoke for all five themes and representative state combinations. Capture screenshots for review at wide desktop, standard desktop, and constrained desktop widths.
- Confirm the shell layout remains the existing topology; reject diffs that introduce Focused Workspace or other layout redesign work.
- Document the final styling contract and approved exceptions in `styles/README.md`, including one example for adding a DaisyUI component, a Tailwind utility, an `orchid-*` composite, and a dynamic exception.

**Test scenarios:**

- No unowned class or selector remains after the CSS split.
- All five themes render shell, chat, sidebars, composer, settings, onboarding, dialogs, pickers, loading, empty, warning, error, and streaming states.
- No text, icon, control, or panel overlaps at the chosen viewports.
- Keyboard-only navigation reaches and exits every touched overlay and control correctly.
- Existing test suites pass without relying on the removed stylesheet or obsolete selectors.
- A new component can follow the documented class decision order without adding an arbitrary utility or a reserved DaisyUI selector override.
- The existing interface layout and navigation ownership remain intact after cleanup.

**Verification:** Run the complete Verification Contract and review the final diff for dead code, unrelated changes, layout redesign, and unexplained exceptions.

## Verification Contract

### Required Commands

Run from `electron/` unless a command is shown with a different working directory:

```bash
npm run typecheck
npm run lint
npm run build:renderer
npm test
npm run build
```

Run targeted tests during each unit rather than waiting for the full suite:

```bash
npm test -- tests/integration/app-shell.test.ts tests/integration/chat-sidebar.test.ts
npm test -- tests/integration/architecture-validation.test.ts tests/integration/preferences-onboarding.test.ts tests/integration/provider-onboarding.test.ts
npm test -- tests/unit/focus-trap.test.ts tests/unit/keyboard-registry.test.ts tests/unit/thought-grouping.test.ts tests/unit/tool-grouping.test.ts tests/unit/context-grid.test.ts tests/unit/session-workspace-sidebar.test.ts tests/unit/use-chat-affinity.test.ts
```

If a renderer DOM harness is added, run its targeted `.test.tsx` files explicitly and keep the default Vitest environment unchanged for existing Node tests.

### Static Contract Gates

- The renderer style-contract test reports zero unapproved arbitrary utility tokens in static `className` values after U8; during U1-U7, every known legacy violation is explicit in the baseline/exception registry and newly introduced violations fail.
- The renderer style-contract test reports zero custom definitions of reserved DaisyUI component selectors after U8; temporary compatibility selectors are limited to the documented bridge and are removed or reduced before completion.
- New CSS composites are namespaced, use `@layer components`, and compile through the Tailwind/DaisyUI pipeline.
- Feature CSS uses semantic DaisyUI tokens rather than raw palette declarations.
- Remaining inline styles are limited to the approved runtime data exceptions and are documented.
- `chat.css` has no active legacy selector without a consumer or explicit compatibility purpose.
- Diff review confirms no Focused Workspace or other shell-layout redesign was introduced.

### Behavioral Gates

- Theme switching and persistence work for all five themes.
- Session selection, draft state, session tabs, project grouping, and settings navigation share one coherent session source.
- Existing shell layout, sidebar placement, session navigation structure, and chat/composer arrangement remain intact after restyling.
- Chat stream ordering, hidden-message filtering, tool pairing, grouping, markdown safety, interruption, and auto-scroll preserve their existing contracts.
- Composer keyboard behavior, send gates, failure recovery, cancellation, slash commands, model selection, and command palette behavior remain usable.
- Configuration, provider, RAG, MCP, onboarding, and unsaved-change flows preserve their existing persistence and error behavior.
- Focus traps, dialog dismissal, disclosure semantics, accessible names, tooltips, and keyboard-only navigation pass for touched controls.

### Browser And Visual Gates

Start the renderer using `npm run dev:renderer` or the full Electron development command, depending on the available browser workflow. Validate at minimum:

- Viewports: 1440x900 wide desktop, 1200x800 standard desktop, and 800x600 constrained/minimum desktop.
- Themes: `default`, `solarized-light`, `bluey`, `windows-xp`, and `green-terminal`.
- Shell states: existing default shell, collapsed/expanded sidebars as currently supported, no active session, active session, workspace unbound, and session activity present.
- Chat states: empty, user/assistant messages, streaming, thinking, tool activity, error, interrupted, long Markdown, long code, and user-scrolled-away.
- Controls: composer, model picker, slash menu, command palette, shortcuts help, session tabs, project groups, dialogs, settings tabs, provider wizard, and onboarding.
- Quality: no overlap, clipped text, unexpected scrollbar, broken focus ring, unreadable semantic state, layout shift, or theme-specific contrast failure.
- Layout parity: panel placement and navigation ownership match the pre-migration shell; changes are presentation polish, not a new topology.

### Regression Evidence

The implementation should record in the pull request or change summary:

- Which style layers replaced which legacy sections.
- Which approved exceptions remain and why.
- Which touched-flow correctness issues were fixed.
- Confirmation that interface layout topology was preserved.
- The commands run and their results.
- The theme/viewport/state browser matrix reviewed.
- Any deferred visual, layout, or theme migration decision.

## Definition of Done

### Global

- [ ] The renderer follows the documented DaisyUI/Tailwind class selection order.
- [ ] Static arbitrary values are removed or approved and documented.
- [ ] Custom CSS is namespaced, layered, token-based, and limited to reusable composites or approved exceptions.
- [ ] The five existing themes remain functional and visually coherent.
- [ ] The existing interface layout and information architecture are preserved; no Focused Workspace or other shell redesign is introduced.
- [ ] Current session/sidebar information and actions remain available in their existing structure and interaction model.
- [ ] Flat chat presentation is preserved and DaisyUI is used for surrounding states.
- [ ] Shared primitives are typed, behavior-local, reused by at least the intended consumers, and free of domain-hook imports.
- [ ] Touched-flow correctness, accessibility, and keyboard regressions are fixed and tested.
- [ ] Legacy CSS and unused classes are removed; no abandoned parallel implementation remains.
- [ ] `npm run typecheck`, `npm run lint`, `npm run build:renderer`, `npm test`, and `npm run build` pass.
- [ ] Browser/theme/viewport smoke validation is complete with no unresolved overlap, contrast, focus, or overflow defects.
- [ ] The final diff contains no unrelated backend, preload, shared, or generated changes.
- [ ] The final code contains no abandoned experimental components, styles, tests, or imports.

### Per Unit

- U1 is complete when the contract, exception registry, baseline inventory, and static gates exist and pass.
- U2 is complete when the canonical CSS layer structure compiles, theme switching remains intact, and reserved DaisyUI selectors are no longer redefined.
- U3 is complete when shared primitives cover repeated behavior without importing domain state and their interaction contracts are tested.
- U4 is complete when the existing shell and sidebars are restyled in place, current session/sidebar behavior remains available, session ownership is unified where needed, and disclosure/accessibility contracts are covered without a layout redesign.
- U5 is complete when flat chat, stream memoization, grouping, Markdown, tool states, and auto-scroll behavior are preserved and tested.
- U6 is complete when composer, footer, picker, palette, keyboard, and touched send/cancel behavior are standardized and tested.
- U7 is complete when settings, providers, onboarding, dialogs, form states, and touched preference correctness behavior are standardized and tested.
- U8 is complete when legacy CSS is removed, all exceptions are documented, layout topology is confirmed preserved, full verification passes, and browser/theme review finds no unresolved defect.
