# Renderer styling contract

Maintainer-facing contract for Orchid’s Electron renderer UI. It freezes class-selection rules, approved exceptions, reserved DaisyUI selectors, theme requirements, and **layout preservation** so migrations can remove arbitrary utilities and legacy CSS without redesigning the product shell.

Related tests: `electron/tests/integration/renderer-style-contract.test.ts`.

## Layout preservation (non-negotiable)

Restyle **in place** only. Do **not**:

- Introduce Focused Workspace, a narrow global rail, workspace header redesign, or contextual right inspector
- Replace sidebars with drawer/overlay navigation patterns
- Redesign session tabs, chat/composer center, settings, or onboarding information architecture
- Change expand/collapse ownership or panel topology to make styling easier

Existing shell topology (left session navigation, session tabs, main chat/composer, right/context surfaces if present, overlays) stays as implemented in `App.tsx`, `ChatView.tsx`, `LeftSidebar.tsx`, `Sidebar.tsx`, and `SessionTabBar.tsx`. Only classes, shared primitives, tokens, and presentation implementation move.

## Class selection order

1. **DaisyUI component class** when the element has a matching semantic: `btn`, `input`, `select`, `textarea`, `alert`, `badge`, `status`, `loading`, `collapse`, `modal`, `tabs`, `steps`, `dropdown`, `table`, `fieldset`, `card`, `kbd`, `tooltip`, and related DaisyUI primitives.
2. **Predefined Tailwind utilities** for layout and composition: `flex`, `grid`, `min-h-0`, `gap-2`, `p-3`, `text-sm`, `w-64`, responsive variants, etc.
3. **`orchid-*` CSS composite** when the same utility/state set is shared by multiple features or encodes a product-specific surface contract. Define under `@layer components` with `@apply` and semantic tokens.
4. **Custom declarations** only for a documented exception or a CSS feature that cannot be expressed above.

Do **not** use DaisyUI `chat` / `chat-bubble` for message bodies (flat chat presentation).

## Ownership matrix (short)

| Need | Owner |
| --- | --- |
| Recognizable control/state | DaisyUI classes in JSX |
| One-off static geometry | Tailwind utilities in JSX |
| Repeated product geometry/state | `orchid-*` composite |
| Repeated interaction semantics | Typed React primitive under `components/ui/` |
| Runtime-only value | Inline style or CSS variable at the narrowest boundary |

## Required rules

- Prefer DaisyUI semantic colors (`base-100`, `primary`, `error`, …) over ad-hoc palette values in new markup.
- Prefer standard spacing, text, and radius scales over arbitrary values (`text-[10px]`, `z-[1000]`, `rounded-[5px]`).
- Keep dynamic values (grid tracks, textarea height, swatches, progress) as data via CSS variables or inline styles — not static utility classes.
- Namespace new composites with `orchid-`. Temporary legacy selectors live only in the compatibility bridge while consumers migrate.
- Do not redefine reserved DaisyUI selectors in feature CSS (see below).
- Do not add CSS Modules or a second styling library for this migration.

## Reserved DaisyUI selectors

Do not introduce top-level custom rules whose subject is a DaisyUI component class (or its common modifiers such as `btn-primary`, `btn-ghost`). Reserved roots include:

`btn`, `input`, `select`, `textarea`, `alert`, `badge`, `status`, `loading`, `collapse`, `modal`, `tabs`, `tab`, `steps`, `step`, `dropdown`, `table`, `fieldset`, `card`, `kbd`, `tooltip`, `menu`, `checkbox`, `radio`, `toggle`, `range`, `progress`, `link`, `divider`, `avatar`, `navbar`, `drawer`, `hero`, `footer`, `stat`, `toast`, `file-input`, `label`, `join`, `mask`, `stack`, `skeleton`, `indicator`, `list`, `dock`, `fab`, `validator`

Product-specific names that only *start* like a DaisyUI root but are not DaisyUI (for example `.input-area`) are allowed when they are not the reserved class itself.

During migration, existing top-level redefinitions are recorded as an explicit **baseline** in the style contract test. New redefinitions fail the test. Zero reserved redefinitions is the U8 gate, not U1.

Scoped overrides (e.g. `.composer .input`) are still inventory debt; prefer removing them when those surfaces are migrated rather than adding more.

## Approved exception paths

| Exception | Allowed location | Treatment |
| --- | --- | --- |
| Theme variables / `color-scheme` | `themes/*.css` | DaisyUI `--color-*` plus app-specific variables still consumed by the renderer |
| Markdown / syntax highlighting | `styles/markdown.css` (target) | Nested element/token selectors; semantic theme variables |
| Scrollbars | global exception layer | Browser-specific selectors; theme variables only |
| Animations / streaming cursor | exception layer | Keyframes and pseudo-elements when utilities cannot express behavior |
| Runtime layout dimensions | `ChatView.tsx` (and related shell) | CSS custom properties or inline values from state; preserve grid/panel topology |
| Runtime textarea height | `InputArea.tsx` | Keep resize behavior; do not encode generated pixel heights as static utilities |
| Runtime swatches / progress | `ContextGrid.tsx`, `Footer.tsx`, `CommandPalette.tsx` | Dynamic colors/fractions as data; classes for surrounding geometry |
| Focus / modal browser quirks | focused exception selectors | Only after smoke proves utilities/DaisyUI insufficient |

Every exception needs a short comment or a row in this table explaining why a predefined class cannot replace it.

### Approved dynamic style components

These files may use inline `style={...}` for runtime values without that usage counting as a static class violation:

- `components/ChatView.tsx`
- `components/InputArea.tsx`
- `components/ContextGrid.tsx`
- `components/Footer.tsx`
- `components/CommandPalette.tsx`
- `components/Preferences/ScopeToggle.tsx`
- `components/ToolWidgets/LiveCommandInline.tsx`

Static `className` strings in those files still must not introduce new arbitrary utilities outside baseline/approved lists.

## Themes

These five themes must remain selectable, loadable, and coherent via the existing runtime stylesheet swap (`applyTheme()` / `data-theme`):

- `default`
- `solarized-light`
- `bluey`
- `windows-xp`
- `green-terminal`

Do not replace the runtime theme loader with compile-time-only DaisyUI theme blocks in this migration’s first pass.

## Stylesheet layout (target)

| File | Role |
| --- | --- |
| `index.css` | Canonical entry: Tailwind, DaisyUI plugin, document/root rules |
| `components.css` | `@layer components` `orchid-*` composites with `@apply` |
| `markdown.css` | Markdown / GFM / highlight tokens |
| `exceptions.css` | Scrollbars, keyframes, dynamic hooks, browser quirks |
| `chat.css` | Temporary compatibility aggregator until U8 |
| `README.md` | This contract |

Until layers are split (U2+), `index.css` + `chat.css` remain the live surface. Do not delete legacy selectors without updating consumer inventory and source-structure tests.

## Arbitrary utilities

Static class strings (from `className` / `class` attributes and class-like string/template literals inside those attributes) must not introduce new Tailwind arbitrary values (tokens matching `utility-[...]`, including variants like `sm:grid-cols-[...]`).

- **Baseline**: pre-migration hits are listed in `BASELINE_ARBITRARY_UTILITIES` in the contract test. Shrink this set as surfaces migrate.
- **Approved**: intentional long-lived exceptions go in `APPROVED_ARBITRARY_UTILITIES` and should be documented here.
- **Not scanned**: TypeScript arrays, generics, indexed access (`tierModels[tier.id]`), and `${...}` interiors of class templates — the scanner is class-bearing only.

Prefer nearest predefined utilities (`text-xs`, `z-50`, `rounded-md`, `gap-px`, `max-h-96`, …). If exact geometry is behavior-critical, use an `orchid-*` composite or a dynamic CSS variable exception.

## Migration posture

1. **U1**: contract test + this README + baseline inventory (no mass CSS rewrite required).
2. **U2–U7**: migrate layers and features; baseline may only shrink or move entries to approved exceptions with justification.
3. **U8**: zero arbitrary utilities outside approved exceptions; zero top-level reserved DaisyUI redefinitions; remove or reduce `chat.css` compatibility bridge; full theme smoke matrix.

## How to add UI safely

1. Prefer DaisyUI + predefined Tailwind in the feature JSX.
2. If the same pattern appears twice (or encodes shared behavior), extract a small primitive or `orchid-*` composite.
3. If you need a dynamic pixel/color/fraction, put it in an approved exception path as a CSS variable or inline style.
4. Run `npm test -- tests/integration/renderer-style-contract.test.ts` from `electron/` before expanding the migration.
5. Never “fix” styling by redesigning shell layout.
