# Renderer styling contract

Maintainer-facing contract for Orchid’s Electron renderer UI. Class selection, approved exceptions, reserved DaisyUI selectors, theme requirements, and **layout preservation** are frozen so UI work stays consistent without redesigning the product shell.

Related tests: `electron/tests/integration/renderer-style-contract.test.ts`.

## Layout preservation (non-negotiable)

Restyle **in place** only. Do **not**:

- Introduce Focused Workspace, a narrow global rail, workspace header redesign, or contextual right inspector
- Replace sidebars with drawer/overlay navigation patterns
- Redesign session tabs, chat/composer center, settings, or onboarding information architecture
- Change expand/collapse ownership or panel topology to make styling easier

Existing shell topology (left session navigation, session tabs, main chat/composer, right/context surfaces if present, overlays) stays as implemented in `App.tsx`, `ChatView.tsx`, `LeftSidebar.tsx`, `Sidebar.tsx`, and `SessionTabBar.tsx`. Only classes, shared primitives, tokens, and presentation implementation move.

## Class selection order

1. **Typed React primitive** under `components/ui/` when the element matches a recognized control or surface — `Button`, `IconButton`, `TextInput`, `Select`, `Checkbox`, `Alert`, `Spinner`, `StatusBadge`, `Panel`, `Tabs`, `ConfigCard`, `DropdownMenu`, `DialogSurface`, etc. The primitive owns the DaisyUI classes internally; feature JSX never names DaisyUI roots directly.
2. **`orchid-*` CSS composite** when the same utility/state set is shared by multiple features or encodes a product-specific surface contract. Define under `@layer components` with `@apply` and semantic tokens.
3. **Predefined Tailwind utilities** for layout and composition: `flex`, `grid`, `min-h-0`, `gap-2`, `p-3`, `text-sm`, `w-64`, responsive variants, etc.
4. **Custom declarations** only for a documented exception or a CSS feature that cannot be expressed above.

DaisyUI acts as the **styling engine** — its classes are used internally by `components/ui/` primitives and may also appear in approved scoped overrides in `components.css`. Feature JSX (anything outside `components/ui/`) must not name DaisyUI component roots (`btn`, `input`, `select`, `alert`, `badge`, `card`, `tabs`, `modal`, etc.) directly in `className` strings.

Do **not** use DaisyUI `chat` / `chat-bubble` for message bodies (flat chat presentation).

## Ownership matrix

| Need | Owner | DaisyUI classes used? |
| --- | --- | --- |
| Recognizable control/state | Typed React primitive under `components/ui/` | Yes — internally only |
| One-off static geometry | Tailwind utilities in JSX | No |
| Repeated product geometry/state | `orchid-*` composite in `components.css` | `@apply` only (not in JSX) |
| Repeated interaction semantics | Typed React primitive under `components/ui/` | Yes — internally only |
| Runtime-only value | Inline style or CSS variable at the narrowest boundary | No |

### Primitive ownership

| DaisyUI root(s) | Owner primitive |
| --- | --- |
| `btn` / `btn-*` | `Button.tsx`, `IconButton.tsx` |
| `input` / `input-*` | `TextInput.tsx` |
| `select` / `select-*` | `Select.tsx` |
| `checkbox` / `checkbox-*` | `Checkbox.tsx` |
| `alert` / `alert-*` | `Alert.tsx` |
| `badge` / `badge-*` / `status` | `StatusBadge.tsx` |
| `loading` / `loading-*` | `Spinner.tsx` |
| `tabs` / `tab` / `tab-*` | `Tabs.tsx` |
| `card` / `card-*` + `config-card` | `ConfigCard.tsx` |
| `dropdown` / `dropdown-*` | `DropdownMenu.tsx`, `PopoverList.tsx` |
| `modal` / `modal-*` | `DialogSurface.tsx` |
| Panel surfaces | `Panel.tsx`, `SectionHeader.tsx` |
| Form rows | `FormField.tsx` |

### Deferred roots (baseline-tracked)

These DaisyUI roots still appear in feature JSX and are tracked by the drift scanner's baseline. They will be removed as follow-up primitives are built: `textarea` (deferred per composer-contract.test.ts), `label`, `list`, `join`, `step`/`steps`, `status` (on non-StatusBadge elements), `progress`/`radial-progress`, `table`, `modal`/`modal-action`, `footer`, `dropdown`, and `btn-square` on `IconButton` (used for shape detection).

## Required rules

- **Feature JSX must not name DaisyUI component roots** (`btn`, `input`, `select`, `alert`, `badge`, `card`, `tabs`, `modal`, `loading`, `checkbox`, `dropdown`, etc.) directly in `className` strings. Use a primitive from `components/ui/` instead. DaisyUI classes are allowed only inside `components/ui/` primitives and in `components.css` `@apply` rules.
- Prefer DaisyUI semantic colors (`base-100`, `primary`, `error`, …) over ad-hoc palette values in new markup.
- Prefer standard spacing, text, and radius scales over arbitrary values (`text-[10px]`, `z-[1000]`, `rounded-[5px]`).
- **Do not introduce raw non-token colors** (`oklch(...)`, `#hex`, `rgb(...)`, `hsl(...)`) in `styles/*.css` or feature `className` strings. Only `index.css` `:root` fallback tokens and `themes/*.css` may use raw color values.
- Keep dynamic values (grid tracks, textarea height, swatches, progress) as data via CSS variables or inline styles — not static utility classes.
- Namespace new composites with `orchid-`. Define them in `components.css` `@layer components` using `@apply` + semantic tokens.
- **`chat.css` is frozen**: do not add new rules or grow its line count. All product CSS has been migrated to `components.css` and `markdown.css`; `chat.css` is now header-only. Any new selector belongs in `components.css` `@layer components`.
- Do not redefine reserved DaisyUI selectors in feature CSS (see below).
- Do not add CSS Modules or a second styling library for this migration.

## Reserved DaisyUI selectors

Do not introduce top-level custom rules whose subject is a DaisyUI component class (or its common modifiers such as `btn-primary`, `btn-ghost`). Reserved roots include:

`btn`, `input`, `select`, `textarea`, `alert`, `badge`, `status`, `loading`, `collapse`, `modal`, `tabs`, `tab`, `steps`, `step`, `dropdown`, `table`, `fieldset`, `card`, `kbd`, `tooltip`, `menu`, `checkbox`, `radio`, `toggle`, `range`, `progress`, `link`, `divider`, `avatar`, `navbar`, `drawer`, `hero`, `footer`, `stat`, `toast`, `file-input`, `label`, `join`, `mask`, `stack`, `skeleton`, `indicator`, `list`, `dock`, `fab`, `validator`

Product-specific names that only *start* like a DaisyUI root but are not DaisyUI (for example `.input-area`) are allowed when they are not the reserved class itself.

**U8 gate:** zero top-level reserved DaisyUI redefinitions in feature CSS. Scoped overrides (e.g. `.provider-connection-wizard .modal-box`) are allowed when they only adjust a product surface.

## Approved exception paths

| Exception | Allowed location | Treatment |
| --- | --- | --- |
| Theme variables / `color-scheme` | `themes/*.css` | DaisyUI `--color-*` plus app-specific variables still consumed by the renderer |
| Markdown / syntax highlighting | `styles/markdown.css` | Nested element/token selectors; semantic theme variables |
| Scrollbars | `styles/exceptions.css` | Browser-specific selectors; theme variables only |
| Animations / streaming cursor | `styles/exceptions.css` | Keyframes and pseudo-elements when utilities cannot express behavior |
| Runtime layout dimensions | `ChatView.tsx` + `styles/exceptions.css` `.app-frame` | Set `--orchid-shell-left` / `--orchid-shell-right` from collapse state; center track stays `minmax(460px, 1fr)`; preserve grid/panel topology |
| Runtime textarea height | `InputArea.tsx` + `.orchid-composer-textarea` in exceptions | Keep resize behavior; do not encode generated pixel heights as static utilities |
| Runtime swatches / progress | `ContextGrid.tsx`, `Footer.tsx`, `CommandPalette.tsx` | Dynamic colors/fractions as data; classes for surrounding geometry |
| Focus / modal browser quirks | focused exception selectors | Only after smoke proves utilities/DaisyUI insufficient |
| Residual product CSS | `styles/chat.css` (header-only) | All shell/onboarding/config/picker/session selectors have been migrated to `components.css`; `chat.css` is empty and frozen |

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

Static `className` strings in those files still must not introduce arbitrary utilities outside the approved list (currently empty).

### Approved static arbitrary utilities

**None.** After U8, static `className` strings must use predefined Tailwind utilities only. Prefer `text-xs`, `z-50`, `rounded-md`, `gap-px`, `max-h-96`, `max-w-xl`, etc. If exact geometry is behavior-critical, use an `orchid-*` composite or a dynamic CSS variable exception.

## Themes

These five themes must remain selectable, loadable, and coherent via the existing runtime stylesheet swap (`applyTheme()` / `data-theme`):

- `default`
- `solarized-light`
- `bluey`
- `windows-xp`
- `green-terminal`

Do not replace the runtime theme loader with compile-time-only DaisyUI theme blocks in this migration’s first pass.

## Stylesheet layout

| File | Role |
| --- | --- |
| `index.css` | **Canonical entry** (imported from `main.tsx`): Tailwind, DaisyUI plugin, document/root rules, layer imports |
| `components.css` | `@layer components` `orchid-*` composites with `@apply` + semantic/theme tokens (single-name; no legacy dual aliases) |
| `markdown.css` | Markdown / GFM / highlight tokens |
| `exceptions.css` | Scrollbars, keyframes, streaming cursor, shell grid tracks, composer height hooks |
| `chat.css` | Header-only (no CSS rules); frozen — residual bridge comment only |
| `README.md` | This contract |

### Import graph

```text
main.tsx
  └── styles/index.css
        ├── tailwindcss + daisyui plugin
        ├── components.css
        ├── markdown.css
        ├── exceptions.css
        └── chat.css          ← residual bridge only
```

Runtime themes are **not** part of this graph: `applyTheme()` swaps a single `#orchid-theme` stylesheet link (`themes/*.css`) and sets `document.documentElement.dataset.theme`.

### Residual bridge (`chat.css`)

- Dead pre-migration legacy blocks (old `.message-*`, `.app-layout`, `.sidebar-*`, `.footer` layout) were removed in U8; further residual prunes removed unused `composer-model-*`, most `onb-*` step subtrees, `thought-activity-group`, dead palette/config/tier-picker subparts, and dual-owned palette/chat-scroll rules with no remaining legacy class consumers.
- Dual-class aliases (`legacy` + `orchid-*` on the same rule) were collapsed: JSX and CSS use `orchid-*` only for migrated surfaces; legacy dual selectors were dropped from `components.css` and retargeted/removed in the bridge.
- All previous rules were migrated; `chat.css` is now header-only (comment block only, no CSS rules).
- The unused `components/ui/index.ts` barrel was deleted; import UI primitives from their module paths.
- **Do not add new rules** to `chat.css`. New composites → `components.css`; markdown → `markdown.css`; browser exceptions → `exceptions.css`.

### Known reserved redefinitions

**None** after U8. Product lists use plain lists / PopoverList / custom menus rather than DaisyUI `menu`. Buttons are DaisyUI `btn` in JSX, not custom `.btn` CSS.

## Arbitrary utilities

Static class strings (from `className` / `class` attributes and class-like string/template literals inside those attributes) must not introduce Tailwind arbitrary values (tokens matching `utility-[...]`, including variants like `sm:grid-cols-[...]`).

- **Approved**: intentional long-lived exceptions go in `APPROVED_ARBITRARY_UTILITIES` (currently empty) and must be documented here.
- **Not scanned**: TypeScript arrays, generics, indexed access (`tierModels[tier.id]`), and `${...}` interiors of class templates — the scanner is class-bearing only.

## How to add UI safely

### Example 1 — Typed primitive (preferred)

```tsx
import { Button } from '../ui/Button';

<Button variant="primary" size="sm">Save</Button>
```

DaisyUI classes live inside the primitive. Feature JSX never names `btn` directly.

### Example 2 — Tailwind utilities (one-off layout)

```tsx
<div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
  <p className="truncate text-sm text-base-content/70">{label}</p>
</div>
```

### Example 3 — `orchid-*` composite (repeated product surface)

In `components.css`:

```css
@layer components {
  .orchid-chat-footer {
    @apply flex shrink-0 items-center justify-between gap-2.5 border-t border-base-content/10 px-3 py-1 text-xs;
  }
}
```

In JSX: `className="orchid-chat-footer"` (single orchid name; do not reintroduce legacy dual aliases).

### Example 4 — Dynamic exception

```tsx
<div
  className="app-frame"
  style={{
    ['--orchid-shell-left' as string]: leftCollapsed ? '56px' : '260px',
    ['--orchid-shell-right' as string]: rightCollapsed ? '48px' : '300px',
  }}
/>
```

Document the path under **Approved dynamic style components** and keep static geometry in classes.

### Checklist

1. Prefer a typed primitive from `components/ui/` in feature JSX. If a matching primitive doesn't exist, create one.
2. Use predefined Tailwind utilities for layout only. Never name DaisyUI roots directly in feature JSX.
3. If the same pattern appears twice (or encodes shared behavior), extract an `orchid-*` composite or a new primitive.
4. If you need a dynamic pixel/color/fraction, put it in an approved exception path as a CSS variable or inline style.
5. Run `npm test -- tests/integration/renderer-style-contract.test.ts` from `electron/`.
6. Never “fix” styling by redesigning shell layout.
